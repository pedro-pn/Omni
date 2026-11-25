-- 0026 · Reuniões do Teams ligadas à missão (Fases 4 e 8).
--
-- * meetings: um evento por iCalUId (a mesma reunião em várias agendas vira uma
--   linha), guardado só se ligado a alguma missão (mesmas regras dos e-mails).
--   A transcrição NÃO é guardada: só a situação dela e o resumo feito pelo LLM.
-- * meeting_copies: em qual caixa a reunião foi vista (para tirar quando sumir).
-- * meeting_missions: vínculo com a missão e o motivo.
-- * Quem vê: diretoria e gerentes (mesma regra dos e-mails, app.ve_emails),
--   pela função app.reunioes_da_missao. O resumo também vai para o Interno.

CREATE TABLE meetings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ical_uid            text NOT NULL UNIQUE,
  subject             text,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  organizer_name      text,
  organizer_address   citext,
  attendees           jsonb NOT NULL DEFAULT '[]',
  join_url            text,
  body_preview        text,
  online_meeting_id   text,
  organizer_user_id   text,
  transcript_status   text NOT NULL DEFAULT 'pendente'
                      CHECK (transcript_status IN ('pendente', 'sem_link', 'sem_transcricao', 'sem_acesso', 'acesso_desligado', 'disponivel', 'resumida', 'erro')),
  transcript_attempts integer NOT NULL DEFAULT 0,
  transcript_checked_at timestamptz,
  summary             jsonb,
  summary_model       text,
  summarized_at       timestamptz,
  summary_posted_at   timestamptz,
  first_seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_transcript ON meetings (transcript_status, ends_at);

CREATE TABLE meeting_copies (
  mailbox_id  uuid NOT NULL REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
  event_id    text NOT NULL,
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  PRIMARY KEY (mailbox_id, event_id)
);
CREATE INDEX meeting_copies_meeting ON meeting_copies (meeting_id);

CREATE TABLE meeting_missions (
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  mission_id  uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  motivo      text NOT NULL CHECK (motivo IN ('numero', 'proposta', 'nf', 'dominio')),
  detalhe     text NOT NULL,
  PRIMARY KEY (meeting_id, mission_id, motivo)
);
CREATE INDEX meeting_missions_mission ON meeting_missions (mission_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON meetings, meeting_copies, meeting_missions TO omni_worker;
ALTER TABLE meetings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_copies   ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_missions ENABLE ROW LEVEL SECURITY;
CREATE POLICY meetings_worker ON meetings         FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY mcopies_worker  ON meeting_copies   FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY mlinks_worker   ON meeting_missions FOR ALL TO omni_worker USING (true) WITH CHECK (true);

CREATE FUNCTION app.reunioes_da_missao(p_mission uuid)
  RETURNS TABLE (
    id uuid, subject text, starts_at timestamptz, ends_at timestamptz, organizer_name text, organizer_address text,
    attendees jsonb, join_url text, transcript_status text, summary jsonb, summarized_at timestamptz, motivos jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id, m.subject, m.starts_at, m.ends_at, m.organizer_name, m.organizer_address::text, m.attendees, m.join_url,
           m.transcript_status, m.summary, m.summarized_at,
           (SELECT jsonb_agg(jsonb_build_object('motivo', l.motivo, 'detalhe', l.detalhe) ORDER BY l.motivo)
              FROM meeting_missions l WHERE l.meeting_id = m.id AND l.mission_id = p_mission)
      FROM meetings m
     WHERE app.ve_emails() AND EXISTS (SELECT 1 FROM meeting_missions l WHERE l.meeting_id = m.id AND l.mission_id = p_mission)
     ORDER BY m.starts_at DESC
     LIMIT 200
  $$;
GRANT EXECUTE ON FUNCTION app.reunioes_da_missao(uuid) TO omni_app;
