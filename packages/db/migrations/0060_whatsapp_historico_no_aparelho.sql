-- Histórico do WhatsApp no aparelho e conversa nova (12/11/2026).
--
-- O histórico do pareamento fica na Evolution do Omni e é baixado pelo navegador
-- do dono do número (cache local, como o WhatsApp Web): o Omni guarda só as
-- conversas (nome, data e prévia da última mensagem), não as mensagens antigas.
-- A mesma função abre uma conversa nova com um contato ou um número.
-- Só o dono do número (app.ve_numero_whatsapp, 0054).

CREATE FUNCTION app.whatsapp_conversa_do_dono(
  p_number uuid, p_jid text, p_lid text, p_grupo boolean, p_telefone text, p_nome text, p_ultima timestamptz, p_previa text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid;
  BEGIN
    IF NOT app.ve_numero_whatsapp(p_number) THEN
      RAISE EXCEPTION 'Só o dono do número abre conversas nele.' USING ERRCODE = '42501';
    END IF;
    IF p_jid !~ '^([\d-]{6,40}@g\.us|\d{5,20}@(s\.whatsapp\.net|lid))$' OR p_grupo IS DISTINCT FROM (p_jid ~ '@g\.us$') THEN
      RAISE EXCEPTION 'Conversa inválida.' USING ERRCODE = '22023';
    END IF;
    IF p_telefone IS NOT NULL AND p_telefone !~ '^\d{8,15}$' THEN
      RAISE EXCEPTION 'Telefone inválido.' USING ERRCODE = '22023';
    END IF;
    v_chat := app.whatsapp_conversa(p_number, p_jid, CASE WHEN p_lid ~ '^\d{5,20}@lid$' THEN p_lid END, p_grupo, p_telefone, left(p_nome, 120));
    IF p_ultima IS NOT NULL THEN
      UPDATE whatsapp_chats
         SET last_message_at = least(p_ultima, now()),
             last_preview = coalesce(left(p_previa, 160), last_preview)
       WHERE id = v_chat AND (last_message_at IS NULL OR last_message_at < least(p_ultima, now()));
    END IF;
    RETURN v_chat;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_conversa_do_dono(uuid, text, text, boolean, text, text, timestamptz, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_conversa_do_dono(uuid, text, text, boolean, text, text, timestamptz, text) TO omni_app;
