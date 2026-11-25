-- 0024 · Envio de e-mail pelo Omni (Fase 4).
--
-- * email_signatures: assinatura de cada pessoa (só a própria).
-- * mail_outbox: cada envio (inclusive os de ensaio), que é também a auditoria.
--   Só se envia da PRÓPRIA caixa, e ela precisa estar liberada no Omni
--   (`mail_mailboxes` ativa); quem enviou vê os seus, diretoria e gerentes veem todos.
-- * O modo (desligado | ensaio | real) é do servidor (EMAIL_ENVIO); fora da
--   produção só ensaio — o e-mail é montado e registrado, mas não sai.

CREATE TABLE email_signatures (
  person_id   uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  signature   text NOT NULL CHECK (length(signature) <= 2000),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mail_outbox (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL REFERENCES people(id),
  mission_id        uuid REFERENCES missions(id) ON DELETE SET NULL,
  from_address      citext NOT NULL,
  to_recipients     jsonb NOT NULL,
  cc_recipients     jsonb NOT NULL DEFAULT '[]',
  bcc_recipients    jsonb NOT NULL DEFAULT '[]',
  subject           text NOT NULL,
  body              text NOT NULL,
  reply_to_message  uuid REFERENCES mail_messages(id) ON DELETE SET NULL,
  mode              text NOT NULL CHECK (mode IN ('ensaio', 'real')),
  status            text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'ensaio', 'enviado', 'falhou')),
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);
CREATE INDEX mail_outbox_mission ON mail_outbox (mission_id, created_at DESC);

-- A caixa da pessoa atual, se estiver liberada no Omni (senão, nada).
CREATE FUNCTION app.minha_caixa_email() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT b.email::text FROM people p JOIN mail_mailboxes b ON b.email = p.email AND b.active
     WHERE p.id = app.current_person_id() AND p.active
  $$;

-- Id do e-mail na caixa da pessoa atual (para responder no mesmo fio), se ela tiver uma cópia.
CREATE FUNCTION app.copia_na_minha_caixa(p_message uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.graph_id FROM mail_message_copies c JOIN mail_mailboxes b ON b.id = c.mailbox_id
     WHERE c.message_id = p_message AND b.email::text = app.minha_caixa_email()
     ORDER BY (c.folder = 'inbox') DESC LIMIT 1
  $$;

GRANT SELECT, INSERT, UPDATE ON email_signatures TO omni_app;
GRANT SELECT, INSERT, UPDATE ON mail_outbox TO omni_app;
ALTER TABLE email_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_outbox      ENABLE ROW LEVEL SECURITY;

CREATE POLICY signatures_own ON email_signatures FOR ALL TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());

CREATE POLICY outbox_select ON mail_outbox FOR SELECT TO omni_app
  USING (person_id = app.current_person_id() OR app.ve_emails());
-- Só da própria caixa, liberada no Omni.
CREATE POLICY outbox_insert ON mail_outbox FOR INSERT TO omni_app
  WITH CHECK (person_id = app.current_person_id() AND from_address::text = app.minha_caixa_email());
CREATE POLICY outbox_update ON mail_outbox FOR UPDATE TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());

GRANT EXECUTE ON FUNCTION app.minha_caixa_email(), app.copia_na_minha_caixa(uuid) TO omni_app;
