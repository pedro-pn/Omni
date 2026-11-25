-- 0029 · Arquivos do WhatsApp: o servidor do Omni baixa a mídia na Evolution
-- para quem lê a conversa (inclusive pela missão, sem ver o número). A função
-- confere app.ve_conversa_whatsapp e devolve só o necessário para buscar o arquivo.

CREATE FUNCTION app.midia_whatsapp(p_message uuid)
  RETURNS TABLE (instancia text, wa_id text, tipo text, arquivo text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT n.instance_name, m.wa_id, m.kind, m.file_name
      FROM whatsapp_messages m
      JOIN whatsapp_chats c ON c.id = m.chat_id
      JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE m.id = p_message
       AND m.kind IN ('imagem', 'video', 'audio', 'documento', 'figurinha')
       AND n.status <> 'removido'
       AND app.ve_conversa_whatsapp(c.id)
  $$;
GRANT EXECUTE ON FUNCTION app.midia_whatsapp(uuid) TO omni_app;
