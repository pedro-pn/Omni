-- 0032 · Web Push: o aparelho (endpoint) é de quem está logado agora.
-- O mesmo navegador pode ser usado por duas pessoas; ao ativar as notificações,
-- a inscrição passa para quem ativou (a anterior deixa de receber neste aparelho),
-- para ninguém ver avisos de outra pessoa.
CREATE FUNCTION app.registrar_push(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF app.current_person_id() IS NULL THEN RAISE EXCEPTION 'Sessão expirada'; END IF;
    INSERT INTO push_subscriptions (person_id, endpoint, p256dh, auth, user_agent)
         VALUES (app.current_person_id(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
    ON CONFLICT (endpoint) DO UPDATE
         SET person_id = EXCLUDED.person_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent, failures = 0, created_at = now();
  END $$;
GRANT EXECUTE ON FUNCTION app.registrar_push(text, text, text, text) TO omni_app;
