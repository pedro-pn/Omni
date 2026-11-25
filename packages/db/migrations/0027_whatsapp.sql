-- 0027 · WhatsApp pela Evolution (Fase 7, ADR 0004): números, conversas e mensagens.
--
-- * whatsapp_numbers: cada número do Omni é uma instância da Evolution própria
--   do Omni (nome gerado, "omni-…"). A administração cadastra, pareia pelo QR e
--   remove. Um telefone só pode estar em um número ativo.
-- * whatsapp_number_members: quem vê as conversas do número, além do dono e da
--   diretoria (definido pela administração).
-- * whatsapp_chats / whatsapp_messages: o que chega pelo webhook. A tela só lê;
--   quem grava é o webhook, pelas funções app.whatsapp_registrar_* (conferem que o
--   número existe e não foi removido). Sem mídia: só tipo, texto/legenda e nome do arquivo.
-- * Mensagens internas e gerenciais NUNCA vão para o WhatsApp: nada aqui liga
--   mission_messages a estas tabelas.

CREATE TABLE whatsapp_numbers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_name    text NOT NULL UNIQUE CHECK (instance_name ~ '^omni-[a-z0-9]{6,32}$'),
  label            text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 80),
  purpose          text NOT NULL CHECK (purpose IN ('operacao', 'campo', 'gestao', 'outro')),
  owner_person_id  uuid REFERENCES people(id),
  phone            text CHECK (phone ~ '^\d{8,15}$'),
  profile_name     text,
  status           text NOT NULL DEFAULT 'criado' CHECK (status IN ('criado', 'conectando', 'conectado', 'desconectado', 'removido')),
  status_at        timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  created_by       uuid REFERENCES people(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Um aparelho em um número ativo só (e, combinado com o Prisma, em um sistema só).
CREATE UNIQUE INDEX whatsapp_numbers_phone_ativo ON whatsapp_numbers (phone) WHERE status <> 'removido' AND phone IS NOT NULL;

CREATE TABLE whatsapp_number_members (
  number_id  uuid NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES people(id),
  added_by   uuid REFERENCES people(id),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, person_id)
);

CREATE TABLE whatsapp_chats (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id        uuid NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  jid              text NOT NULL CHECK (jid ~ '^(\d{5,20}(:\d+)?@(s\.whatsapp\.net|lid)|[\d-]{6,40}@g\.us)$'),
  is_group         boolean NOT NULL,
  phone            text CHECK (phone ~ '^\d{8,15}$'),
  name             text,
  last_message_at  timestamptz,
  last_preview     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (number_id, jid)
);
CREATE INDEX whatsapp_chats_recentes ON whatsapp_chats (number_id, last_message_at DESC);

CREATE TABLE whatsapp_messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id      uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  wa_id        text NOT NULL CHECK (length(wa_id) BETWEEN 1 AND 128),
  from_me      boolean NOT NULL,
  author_jid   text,
  author_name  text,
  kind         text NOT NULL CHECK (kind IN ('texto', 'imagem', 'video', 'audio', 'documento', 'figurinha', 'localizacao', 'contato', 'outro')),
  body         text CHECK (length(body) <= 4096),
  file_name    text CHECK (length(file_name) <= 255),
  sent_at      timestamptz NOT NULL,
  status       text CHECK (status IN ('enviada', 'entregue', 'lida', 'erro')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chat_id, wa_id)
);
CREATE INDEX whatsapp_messages_chat ON whatsapp_messages (chat_id, sent_at);

-- Quem vê as conversas de um número.
CREATE FUNCTION app.ve_numero_whatsapp(p_number uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.has_profile('diretoria')
        OR EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = p_number AND n.owner_person_id = app.current_person_id())
        OR EXISTS (SELECT 1 FROM whatsapp_number_members m WHERE m.number_id = p_number AND m.person_id = app.current_person_id())
  $$;
GRANT EXECUTE ON FUNCTION app.ve_numero_whatsapp(uuid) TO omni_app;

ALTER TABLE whatsapp_numbers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_number_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_chats          ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages       ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON whatsapp_numbers TO omni_app;
GRANT SELECT, INSERT, DELETE ON whatsapp_number_members TO omni_app;
GRANT SELECT ON whatsapp_chats, whatsapp_messages TO omni_app;
GRANT SELECT, UPDATE ON whatsapp_numbers TO omni_worker;

CREATE POLICY wa_numbers_admin   ON whatsapp_numbers FOR ALL TO omni_app USING (app.has_profile('admin')) WITH CHECK (app.has_profile('admin'));
CREATE POLICY wa_numbers_ver     ON whatsapp_numbers FOR SELECT TO omni_app USING (app.ve_numero_whatsapp(id));
CREATE POLICY wa_numbers_worker  ON whatsapp_numbers FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY wa_members_admin   ON whatsapp_number_members FOR ALL TO omni_app USING (app.has_profile('admin')) WITH CHECK (app.has_profile('admin'));
CREATE POLICY wa_members_ver     ON whatsapp_number_members FOR SELECT TO omni_app USING (app.ve_numero_whatsapp(number_id));
CREATE POLICY wa_chats_ver       ON whatsapp_chats FOR SELECT TO omni_app USING (app.ve_numero_whatsapp(number_id));
CREATE POLICY wa_messages_ver    ON whatsapp_messages FOR SELECT TO omni_app
  USING (EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = chat_id AND app.ve_numero_whatsapp(c.number_id)));

-- ---------------------------------------------------------------- gravação pelo webhook
-- Chamadas pelo servidor do Omni depois de conferir o segredo do webhook (sem pessoa na sessão).

CREATE FUNCTION app.whatsapp_registrar_mensagem(
  p_instancia text, p_chat_jid text, p_grupo boolean, p_telefone text, p_wa_id text, p_de_mim boolean,
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
    INSERT INTO whatsapp_chats (number_id, jid, is_group, phone, name)
         VALUES (v_number, p_chat_jid, p_grupo, p_telefone, CASE WHEN NOT p_grupo AND NOT p_de_mim THEN p_autor_nome END)
    ON CONFLICT (number_id, jid) DO UPDATE
         SET phone = coalesce(whatsapp_chats.phone, EXCLUDED.phone),
             name  = coalesce(whatsapp_chats.name, EXCLUDED.name)
    RETURNING id INTO v_chat;
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

CREATE FUNCTION app.whatsapp_registrar_status(p_instancia text, p_chat_jid text, p_wa_id text, p_status text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE whatsapp_messages m SET status = p_status
      FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE m.chat_id = c.id AND n.instance_name = p_instancia AND c.jid = p_chat_jid AND m.wa_id = p_wa_id
       AND p_status IN ('enviada', 'entregue', 'lida', 'erro')
       -- só avança (lida não volta para entregue)
       AND array_position(ARRAY['enviada', 'entregue', 'lida'], p_status) > coalesce(array_position(ARRAY['enviada', 'entregue', 'lida'], m.status), 0)
  $$;

CREATE FUNCTION app.whatsapp_registrar_conexao(p_instancia text, p_estado text, p_telefone text, p_perfil text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF p_estado NOT IN ('conectando', 'conectado', 'desconectado') THEN RETURN; END IF;
    UPDATE whatsapp_numbers
       SET status = p_estado, status_at = now(), phone = coalesce(p_telefone, phone),
           profile_name = coalesce(p_perfil, profile_name), last_error = NULL
     WHERE instance_name = p_instancia AND status <> 'removido';
  EXCEPTION WHEN unique_violation THEN
    -- O aparelho já está em outro número ativo do Omni: registra sem trocar o telefone.
    UPDATE whatsapp_numbers
       SET status = p_estado, status_at = now(),
           last_error = 'Este aparelho já está pareado em outro número do Omni. Desconecte um dos dois.'
     WHERE instance_name = p_instancia AND status <> 'removido';
  END $$;

GRANT EXECUTE ON FUNCTION app.whatsapp_registrar_mensagem(text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz),
                          app.whatsapp_registrar_status(text, text, text, text),
                          app.whatsapp_registrar_conexao(text, text, text, text) TO omni_app;
