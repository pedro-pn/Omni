-- WhatsApp: uma conversa por pessoa, nome dos grupos e foto.
--
-- O WhatsApp passou a identificar contatos também por um id de privacidade
-- (…@lid). A Evolution manda a mesma conversa às vezes pelo número
-- (…@s.whatsapp.net), às vezes pelo @lid, e o Omni criava duas conversas.
-- Agora a conversa é a do número; o @lid fica guardado nela (coluna lid) para
-- reconhecer as mensagens e os status que chegam só com ele. As duplicadas que
-- já existem são juntadas aqui (mensagens repetidas saem; missões, concluídas,
-- recusas e envios passam para a conversa que fica).
--
-- Nome e foto vêm da lista de conversas da Evolution (job whatsapp-perfis). A
-- foto não é guardada: só o endereço dela no WhatsApp, lido pelo servidor do
-- Omni quando alguém que vê o número abre a lista.

ALTER TABLE whatsapp_chats
  ADD COLUMN lid             text CHECK (lid ~ '^\d{5,20}@lid$'),
  ADD COLUMN photo_url       text CHECK (length(photo_url) <= 2048),
  ADD COLUMN profile_sync_at timestamptz;
CREATE UNIQUE INDEX whatsapp_chats_lid ON whatsapp_chats (number_id, lid) WHERE lid IS NOT NULL;

-- Junta a conversa p_de na p_para (mesma pessoa) e apaga p_de.
CREATE FUNCTION app.whatsapp_juntar_conversas(p_de uuid, p_para uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE d whatsapp_chats;
  BEGIN
    IF p_de = p_para THEN RETURN; END IF;
    SELECT * INTO d FROM whatsapp_chats WHERE id = p_de FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    DELETE FROM whatsapp_messages m WHERE m.chat_id = p_de AND EXISTS (SELECT 1 FROM whatsapp_messages x WHERE x.chat_id = p_para AND x.wa_id = m.wa_id);
    UPDATE whatsapp_messages SET chat_id = p_para WHERE chat_id = p_de;
    UPDATE whatsapp_chat_missions t SET chat_id = p_para WHERE chat_id = p_de
       AND NOT EXISTS (SELECT 1 FROM whatsapp_chat_missions x WHERE x.chat_id = p_para AND x.mission_id = t.mission_id);
    DELETE FROM whatsapp_chat_missions WHERE chat_id = p_de;
    UPDATE whatsapp_link_dismissals t SET chat_id = p_para WHERE chat_id = p_de
       AND NOT EXISTS (SELECT 1 FROM whatsapp_link_dismissals x WHERE x.chat_id = p_para AND x.mission_id = t.mission_id);
    DELETE FROM whatsapp_link_dismissals WHERE chat_id = p_de;
    UPDATE whatsapp_chat_concluded t SET chat_id = p_para WHERE chat_id = p_de
       AND NOT EXISTS (SELECT 1 FROM whatsapp_chat_concluded x WHERE x.chat_id = p_para AND x.person_id = t.person_id);
    DELETE FROM whatsapp_chat_concluded WHERE chat_id = p_de;
    UPDATE whatsapp_outbox SET chat_id = p_para WHERE chat_id = p_de;
    DELETE FROM whatsapp_chats WHERE id = p_de;
    UPDATE whatsapp_chats p
       SET name  = coalesce(p.name, d.name),
           phone = coalesce(p.phone, d.phone),
           lid   = coalesce(p.lid, d.lid, CASE WHEN d.jid ~ '^\d{5,20}@lid$' THEN d.jid END),
           photo_url = coalesce(p.photo_url, d.photo_url),
           last_preview = CASE WHEN d.last_message_at > coalesce(p.last_message_at, '-infinity') THEN d.last_preview ELSE p.last_preview END,
           last_message_at = greatest(p.last_message_at, d.last_message_at)
     WHERE p.id = p_para;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_juntar_conversas(uuid, uuid) FROM PUBLIC;

-- A conversa de uma mensagem: pelo número quando ele vem; senão pelo @lid já
-- conhecido. Cria se não existir; junta se o @lid tinha virado uma conversa à parte.
CREATE FUNCTION app.whatsapp_conversa(p_number uuid, p_jid text, p_lid text, p_grupo boolean, p_telefone text, p_nome text) RETURNS uuid
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
           VALUES (p_number, p_jid, p_grupo, p_telefone, CASE WHEN NOT p_grupo THEN left(btrim(p_nome), 120) END)
      ON CONFLICT (number_id, jid) DO UPDATE
           SET phone = coalesce(whatsapp_chats.phone, EXCLUDED.phone),
               name  = coalesce(whatsapp_chats.name, EXCLUDED.name)
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
REVOKE ALL ON FUNCTION app.whatsapp_conversa(uuid, text, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_conversa(uuid, text, text, boolean, text, text) TO omni_worker;

DROP FUNCTION app.whatsapp_registrar_mensagem(text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz);
CREATE FUNCTION app.whatsapp_registrar_mensagem(
  p_instancia text, p_chat_jid text, p_lid text, p_grupo boolean, p_telefone text, p_wa_id text, p_de_mim boolean,
  p_autor_jid text, p_autor_nome text, p_tipo text, p_texto text, p_arquivo text, p_em timestamptz
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_number uuid;
    v_chat uuid;
    v_nova boolean;
    v_previa text := left(coalesce(p_texto, CASE p_tipo WHEN 'imagem' THEN '[imagem]' WHEN 'video' THEN '[vídeo]' WHEN 'audio' THEN '[áudio]'
                                                        WHEN 'documento' THEN coalesce('[arquivo] ' || p_arquivo, '[arquivo]') WHEN 'figurinha' THEN '[figurinha]'
                                                        WHEN 'localizacao' THEN '[localização]' WHEN 'contato' THEN '[contato]' ELSE '[mensagem]' END), 160);
  BEGIN
    SELECT id INTO v_number FROM whatsapp_numbers WHERE instance_name = p_instancia AND status <> 'removido';
    IF v_number IS NULL THEN RETURN false; END IF;
    v_chat := app.whatsapp_conversa(v_number, p_chat_jid, p_lid, p_grupo, p_telefone, CASE WHEN NOT p_de_mim THEN p_autor_nome END);
    INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, author_jid, author_name, kind, body, file_name, sent_at, status)
         VALUES (v_chat, p_wa_id, p_de_mim, p_autor_jid, p_autor_nome, p_tipo, left(p_texto, 4096), left(p_arquivo, 255), p_em, CASE WHEN p_de_mim THEN 'enviada' END)
    ON CONFLICT (chat_id, wa_id) DO NOTHING;
    GET DIAGNOSTICS v_nova = ROW_COUNT;
    IF v_nova THEN
      UPDATE whatsapp_chats SET last_message_at = p_em, last_preview = v_previa
       WHERE id = v_chat AND (last_message_at IS NULL OR last_message_at <= p_em);
      PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat)::text);
    END IF;
    RETURN v_nova;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz) TO omni_app;

-- Status que chega pelo @lid também acha a conversa.
CREATE OR REPLACE FUNCTION app.whatsapp_registrar_status(p_instancia text, p_chat_jid text, p_wa_id text, p_status text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE whatsapp_messages m SET status = p_status
      FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE m.chat_id = c.id AND n.instance_name = p_instancia AND (c.jid = p_chat_jid OR c.lid = p_chat_jid) AND m.wa_id = p_wa_id
       AND p_status IN ('enviada', 'entregue', 'lida', 'erro')
       AND array_position(ARRAY['enviada', 'entregue', 'lida'], p_status) > coalesce(array_position(ARRAY['enviada', 'entregue', 'lida'], m.status), 0)
  $$;

-- Nome do grupo (sempre o atual), nome do contato (só se faltar) e foto, pela lista da Evolution.
-- Devolve true quando mudou algo.
CREATE FUNCTION app.whatsapp_perfil_conversa(p_number uuid, p_jid text, p_nome text, p_foto text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH alvo AS (
      SELECT id FROM whatsapp_chats WHERE number_id = p_number AND (jid = p_jid OR lid = p_jid) ORDER BY (jid = p_jid) DESC LIMIT 1
    ), novo AS (
      SELECT CASE WHEN length(btrim(coalesce(p_nome, ''))) > 0 THEN left(btrim(p_nome), 120) END AS nome,
             CASE WHEN p_foto ~ '^https://([a-z0-9-]+\.)*whatsapp\.net/' AND length(p_foto) <= 2048 THEN p_foto END AS foto
    )
    UPDATE whatsapp_chats c
       SET name = CASE WHEN c.is_group THEN coalesce(novo.nome, c.name) ELSE coalesce(c.name, novo.nome) END,
           -- A mesma pessoa aparece pelo número e pelo @lid na lista: uma entrada sem foto não apaga a outra.
           photo_url = coalesce(novo.foto, c.photo_url),
           profile_sync_at = now()
      FROM alvo, novo
     WHERE c.id = alvo.id
       AND (c.name IS DISTINCT FROM CASE WHEN c.is_group THEN coalesce(novo.nome, c.name) ELSE coalesce(c.name, novo.nome) END
            OR (novo.foto IS NOT NULL AND c.photo_url IS DISTINCT FROM novo.foto))
    RETURNING true
  $$;
REVOKE ALL ON FUNCTION app.whatsapp_perfil_conversa(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_perfil_conversa(uuid, text, text, text) TO omni_worker;

-- Junta as duplicadas que já existem: @lid com o número conhecido.
DO $$
DECLARE r record; v_para uuid;
BEGIN
  FOR r IN SELECT id, number_id, jid, phone FROM whatsapp_chats WHERE NOT is_group AND jid ~ '^\d{5,20}@lid$' AND phone IS NOT NULL LOOP
    SELECT id INTO v_para FROM whatsapp_chats WHERE number_id = r.number_id AND jid = r.phone || '@s.whatsapp.net';
    IF v_para IS NULL THEN
      UPDATE whatsapp_chats SET lid = jid, jid = r.phone || '@s.whatsapp.net' WHERE id = r.id;
    ELSE
      PERFORM app.whatsapp_juntar_conversas(r.id, v_para);
    END IF;
  END LOOP;
END $$;
