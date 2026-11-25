-- 0006 · IA do ciclo da missão (Fase 5) e cópia de leitura dos relatórios do filtroAPP.
--
-- * reports: RDOs e relatórios técnicos (filtroAPP /rdo/relatorios, todos os
--   estados). Só o worker escreve.
-- * ai_questions: perguntas da IA. O worker agenda (horário útil já calculado)
--   e publica no canal Interno; quem vê o canal responde pelos botões.
-- * ai_deviations: desvios que a IA abre na Qualidade do filtroAPP. A tela grava
--   o pedido; o worker envia (ou só registra, no modo de ensaio).

-- ---------------------------------------------------------------- relatórios

CREATE TABLE reports (
  id                    text PRIMARY KEY,               -- id do filtroAPP
  mission_id            uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  report_type           text NOT NULL,                  -- RDO, RTP, RLQ, RCPU, RLM, RLF, RLI, RDO_MAINTENANCE…
  report_number         text,
  sequence_number       integer,
  status                text NOT NULL CHECK (status IN ('PENDING', 'RETURNED', 'APPROVED', 'SIGNED')),
  report_date           date NOT NULL,
  worked_minutes        integer,
  overtime_minutes      integer,
  daily_description     text,
  overtime_reason       text,
  submitted_at          timestamptz,
  approved_at           timestamptz,
  returned_at           timestamptz,
  signed_at             timestamptz,
  client_released_at    timestamptz,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_mission_date ON reports (mission_id, report_type, report_date DESC);

GRANT SELECT ON reports TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON reports TO omni_worker;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY reports_select ON reports FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY reports_worker ON reports FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- Cursor opaco do feed /eventos do filtroAPP.
ALTER TABLE sync_state ADD COLUMN cursor text;

-- ---------------------------------------------------------------- mensagens da IA

ALTER TABLE mission_messages DROP CONSTRAINT mission_messages_kind_check;
ALTER TABLE mission_messages ADD CONSTRAINT mission_messages_kind_check CHECK (kind IN ('texto', 'sistema', 'ia'));

-- ---------------------------------------------------------------- perguntas

CREATE TABLE ai_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id    uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  flow          text NOT NULL,                          -- ver @omni/core FLUXOS_IA
  dedupe_key    text NOT NULL UNIQUE,                   -- impede perguntar duas vezes a mesma coisa
  due_at        timestamptz NOT NULL,                   -- já dentro da janela útil
  status        text NOT NULL DEFAULT 'agendada'
                CHECK (status IN ('agendada', 'enviada', 'respondida', 'cancelada')),
  addressed_to  jsonb NOT NULL,                         -- {"papel":"LEADER"} ou {"funcao":"qualidade"}
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,     -- contexto (datas, número do RDO…)
  motivo_data   text,                                   -- por que nesta data (mostrado na agenda)
  message_id    uuid REFERENCES mission_messages(id),
  answer        jsonb,
  answered_by   uuid REFERENCES people(id),
  answered_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER ai_questions_updated_at BEFORE UPDATE ON ai_questions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE INDEX ai_questions_due ON ai_questions (status, due_at);
CREATE INDEX ai_questions_mission ON ai_questions (mission_id, created_at DESC);

-- Responder: só quem vê o canal Interno, só pergunta já enviada e ainda aberta,
-- sempre em nome próprio. O status final é conferido no CHECK da política.
CREATE FUNCTION app.pode_responder(p_question uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM ai_questions q
      WHERE q.id = p_question AND q.status = 'enviada'
        AND app.canal_desde(q.mission_id, 'interno') IS NOT NULL
    )
  $$;
GRANT EXECUTE ON FUNCTION app.pode_responder(uuid) TO omni_app;

GRANT SELECT ON ai_questions TO omni_app;
GRANT UPDATE (status, answer, answered_by, answered_at) ON ai_questions TO omni_app;
GRANT SELECT, INSERT, UPDATE ON ai_questions TO omni_worker;
ALTER TABLE ai_questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY questions_select ON ai_questions FOR SELECT TO omni_app
  USING (app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY questions_answer ON ai_questions FOR UPDATE TO omni_app
  USING (app.pode_responder(id))
  WITH CHECK (status = 'respondida' AND answered_by = app.current_person_id() AND answer IS NOT NULL);
CREATE POLICY questions_worker ON ai_questions FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- desvios

CREATE TABLE ai_deviations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id       uuid NOT NULL UNIQUE REFERENCES ai_questions(id),
  mission_id        uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  idempotency_key   uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  request           jsonb NOT NULL,                     -- corpo do POST /qualidade/registros
  status            text NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'enviado', 'ensaio', 'falhou')),
  filtroapp_id      text,
  filtroapp_number  text,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  created_by        uuid NOT NULL REFERENCES people(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);
CREATE INDEX ai_deviations_pending ON ai_deviations (status) WHERE status IN ('pendente', 'falhou');

GRANT SELECT, INSERT ON ai_deviations TO omni_app;
GRANT SELECT, UPDATE ON ai_deviations TO omni_worker;
ALTER TABLE ai_deviations ENABLE ROW LEVEL SECURITY;

CREATE POLICY deviations_select ON ai_deviations FOR SELECT TO omni_app
  USING (app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY deviations_insert ON ai_deviations FOR INSERT TO omni_app
  WITH CHECK (created_by = app.current_person_id() AND status = 'pendente'
              AND app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY deviations_worker ON ai_deviations FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- Worker publica mensagens da IA e de sistema (author NULL) e lê as pessoas das funções.
DROP POLICY messages_worker_insert ON mission_messages;
CREATE POLICY messages_worker_insert ON mission_messages FOR INSERT TO omni_worker
  WITH CHECK (author_person_id IS NULL AND kind IN ('ia', 'sistema'));
GRANT SELECT ON mission_responsibles, missions TO omni_worker;
