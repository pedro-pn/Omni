-- Marcações nos grupos do WhatsApp (26/11/2026): o texto traz "@<id>" (muitas vezes o @lid, um
-- número que não é o telefone); quem foi marcado vem em contextInfo.mentionedJid. O Omni guarda
-- esses JIDs para a tela trocar o "@número" pelo nome (agenda, conversa ou autor no grupo),
-- clicável para abrir a conversa com a pessoa.

ALTER TABLE whatsapp_messages ADD COLUMN mentions text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(mentions) <= 50);

DROP FUNCTION app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz, text, text, text, boolean);
CREATE FUNCTION app.whatsapp_registrar_mensagem(
  p_instancia text, p_chat_jid text, p_lid text, p_grupo boolean, p_telefone text, p_wa_id text, p_de_mim boolean,
  p_autor_jid text, p_autor_nome text, p_tipo text, p_texto text, p_arquivo text, p_em timestamptz,
  p_citada_wa_id text DEFAULT NULL, p_citada_texto text DEFAULT NULL, p_citada_autor text DEFAULT NULL, p_encaminhada boolean DEFAULT false,
  p_mencoes text[] DEFAULT '{}'
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
                                   quoted_wa_id, quoted_body, quoted_author, forwarded, mentions)
         VALUES (v_chat, p_wa_id, p_de_mim, p_autor_jid, p_autor_nome, p_tipo, left(p_texto, 4096), left(p_arquivo, 255), p_em, CASE WHEN p_de_mim THEN 'enviada' END,
                 left(p_citada_wa_id, 128), left(p_citada_texto, 300), left(p_citada_autor, 128), coalesce(p_encaminhada, false),
                 coalesce((SELECT array_agg(m) FROM (SELECT DISTINCT m FROM unnest(p_mencoes) m WHERE m ~ '^\d{5,20}@(s\.whatsapp\.net|lid)$' LIMIT 50) x), '{}'))
    ON CONFLICT (chat_id, wa_id) DO NOTHING;
    GET DIAGNOSTICS v_nova = ROW_COUNT;
    IF v_nova THEN
      UPDATE whatsapp_chats SET last_message_at = p_em, last_preview = v_previa
       WHERE id = v_chat AND (last_message_at IS NULL OR last_message_at <= p_em);
      PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat)::text);
    END IF;
    RETURN v_nova;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz, text, text, text, boolean, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_registrar_mensagem(text, text, text, boolean, text, text, boolean, text, text, text, text, text, timestamptz, text, text, text, boolean, text[]) TO omni_app;
