-- Resumo das ligações só sob pedido (decisão de 10/11/2026): nada vai à OpenAI
-- sem o dono da gravação clicar em "Resumir com IA". O worker só processa as
-- ligações marcadas como 'pendente' por esta função.

CREATE FUNCTION app.pedir_resumo_chamada(p_call uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app.chamada_dono(p_call) THEN RETURN false; END IF;
  UPDATE whatsapp_calls
     SET summary_status = 'pendente', summary_attempts = 0
   WHERE id = p_call AND audio AND deleted_at IS NULL AND ended_at IS NOT NULL AND expires_at > now()
     AND (summary_status IS NULL OR summary_status = 'erro');
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.pedir_resumo_chamada(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.pedir_resumo_chamada(uuid) TO omni_app;
