-- Caixa única, fase 1 (17/11/2026): e-mail e WhatsApp juntos por contato.
--   1. Agenda da empresa: contatos com vários e-mails e telefones; cada e-mail ou
--      telefone pertence a um contato só (é o que liga o e-mail ao número).
--      Quem tem perfil no Omni lê e edita; fica quem cadastrou. Contato do celular
--      de alguém NÃO entra sozinho aqui (o WhatsApp de cada um é privado).
--   2. Cabeçalho dos e-mails da caixa PESSOAL (Entrada e Enviados): remetente,
--      destinatários, assunto, prévia, data, lido — só o dono vê; o corpo continua
--      lido na hora no Microsoft 365. Caixas de setor não entram.
--   3. Aviso de e-mail novo no celular (como o WhatsApp), com preferência própria.

CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  company            text CHECK (length(company) <= 160),
  role               text CHECK (length(role) <= 120),
  prisma_contact_id  text,
  created_by         uuid REFERENCES people(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE contact_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('email', 'telefone')),
  value       text NOT NULL,
  created_by  uuid REFERENCES people(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value),
  CHECK (
    (kind = 'email' AND value = lower(value) AND value ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
    OR (kind = 'telefone' AND value ~ '^\d{10,15}$')
  )
);
CREATE INDEX contact_identities_contato ON contact_identities (contact_id);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
CREATE POLICY contacts_agenda ON contacts FOR ALL TO omni_app
  USING (app.has_any_profile()) WITH CHECK (app.has_any_profile());
CREATE POLICY identities_agenda ON contact_identities FOR ALL TO omni_app
  USING (app.has_any_profile()) WITH CHECK (app.has_any_profile());
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts, contact_identities TO omni_app;
CREATE POLICY contacts_worker ON contacts FOR SELECT TO omni_worker USING (true);
CREATE POLICY identities_worker ON contact_identities FOR SELECT TO omni_worker USING (true);
GRANT SELECT ON contacts, contact_identities TO omni_worker;

CREATE TABLE mail_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mailbox_id           uuid NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
  owner_person_id      uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  graph_id             text NOT NULL,
  internet_message_id  text,
  conversation_id      text,
  folder               text NOT NULL CHECK (folder IN ('inbox', 'sentitems')),
  from_name            text,
  from_address         text,
  to_recipients        jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_recipients        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Todos os endereços do e-mail (de, para, cc), em minúsculas: liga ao contato.
  addresses            text[] NOT NULL DEFAULT '{}',
  subject              text,
  preview              text CHECK (length(preview) <= 300),
  received_at          timestamptz,
  sent_at              timestamptz,
  is_read              boolean NOT NULL DEFAULT true,
  has_attachments      boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, graph_id)
);
CREATE INDEX mail_items_dono ON mail_items (owner_person_id, received_at DESC);
CREATE INDEX mail_items_enderecos ON mail_items USING gin (addresses);

ALTER TABLE mail_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY mail_items_dono ON mail_items FOR SELECT TO omni_app USING (owner_person_id = app.current_person_id());
GRANT SELECT ON mail_items TO omni_app;
CREATE POLICY mail_items_worker ON mail_items FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_items TO omni_worker;

-- Aviso de e-mail novo (só o recém-chegado: a releitura da janela de 90 dias não avisa).
CREATE FUNCTION app.avisar_email_novo() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.folder = 'inbox' AND NOT NEW.is_read AND coalesce(NEW.received_at, now()) > now() - interval '30 minutes' THEN
    PERFORM pg_notify('omni_email', json_build_object('personId', NEW.owner_person_id, 'itemId', NEW.id)::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mail_items_avisar AFTER INSERT ON mail_items FOR EACH ROW EXECUTE FUNCTION app.avisar_email_novo();

ALTER TABLE push_preferences ADD COLUMN email boolean NOT NULL DEFAULT true;

-- Relê a janela de 90 dias das caixas (para preencher os cabeçalhos); as gravações são idempotentes.
DELETE FROM sync_state WHERE source = 'graph' AND resource LIKE 'mail:%';
