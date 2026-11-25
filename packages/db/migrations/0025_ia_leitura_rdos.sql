-- 0025 · IA v2 (Fase 8): leitura diária dos RDOs pelo LLM (ADR 0005).
--
-- * llm_calls: cada chamada ao modelo, só metadados (finalidade, modelo,
--   tokens, duração, resultado e os ids dos dados enviados) — nunca o texto
--   (PLANEJAMENTO §10: registrar metadados, não o conteúdo, por padrão).
-- * rdo_analyses: uma leitura por RDO (não lê duas vezes), com os pontos
--   achados e a versão das instruções; vira pergunta no Interno quando há ponto.
-- Só o worker escreve; leitura dos custos para quem administra.

CREATE TABLE llm_calls (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose        text NOT NULL,
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  duration_ms    integer,
  outcome        text NOT NULL CHECK (outcome IN ('ok', 'erro')),
  error_code     text,
  mission_id     uuid REFERENCES missions(id) ON DELETE SET NULL,
  data_ids       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_calls_created ON llm_calls (created_at DESC);

CREATE TABLE rdo_analyses (
  report_id       text PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
  mission_id      uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  prompt_version  text NOT NULL,
  model           text,
  points          jsonb NOT NULL DEFAULT '[]',
  question_id     uuid REFERENCES ai_questions(id) ON DELETE SET NULL,
  llm_call_id     uuid REFERENCES llm_calls(id) ON DELETE SET NULL,
  analyzed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rdo_analyses_mission ON rdo_analyses (mission_id, analyzed_at DESC);

GRANT SELECT, INSERT, UPDATE ON llm_calls, rdo_analyses TO omni_worker;
GRANT SELECT ON llm_calls TO omni_app;
ALTER TABLE llm_calls    ENABLE ROW LEVEL SECURITY;
ALTER TABLE rdo_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY llm_calls_worker    ON llm_calls    FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY rdo_analyses_worker ON rdo_analyses FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY llm_calls_admin     ON llm_calls    FOR SELECT TO omni_app USING (app.has_profile('admin'));
