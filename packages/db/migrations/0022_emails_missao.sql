-- 0022 · E-mails da missão (Fase 4, Outlook pelo Microsoft Graph).
--
-- * mail_mailboxes: caixas que o Omni lê, cadastradas pela administração. O
--   Exchange (grupo "Omni - Caixas") é quem libera de fato; uma caixa fora do
--   grupo fica com o erro registrado.
-- * mail_messages: um e-mail por internetMessageId (o mesmo e-mail em várias
--   caixas vira uma linha), só cabeçalho e prévia. O corpo NÃO é guardado: é
--   buscado no Graph quando alguém abre, e cada abertura fica registrada
--   (INSTRUCOES §13: registrar quem abriu cada e-mail).
-- * mail_message_copies: onde o e-mail está (caixa + id no Graph), para abrir e
--   para tirar quando sumir da caixa.
-- * mail_message_missions: vínculo com a missão e o motivo (número da missão,
--   proposta, NF ou domínio do cliente).
-- * Quem vê: diretoria e gerentes (INSTRUCOES §8, `canSeeMail`), só pelas
--   funções app.* abaixo; a tela não lê as tabelas.
-- * prisma_companies.email_domains: domínios de e-mail das empresas no Prisma,
--   para o vínculo por domínio.

ALTER TABLE prisma_companies ADD COLUMN email_domains text[] NOT NULL DEFAULT '{}';

CREATE TABLE mail_mailboxes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  added_by      uuid REFERENCES people(id),
  added_at      timestamptz NOT NULL DEFAULT now(),
  last_sync_at  timestamptz,
  last_error    text
);

CREATE TABLE mail_messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  internet_message_id  text NOT NULL UNIQUE,
  conversation_id      text,
  subject              text,
  from_name            text,
  from_address         citext,
  to_recipients        jsonb NOT NULL DEFAULT '[]',
  cc_recipients        jsonb NOT NULL DEFAULT '[]',
  received_at          timestamptz,
  sent_at              timestamptz,
  body_preview         text,
  has_attachments      boolean NOT NULL DEFAULT false,
  first_seen_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_messages_conversation ON mail_messages (conversation_id);

CREATE TABLE mail_message_copies (
  mailbox_id  uuid NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
  graph_id    text NOT NULL,
  message_id  uuid NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  folder      text NOT NULL CHECK (folder IN ('inbox', 'sentitems')),
  PRIMARY KEY (mailbox_id, graph_id)
);
CREATE INDEX mail_message_copies_message ON mail_message_copies (message_id);

CREATE TABLE mail_message_missions (
  message_id  uuid NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  mission_id  uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  motivo      text NOT NULL CHECK (motivo IN ('numero', 'proposta', 'nf', 'dominio')),
  detalhe     text NOT NULL,
  PRIMARY KEY (message_id, mission_id, motivo)
);
CREATE INDEX mail_message_missions_mission ON mail_message_missions (mission_id);

CREATE TABLE mail_message_views (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  uuid NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  viewed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_message_views_message ON mail_message_views (message_id, viewed_at DESC);

-- Worker escreve tudo; a tela: caixas só para quem administra; o resto só pelas funções.
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_mailboxes, mail_messages, mail_message_copies, mail_message_missions TO omni_worker;
GRANT SELECT ON mail_message_views TO omni_worker;
GRANT SELECT, INSERT, UPDATE ON mail_mailboxes TO omni_app;

ALTER TABLE mail_mailboxes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_message_copies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_message_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE mail_message_views    ENABLE ROW LEVEL SECURITY;

CREATE POLICY mailboxes_admin  ON mail_mailboxes FOR ALL TO omni_app USING (app.has_profile('admin')) WITH CHECK (app.has_profile('admin'));
CREATE POLICY mailboxes_worker ON mail_mailboxes        FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY messages_worker  ON mail_messages         FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY copies_worker    ON mail_message_copies   FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY links_worker     ON mail_message_missions FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY views_worker     ON mail_message_views    FOR SELECT TO omni_worker USING (true);

-- ---------------------------------------------------------------- funções

-- Quem vê os e-mails das missões (de todas as caixas autorizadas).
CREATE FUNCTION app.ve_emails() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT app.has_profile('diretoria') OR app.has_profile('gerente') $$;

-- E-mails ligados à missão, com os motivos; nada para quem não vê.
CREATE FUNCTION app.emails_da_missao(p_mission uuid)
  RETURNS TABLE (
    id uuid, conversation_id text, subject text, from_name text, from_address text,
    to_recipients jsonb, cc_recipients jsonb, received_at timestamptz, body_preview text,
    has_attachments boolean, motivos jsonb, aberto_por_mim boolean
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.conversation_id, m.subject, m.from_name, m.from_address::text,
           m.to_recipients, m.cc_recipients, coalesce(m.received_at, m.sent_at), m.body_preview,
           m.has_attachments,
           (SELECT jsonb_agg(jsonb_build_object('motivo', l.motivo, 'detalhe', l.detalhe) ORDER BY l.motivo)
              FROM mail_message_missions l WHERE l.message_id = m.id AND l.mission_id = p_mission),
           EXISTS (SELECT 1 FROM mail_message_views v WHERE v.message_id = m.id AND v.person_id = app.current_person_id())
      FROM mail_messages m
     WHERE app.ve_emails()
       AND EXISTS (SELECT 1 FROM mail_message_missions l WHERE l.message_id = m.id AND l.mission_id = p_mission)
     ORDER BY coalesce(m.received_at, m.sent_at) DESC
     LIMIT 500
  $$;

-- Abrir um e-mail: confere quem pode, registra a abertura e devolve onde buscá-lo no Graph.
CREATE FUNCTION app.abrir_email(p_message uuid)
  RETURNS TABLE (mailbox text, graph_id text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NOT app.ve_emails() OR NOT EXISTS (SELECT 1 FROM mail_message_missions WHERE message_id = p_message) THEN
      RETURN;
    END IF;
    INSERT INTO mail_message_views (message_id, person_id) VALUES (p_message, app.current_person_id());
    RETURN QUERY
      SELECT b.email::text, c.graph_id
        FROM mail_message_copies c JOIN mail_mailboxes b ON b.id = c.mailbox_id
       WHERE c.message_id = p_message AND b.active
       ORDER BY (c.folder = 'inbox') DESC
       LIMIT 1;
  END $$;

-- Quem abriu cada e-mail (para a diretoria e os gerentes).
CREATE FUNCTION app.leituras_email(p_message uuid)
  RETURNS TABLE (nome text, viewed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT p.display_name, v.viewed_at
      FROM mail_message_views v JOIN people p ON p.id = v.person_id
     WHERE app.ve_emails() AND v.message_id = p_message
     ORDER BY v.viewed_at DESC
     LIMIT 50
  $$;

GRANT EXECUTE ON FUNCTION app.ve_emails(), app.emails_da_missao(uuid), app.abrir_email(uuid), app.leituras_email(uuid) TO omni_app;
