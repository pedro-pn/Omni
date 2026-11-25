-- Teto diário de gasto da IA (25/11/2026; E11, pilar 10.2). Antes de cada chamada ao modelo, o web
-- e o worker conferem o gasto do dia (horário de Brasília) em llm_calls e param no teto
-- (packages/core/src/ia/teto.ts). O web passa a registrar as próprias chamadas (alertas pedidos à
-- IA), que até aqui não entravam em llm_calls.

CREATE FUNCTION app.gasto_ia_hoje(OUT tokens bigint, OUT chamadas bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(input_tokens + output_tokens), 0)::bigint, count(*)::bigint
    FROM llm_calls
   WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo');
$$;
REVOKE ALL ON FUNCTION app.gasto_ia_hoje() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.gasto_ia_hoje() TO omni_app, omni_worker;

-- Só metadados, como no worker (finalidade, modelo, tokens, duração, resultado); nunca o texto.
CREATE FUNCTION app.registrar_chamada_llm(
  p_purpose text, p_model text, p_input_tokens integer, p_output_tokens integer, p_duration_ms integer, p_outcome text, p_error_code text
) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO llm_calls (purpose, model, input_tokens, output_tokens, duration_ms, outcome, error_code)
  VALUES (left(p_purpose, 60), left(p_model, 80), greatest(coalesce(p_input_tokens, 0), 0), greatest(coalesce(p_output_tokens, 0), 0),
          p_duration_ms, p_outcome, left(p_error_code, 60));
$$;
REVOKE ALL ON FUNCTION app.registrar_chamada_llm(text, text, integer, integer, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.registrar_chamada_llm(text, text, integer, integer, integer, text, text) TO omni_app;
