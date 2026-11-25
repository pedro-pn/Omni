-- Avisos das tarefas por e-mail e resumo semanal (porta dos e-mails do Foco;
-- aprovado em 10/11/2026). Saem de uma caixa remetente do Omni pelo Microsoft
-- 365, seguindo EMAIL_ENVIO (fora da produção: ensaio, montado e não enviado).
--
-- * email_preferences: o que cada pessoa quer por e-mail (sem linha = padrão).
-- * notifications.email_status: o worker marca cada aviso como incluído num
--   e-mail ('enviado'/'ensaio') ou fora dele ('ignorado': lido antes, tipo sem
--   e-mail ou preferência desligada). Um aviso nunca entra em dois e-mails.
-- * notification_emails: o que foi montado e enviado (só o worker; a tela não lê).

CREATE TABLE email_preferences (
  person_id       uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  lembretes       boolean NOT NULL DEFAULT true,
  atribuicoes     boolean NOT NULL DEFAULT true,
  mencoes         boolean NOT NULL DEFAULT true,
  comentarios     boolean NOT NULL DEFAULT true,
  concluidas      boolean NOT NULL DEFAULT false,
  resumo_semanal  boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON email_preferences TO omni_app;
GRANT SELECT ON email_preferences TO omni_worker;
ALTER TABLE email_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_prefs_propria ON email_preferences FOR ALL TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
CREATE POLICY email_prefs_worker ON email_preferences FOR SELECT TO omni_worker USING (true);

ALTER TABLE notifications
  ADD COLUMN email_status text CHECK (email_status IN ('enviado', 'ensaio', 'ignorado')),
  ADD COLUMN emailed_at   timestamptz;
GRANT UPDATE (email_status, emailed_at) ON notifications TO omni_worker;
CREATE INDEX notifications_email_fila ON notifications (created_at) WHERE email_status IS NULL;

CREATE TABLE notification_emails (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('avisos', 'semanal_atrasadas', 'semanal_semana')),
  to_address        text NOT NULL,
  subject           text NOT NULL,
  notification_ids  uuid[] NOT NULL DEFAULT '{}',
  task_count        integer NOT NULL DEFAULT 0,
  mode              text NOT NULL CHECK (mode IN ('ensaio', 'real')),
  status            text NOT NULL CHECK (status IN ('ensaio', 'enviado', 'falhou')),
  error             text,
  dedupe_key        text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON notification_emails TO omni_worker;
ALTER TABLE notification_emails ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_emails_worker ON notification_emails FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE INDEX notification_emails_person ON notification_emails (person_id, created_at DESC);
