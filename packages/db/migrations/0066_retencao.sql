-- Retenção por tipo de dado (16/11/2026; Fase 11 do planejamento). Só dados técnicos,
-- com prazos alinhados à tabela do filtroAPP (logs técnicos 365 dias, IP e navegador
-- anonimizados após 2 anos). Dados de negócio (mensagens, WhatsApp, e-mails, reuniões)
-- ficam de fora até a decisão dos prazos (docs/producao/lgpd-ropa-dpa.md).
--
-- O job `retencao` do worker chama app.aplicar_retencao(false) em ensaio (só conta)
-- ou (true) com RETENCAO=real. Todos os prazos ficam aqui, num lugar só.

-- A auditoria continua só de inserção; a única exceção é a retenção apagar os
-- registros de download vencidos (só o dono do banco apaga: ninguém tem DELETE).
CREATE OR REPLACE FUNCTION app.audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('omni.retencao', true) = 'on' AND OLD.action = 'arquivo.baixado' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log é somente inserção';
END $$;

CREATE FUNCTION app.aplicar_retencao(p_aplicar boolean) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  r jsonb := '{}'::jsonb;
  n bigint;
BEGIN
  -- Sessões encerradas (expiradas ou revogadas) há mais de 30 dias.
  IF p_aplicar THEN
    DELETE FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days';
  END IF;
  r := r || jsonb_build_object('sessoes', n);

  -- Avisos do sino: lidos há mais de 180 dias; qualquer um com mais de 1 ano.
  IF p_aplicar THEN
    DELETE FROM notifications WHERE (read_at IS NOT NULL AND created_at < now() - interval '180 days') OR created_at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM notifications WHERE (read_at IS NOT NULL AND created_at < now() - interval '180 days') OR created_at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('avisos', n);

  -- Registro dos e-mails de aviso e das chamadas à IA (metadados): 1 ano.
  IF p_aplicar THEN
    DELETE FROM notification_emails WHERE created_at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM notification_emails WHERE created_at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('emails_de_aviso', n);
  IF p_aplicar THEN
    DELETE FROM llm_calls WHERE created_at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM llm_calls WHERE created_at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('chamadas_ia', n);

  -- Registro de downloads (alertas de risco): 1 ano.
  IF p_aplicar THEN
    PERFORM set_config('omni.retencao', 'on', true);
    DELETE FROM audit_log WHERE action = 'arquivo.baixado' AND at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('omni.retencao', 'off', true);
  ELSE
    SELECT count(*) INTO n FROM audit_log WHERE action = 'arquivo.baixado' AND at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('downloads', n);

  -- Alertas de risco: 2 anos.
  IF p_aplicar THEN
    DELETE FROM risk_alerts WHERE created_at < now() - interval '2 years';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM risk_alerts WHERE created_at < now() - interval '2 years';
  END IF;
  r := r || jsonb_build_object('alertas_de_risco', n);

  -- Termo aceito: IP e navegador anonimizados depois de 2 anos (a prova do aceite fica).
  IF p_aplicar THEN
    UPDATE terms_acceptances SET ip = NULL, user_agent = NULL WHERE aceito_em < now() - interval '2 years' AND (ip IS NOT NULL OR user_agent IS NOT NULL);
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM terms_acceptances WHERE aceito_em < now() - interval '2 years' AND (ip IS NOT NULL OR user_agent IS NOT NULL);
  END IF;
  r := r || jsonb_build_object('termos_anonimizados', n);

  RETURN r || jsonb_build_object('aplicado', p_aplicar);
END $$;
REVOKE ALL ON FUNCTION app.aplicar_retencao(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aplicar_retencao(boolean) TO omni_worker;
