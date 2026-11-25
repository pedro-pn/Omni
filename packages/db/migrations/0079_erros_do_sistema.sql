-- Erros do sistema (25/11/2026; E09, pilar 12.1): todo erro inesperado do web e do worker, e os
-- problemas da operação (backup e ensaio de restauração), agrupados por assinatura. O worker
-- (job `alertas-erros`) avisa no sino e no celular quem tem o perfil admin. Textos já chegam
-- limpos (packages/core/src/erros.ts: sem e-mail, CPF, telefone, token nem query string).

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete', 'tarefa_mencao', 'tarefa_reacao',
                  'ia_alerta', 'ia_pergunta', 'teste_push', 'chamada_perdida', 'risco', 'erro_sistema'));

CREATE TABLE system_errors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Agrupa ocorrências iguais (origem, nome, local e o ponto no código ou a mensagem sem números).
  fingerprint  text NOT NULL UNIQUE CHECK (length(fingerprint) <= 400),
  source       text NOT NULL CHECK (source IN ('web', 'worker', 'operacao')),
  name         text NOT NULL CHECK (length(name) <= 80),
  message      text NOT NULL CHECK (length(message) <= 500),
  detail       text CHECK (length(detail) <= 4000),
  location     text NOT NULL CHECK (length(location) <= 200),
  version      text CHECK (length(version) <= 64),
  occurrences  integer NOT NULL DEFAULT 1,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  alerted_at   timestamptz,
  reviewed_at  timestamptz,
  reviewed_by  uuid REFERENCES people(id)
);
CREATE INDEX system_errors_recentes ON system_errors (last_seen DESC);

ALTER TABLE system_errors ENABLE ROW LEVEL SECURITY;
-- Só quem administra vê e marca como visto (é dado técnico, não de negócio).
CREATE POLICY erros_select ON system_errors FOR SELECT TO omni_app USING (app.has_profile('admin'));
CREATE POLICY erros_review ON system_errors FOR UPDATE TO omni_app
  USING (app.has_profile('admin'))
  WITH CHECK (reviewed_by = app.current_person_id());
GRANT SELECT ON system_errors TO omni_app;
GRANT UPDATE (reviewed_at, reviewed_by) ON system_errors TO omni_app;
-- O worker avisa (alerted_at) e limpa os antigos já vistos; grava pela função abaixo.
CREATE POLICY erros_worker ON system_errors FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE (alerted_at), DELETE ON system_errors TO omni_worker;

-- Registro (web e worker): soma a ocorrência e reabre o que já tinha sido visto. SECURITY DEFINER
-- porque o web grava erros de quem não tem perfil admin e não lê a tabela.
CREATE FUNCTION app.registrar_erro(
  p_fingerprint text, p_source text, p_name text, p_message text, p_detail text, p_location text, p_version text
) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO system_errors (fingerprint, source, name, message, detail, location, version)
  VALUES (left(p_fingerprint, 400), p_source, left(p_name, 80), left(p_message, 500), left(p_detail, 4000), left(p_location, 200), left(p_version, 64))
  ON CONFLICT (fingerprint) DO UPDATE
    SET occurrences = system_errors.occurrences + 1,
        last_seen = now(),
        message = excluded.message,
        detail = excluded.detail,
        version = excluded.version,
        reviewed_at = NULL,
        reviewed_by = NULL;
$$;
REVOKE ALL ON FUNCTION app.registrar_erro(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.registrar_erro(text, text, text, text, text, text, text) TO omni_app, omni_worker;
