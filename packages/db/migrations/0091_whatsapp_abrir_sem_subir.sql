-- Abrir uma conversa pelo Omni (Nova conversa, clicar numa marcação, "Conversar com…") não é
-- interação (26/11/2026): a conversa que já existe não sobe na lista. Só a conversa nova, sem
-- data nenhuma, ganha a hora de agora — para aparecer na lista e abrir.

CREATE FUNCTION app.whatsapp_abrir_conversa(p_number uuid, p_jid text, p_telefone text, p_nome text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid;
  BEGIN
    -- Confere o dono e o endereço (whatsapp_conversa_do_dono), sem mexer na data.
    v_chat := app.whatsapp_conversa_do_dono(p_number, p_jid, NULL, false, p_telefone, p_nome, NULL, NULL);
    UPDATE whatsapp_chats SET last_message_at = now() WHERE id = v_chat AND last_message_at IS NULL;
    RETURN v_chat;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_abrir_conversa(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_abrir_conversa(uuid, text, text, text) TO omni_app;

-- As conversas com pessoa que subiram só por terem sido abertas voltam à hora da última mensagem.
WITH ultima AS (
  SELECT c.id, max(m.sent_at) AS em
    FROM whatsapp_chats c JOIN whatsapp_messages m ON m.chat_id = c.id
   WHERE NOT c.is_group
   GROUP BY c.id, c.last_message_at
  HAVING c.last_message_at > max(m.sent_at) + interval '1 minute'
)
UPDATE whatsapp_chats c SET last_message_at = u.em FROM ultima u WHERE c.id = u.id;
