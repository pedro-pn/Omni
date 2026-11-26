-- Ações nas mensagens do WhatsApp, como no WhatsApp Web (26/11/2026):
--   * responder citando, editar, apagar para todos e encaminhar: campos novos em whatsapp_messages,
--     escritos pelo webhook (o que chega do WhatsApp) e pelas ações do Omni;
--   * reações (whatsapp_reactions): de todos na conversa, uma por pessoa e mensagem;
--   * mensagens fixadas na conversa (whatsapp_pinned_messages, até 3): do número (o dono fixa);
--   * por pessoa: favoritar e "apagar para mim" (whatsapp_message_flags) e conversas fixadas no
--     topo da lista (whatsapp_chat_pins, até 3).
-- Quem vê a conversa vê tudo isso (RLS pelo mesmo conjunto das mensagens).

ALTER TABLE whatsapp_messages
  ADD COLUMN quoted_wa_id   text,
  ADD COLUMN quoted_body    text,
  ADD COLUMN quoted_author  text,
  ADD COLUMN forwarded      boolean NOT NULL DEFAULT false,
  ADD COLUMN edited_at      timestamptz,
  ADD COLUMN deleted_at     timestamptz;

CREATE TABLE whatsapp_reactions (
  chat_id       uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  wa_id         text NOT NULL,                 -- a mensagem reagida
  reactor       text NOT NULL,                 -- 'eu' (o próprio número) ou o JID de quem reagiu
  reactor_name  text,
  emoji         text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  reacted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, wa_id, reactor)
);
ALTER TABLE whatsapp_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_reactions_ver ON whatsapp_reactions FOR SELECT TO omni_app USING (chat_id IN (SELECT app.conversas_que_vejo()));
CREATE POLICY wa_reactions_worker ON whatsapp_reactions FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT ON whatsapp_reactions TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_reactions TO omni_worker;

CREATE TABLE whatsapp_pinned_messages (
  chat_id     uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  wa_id       text NOT NULL,
  pinned_by   uuid REFERENCES people(id),
  pinned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, wa_id)
);
ALTER TABLE whatsapp_pinned_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_pinned_ver ON whatsapp_pinned_messages FOR SELECT TO omni_app USING (chat_id IN (SELECT app.conversas_que_vejo()));
-- Fixa e desafixa quem responde pelo número (o dono).
CREATE POLICY wa_pinned_dono ON whatsapp_pinned_messages FOR ALL TO omni_app
  USING (EXISTS (SELECT 1 FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id WHERE c.id = chat_id AND n.owner_person_id = app.current_person_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id WHERE c.id = chat_id AND n.owner_person_id = app.current_person_id())
              AND pinned_by = app.current_person_id());
GRANT SELECT, INSERT, DELETE ON whatsapp_pinned_messages TO omni_app;

CREATE TABLE whatsapp_message_flags (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  chat_id     uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  wa_id       text NOT NULL,
  starred     boolean NOT NULL DEFAULT false,
  hidden      boolean NOT NULL DEFAULT false,   -- "apagar para mim"
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, chat_id, wa_id)
);
ALTER TABLE whatsapp_message_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_flags_proprias ON whatsapp_message_flags FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id() AND chat_id IN (SELECT app.conversas_que_vejo()));
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_message_flags TO omni_app;

CREATE TABLE whatsapp_chat_pins (
  person_id  uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  chat_id    uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  pinned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, chat_id)
);
ALTER TABLE whatsapp_chat_pins ENABLE ROW LEVEL SECURITY;
CREATE POLICY wa_chat_pins_proprias ON whatsapp_chat_pins FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id() AND chat_id IN (SELECT app.conversas_que_vejo()));
GRANT SELECT, INSERT, DELETE ON whatsapp_chat_pins TO omni_app;

-- ---------------------------------------------------------------- o que chega do WhatsApp (webhook)

-- Conversa já existente do número pelo JID ou @lid (reação/edição/exclusão não criam conversa).
CREATE FUNCTION app.whatsapp_conversa_existente(p_instancia text, p_jid text, p_lid text) RETURNS TABLE (chat uuid, numero uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.number_id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE n.instance_name = p_instancia AND n.status <> 'removido'
       AND (c.jid = p_jid OR c.lid = p_jid OR (p_lid IS NOT NULL AND (c.lid = p_lid OR c.jid = p_lid)))
     LIMIT 1
  $$;

-- Mensagem nova com citação e encaminhamento (a versão anterior, 0048, sem eles, sai).
DROP FUNCTION app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz);
CREATE FUNCTION app.whatsapp_registrar_mensagem(
  p_instancia text, p_chat_jid text, p_lid text, p_grupo boolean, p_telefone text, p_wa_id text, p_de_mim boolean,
  p_autor_jid text, p_autor_nome text, p_tipo text, p_texto text, p_arquivo text, p_em timestamptz,
  p_citada_wa_id text DEFAULT NULL, p_citada_texto text DEFAULT NULL, p_citada_autor text DEFAULT NULL, p_encaminhada boolean DEFAULT false
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
    INSERT INTO whatsapp_messages (chat_id, wa_id, from_me, author_jid, author_name, kind, body, file_name, sent_at, status,
                                   quoted_wa_id, quoted_body, quoted_author, forwarded)
         VALUES (v_chat, p_wa_id, p_de_mim, p_autor_jid, p_autor_nome, p_tipo, left(p_texto, 4096), left(p_arquivo, 255), p_em, CASE WHEN p_de_mim THEN 'enviada' END,
                 left(p_citada_wa_id, 128), left(p_citada_texto, 300), left(p_citada_autor, 128), coalesce(p_encaminhada, false))
    ON CONFLICT (chat_id, wa_id) DO NOTHING;
    GET DIAGNOSTICS v_nova = ROW_COUNT;
    IF v_nova THEN
      UPDATE whatsapp_chats SET last_message_at = p_em, last_preview = v_previa
       WHERE id = v_chat AND (last_message_at IS NULL OR last_message_at <= p_em);
      PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat)::text);
    END IF;
    RETURN v_nova;
  END $$;

-- Reação (emoji vazio = tirou a reação).
CREATE FUNCTION app.whatsapp_registrar_reacao(p_instancia text, p_chat_jid text, p_lid text, p_alvo_wa_id text, p_de_mim boolean, p_autor_jid text, p_autor_nome text, p_emoji text, p_em timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid; v_number uuid; v_quem text := CASE WHEN p_de_mim THEN 'eu' ELSE coalesce(p_autor_jid, p_chat_jid) END;
  BEGIN
    SELECT chat, numero INTO v_chat, v_number FROM app.whatsapp_conversa_existente(p_instancia, p_chat_jid, p_lid);
    IF v_chat IS NULL OR p_alvo_wa_id IS NULL THEN RETURN; END IF;
    IF coalesce(p_emoji, '') = '' THEN
      DELETE FROM whatsapp_reactions WHERE chat_id = v_chat AND wa_id = p_alvo_wa_id AND reactor = v_quem;
    ELSE
      INSERT INTO whatsapp_reactions (chat_id, wa_id, reactor, reactor_name, emoji, reacted_at)
      VALUES (v_chat, p_alvo_wa_id, v_quem, left(p_autor_nome, 128), left(p_emoji, 16), coalesce(p_em, now()))
      ON CONFLICT (chat_id, wa_id, reactor) DO UPDATE SET emoji = EXCLUDED.emoji, reacted_at = EXCLUDED.reacted_at, reactor_name = coalesce(EXCLUDED.reactor_name, whatsapp_reactions.reactor_name);
    END IF;
    PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat, 'status', true)::text);
  END $$;

-- Apagada para todos: o conteúdo sai do Omni (fica "Mensagem apagada").
CREATE FUNCTION app.whatsapp_registrar_apagada(p_instancia text, p_chat_jid text, p_lid text, p_wa_id text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid; v_number uuid;
  BEGIN
    SELECT chat, numero INTO v_chat, v_number FROM app.whatsapp_conversa_existente(p_instancia, p_chat_jid, p_lid);
    IF v_chat IS NULL THEN RETURN; END IF;
    UPDATE whatsapp_messages SET deleted_at = coalesce(deleted_at, now()), body = NULL, file_name = NULL, quoted_body = NULL
     WHERE chat_id = v_chat AND wa_id = p_wa_id;
    DELETE FROM whatsapp_reactions WHERE chat_id = v_chat AND wa_id = p_wa_id;
    DELETE FROM whatsapp_pinned_messages WHERE chat_id = v_chat AND wa_id = p_wa_id;
    PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat, 'status', true)::text);
  END $$;

-- Editada: o texto novo e a marca "Editada".
CREATE FUNCTION app.whatsapp_registrar_edicao(p_instancia text, p_chat_jid text, p_lid text, p_wa_id text, p_texto text, p_em timestamptz)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid; v_number uuid;
  BEGIN
    SELECT chat, numero INTO v_chat, v_number FROM app.whatsapp_conversa_existente(p_instancia, p_chat_jid, p_lid);
    IF v_chat IS NULL OR p_texto IS NULL THEN RETURN; END IF;
    UPDATE whatsapp_messages SET body = left(p_texto, 4096), edited_at = coalesce(p_em, now())
     WHERE chat_id = v_chat AND wa_id = p_wa_id AND deleted_at IS NULL;
    PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat, 'status', true)::text);
  END $$;

-- Fixada ou desafixada no celular (ou por outra pessoa no grupo).
CREATE FUNCTION app.whatsapp_registrar_fixada(p_instancia text, p_chat_jid text, p_lid text, p_wa_id text, p_fixar boolean)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid; v_number uuid;
  BEGIN
    SELECT chat, numero INTO v_chat, v_number FROM app.whatsapp_conversa_existente(p_instancia, p_chat_jid, p_lid);
    IF v_chat IS NULL OR p_wa_id IS NULL THEN RETURN; END IF;
    IF p_fixar THEN
      INSERT INTO whatsapp_pinned_messages (chat_id, wa_id) VALUES (v_chat, p_wa_id) ON CONFLICT DO NOTHING;
      -- No máximo 3, como no WhatsApp: sai a mais antiga.
      DELETE FROM whatsapp_pinned_messages WHERE chat_id = v_chat AND wa_id NOT IN
        (SELECT wa_id FROM whatsapp_pinned_messages WHERE chat_id = v_chat ORDER BY pinned_at DESC LIMIT 3);
    ELSE
      DELETE FROM whatsapp_pinned_messages WHERE chat_id = v_chat AND wa_id = p_wa_id;
    END IF;
    PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat, 'status', true)::text);
  END $$;

REVOKE ALL ON FUNCTION app.whatsapp_conversa_existente(text, text, text),
  app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz, text, text, text, boolean),
  app.whatsapp_registrar_reacao(text, text, text, text, boolean, text, text, text, timestamptz),
  app.whatsapp_registrar_apagada(text, text, text, text),
  app.whatsapp_registrar_edicao(text, text, text, text, text, timestamptz),
  app.whatsapp_registrar_fixada(text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz, text, text, text, boolean),
  app.whatsapp_registrar_reacao(text, text, text, text, boolean, text, text, text, timestamptz),
  app.whatsapp_registrar_apagada(text, text, text, text),
  app.whatsapp_registrar_edicao(text, text, text, text, text, timestamptz),
  app.whatsapp_registrar_fixada(text, text, text, text, boolean) TO omni_app;
