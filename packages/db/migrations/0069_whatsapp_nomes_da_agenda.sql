-- Nomes do WhatsApp como no WhatsApp Web (18/11/2026).
--
-- 1. "Nome" que é só o número não é nome: a Evolution põe o número no lugar do nome
--    quando não sabe, e o Omni guardava; como as atualizações só preenchiam conversas
--    sem nome, o nome da agenda nunca entrava. Esses "nomes" são limpos (a tela mostra
--    o telefone formatado) e não entram mais.
-- 2. O nome da agenda do celular (lista de contatos da Evolution) passa a valer sempre
--    para conversas com pessoas, como no WhatsApp Web — menos quando o dono do número
--    deu um nome no Omni (name_manual).
-- 3. A conversa que o WhatsApp mandou só pelo @lid ganha o número quando a Evolution
--    sabe a ligação (patch-lid): nome da agenda, ligações e caixa única passam a achá-la.
--    Se já existe a conversa pelo número, as duas são juntadas.

ALTER TABLE whatsapp_chats ADD COLUMN name_manual boolean NOT NULL DEFAULT false;

CREATE FUNCTION app.nome_de_contato(p text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE WHEN p IS NULL OR btrim(p) = '' OR btrim(p) ~ '^[0-9\s+().-]+$' THEN NULL ELSE left(btrim(p), 120) END
  $$;
REVOKE ALL ON FUNCTION app.nome_de_contato(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.nome_de_contato(text) TO omni_app, omni_worker;

CREATE OR REPLACE FUNCTION app.whatsapp_conversa(p_number uuid, p_jid text, p_lid text, p_grupo boolean, p_telefone text, p_nome text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid; v_lid_chat uuid; v_lid text;
  BEGIN
    v_lid := CASE WHEN p_lid ~ '^\d{5,20}@lid$' THEN p_lid WHEN p_jid ~ '^\d{5,20}@lid$' THEN p_jid END;
    IF NOT p_grupo AND v_lid IS NOT NULL THEN
      SELECT id INTO v_lid_chat FROM whatsapp_chats WHERE number_id = p_number AND (lid = v_lid OR jid = v_lid) ORDER BY (jid = v_lid) LIMIT 1;
    END IF;
    IF p_jid ~ '^\d{5,20}@lid$' AND v_lid_chat IS NOT NULL THEN
      v_chat := v_lid_chat; -- só o @lid: a conversa que já o conhece
    ELSE
      INSERT INTO whatsapp_chats (number_id, jid, is_group, phone, name)
           VALUES (p_number, p_jid, p_grupo, p_telefone, CASE WHEN NOT p_grupo THEN app.nome_de_contato(p_nome) END)
      ON CONFLICT (number_id, jid) DO UPDATE
           SET phone = coalesce(whatsapp_chats.phone, EXCLUDED.phone),
               name  = CASE WHEN whatsapp_chats.is_group OR whatsapp_chats.name_manual THEN whatsapp_chats.name
                            ELSE coalesce(app.nome_de_contato(whatsapp_chats.name), EXCLUDED.name) END
      RETURNING id INTO v_chat;
      IF v_lid_chat IS NOT NULL AND v_lid_chat <> v_chat THEN
        PERFORM app.whatsapp_juntar_conversas(v_lid_chat, v_chat);
      END IF;
      IF NOT p_grupo AND v_lid IS NOT NULL AND p_jid <> v_lid THEN
        UPDATE whatsapp_chats SET lid = v_lid WHERE id = v_chat AND lid IS DISTINCT FROM v_lid;
      END IF;
    END IF;
    RETURN v_chat;
  END $$;

-- Nome dado pelo dono: fica (a agenda não sobrescreve).
CREATE OR REPLACE FUNCTION app.whatsapp_renomear_contato(p_chat uuid, p_nome text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_nome text := left(btrim(coalesce(p_nome, '')), 120);
  BEGIN
    IF length(v_nome) < 1 THEN RETURN false; END IF;
    UPDATE whatsapp_chats c SET name = v_nome, name_manual = true
      FROM whatsapp_numbers n
     WHERE c.id = p_chat AND n.id = c.number_id AND NOT c.is_group
       AND n.owner_person_id = app.current_person_id() AND n.status <> 'removido';
    RETURN FOUND;
  END $$;

-- Nome, foto e telefone pela lista da Evolution. p_agenda: o nome vem da agenda do
-- celular (lista de contatos) e vale sempre; senão (lista de conversas), só preenche.
-- p_telefone: o número da pessoa quando a conversa é pelo @lid.
DROP FUNCTION app.whatsapp_perfil_conversa(uuid, text, text, text);
CREATE FUNCTION app.whatsapp_perfil_conversa(p_number uuid, p_jid text, p_nome text, p_foto text, p_agenda boolean, p_telefone text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    c whatsapp_chats;
    v_nome text := app.nome_de_contato(p_nome);
    v_foto text := CASE WHEN p_foto ~ '^https://([a-z0-9-]+\.)*whatsapp\.net/' AND length(p_foto) <= 2048 THEN p_foto END;
    v_tel text := CASE WHEN p_telefone ~ '^\d{8,15}$' THEN p_telefone END;
    v_pelo_numero uuid;
    v_novo_nome text;
  BEGIN
    SELECT * INTO c FROM whatsapp_chats WHERE number_id = p_number AND (jid = p_jid OR lid = p_jid) ORDER BY (jid = p_jid) DESC LIMIT 1;
    IF NOT FOUND THEN RETURN false; END IF;
    -- Conversa só pelo @lid e o número é conhecido: junta com a do número, se existir.
    IF NOT c.is_group AND v_tel IS NOT NULL AND c.jid ~ '^\d{5,20}@lid$' AND c.phone IS NULL THEN
      SELECT id INTO v_pelo_numero FROM whatsapp_chats WHERE number_id = p_number AND jid = v_tel || '@s.whatsapp.net';
      IF v_pelo_numero IS NOT NULL THEN
        PERFORM app.whatsapp_juntar_conversas(c.id, v_pelo_numero);
        UPDATE whatsapp_chats SET lid = coalesce(lid, c.jid) WHERE id = v_pelo_numero;
        SELECT * INTO c FROM whatsapp_chats WHERE id = v_pelo_numero;
      ELSE
        UPDATE whatsapp_chats SET phone = v_tel WHERE id = c.id;
        c.phone := v_tel;
      END IF;
    END IF;
    v_novo_nome := CASE
      WHEN c.is_group THEN coalesce(v_nome, c.name)
      WHEN c.name_manual THEN c.name
      WHEN p_agenda THEN coalesce(v_nome, app.nome_de_contato(c.name))
      ELSE coalesce(app.nome_de_contato(c.name), v_nome) END;
    IF c.name IS NOT DISTINCT FROM v_novo_nome AND (v_foto IS NULL OR c.photo_url IS NOT DISTINCT FROM v_foto) AND v_pelo_numero IS NULL
       AND NOT (v_tel IS NOT NULL AND c.phone = v_tel AND c.jid ~ '@lid$') THEN
      RETURN false;
    END IF;
    UPDATE whatsapp_chats
       SET name = v_novo_nome,
           -- A mesma pessoa aparece pelo número e pelo @lid na lista: uma entrada sem foto não apaga a outra.
           photo_url = coalesce(v_foto, photo_url),
           profile_sync_at = now()
     WHERE id = c.id;
    RETURN true;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_perfil_conversa(uuid, text, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_perfil_conversa(uuid, text, text, text, boolean, text) TO omni_worker;

-- Limpa os "nomes" que são só o número (a próxima leitura da agenda preenche).
UPDATE whatsapp_chats SET name = NULL
 WHERE NOT is_group AND name IS NOT NULL AND app.nome_de_contato(name) IS NULL;
