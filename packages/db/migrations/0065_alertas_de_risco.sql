-- Alertas de risco (16/11/2026; Fase 11 do planejamento): volume fora do comum de
-- downloads de arquivos ou de arquivos enviados para fora da empresa, por pessoa.
-- O web registra cada download intencional em audit_log ("arquivo.baixado"); o
-- worker (job `riscos`) soma por pessoa, grava o alerta aqui e avisa no sino quem
-- administra (perfis admin e diretoria). Regras em packages/core/src/riscos.ts.

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete', 'tarefa_mencao', 'tarefa_reacao',
                  'ia_alerta', 'ia_pergunta', 'teste_push', 'chamada_perdida', 'risco'));

CREATE TABLE risk_alerts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('downloads_em_massa', 'envio_para_fora')),
  person_id     uuid NOT NULL REFERENCES people(id),
  -- Um alerta por pessoa, tipo e hora (o job roda a cada 10 min e não repete).
  window_start  timestamptz NOT NULL,
  reason        text NOT NULL,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid REFERENCES people(id),
  UNIQUE (kind, person_id, window_start)
);
CREATE INDEX risk_alerts_recentes ON risk_alerts (created_at DESC);

ALTER TABLE risk_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY risk_select ON risk_alerts FOR SELECT TO omni_app USING (app.has_profile('admin') OR app.has_profile('diretoria'));
CREATE POLICY risk_review ON risk_alerts FOR UPDATE TO omni_app
  USING (app.has_profile('admin') OR app.has_profile('diretoria'))
  WITH CHECK (reviewed_by = app.current_person_id());
GRANT SELECT ON risk_alerts TO omni_app;
GRANT UPDATE (reviewed_at, reviewed_by) ON risk_alerts TO omni_app;
CREATE POLICY risk_worker ON risk_alerts FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON risk_alerts TO omni_worker;

-- O worker lê só os downloads registrados e o necessário dos envios (sem textos nem conteúdo).
CREATE POLICY audit_worker_downloads ON audit_log FOR SELECT TO omni_worker USING (action = 'arquivo.baixado');
GRANT SELECT (person_id, to_recipients, cc_recipients, bcc_recipients, attachments, mode, status, created_at) ON mail_outbox TO omni_worker;
CREATE POLICY outbox_worker_riscos ON mail_outbox FOR SELECT TO omni_worker USING (true);
GRANT SELECT (person_id, file_size, mode, status, created_at) ON whatsapp_outbox TO omni_worker;
CREATE POLICY wa_outbox_worker_riscos ON whatsapp_outbox FOR SELECT TO omni_worker USING (true);
