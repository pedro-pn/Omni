-- Fase 6 do Prisma (contrato 1.67.0): participantes do cliente vão para o Prisma
-- e ligações/e-mails viram feedback, sempre em nome de quem clicou (token PKCE
-- da pessoa). A tela não lê as tabelas copiadas do Prisma: a função abaixo
-- devolve só a missão do Prisma e as empresas do cliente, para quem vê o Interno.

CREATE FUNCTION app.prisma_da_missao(p_mission uuid)
  RETURNS TABLE (prisma_mission_id text, company_id text, company_name text, email_domains text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT pm.id, c.id, c.name, c.email_domains
      FROM prisma_mission_links l
      JOIN prisma_missions pm ON pm.id = l.prisma_mission_id AND pm.deleted_at IS NULL
      LEFT JOIN prisma_companies c ON c.id = ANY (pm.company_ids) AND c.deleted_at IS NULL
     WHERE l.mission_id = p_mission AND app.ve_interno(p_mission, app.current_person_id())
  $$;
REVOKE ALL ON FUNCTION app.prisma_da_missao(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prisma_da_missao(uuid) TO omni_app;

-- Participante enviado ao Prisma (contato e vínculo com a missão).
ALTER TABLE mission_participant_notes
  ADD COLUMN prisma_contact_id   text,
  ADD COLUMN prisma_vinculado_em timestamptz;

-- O que cada pessoa registrou como feedback no Prisma (só ela vê os seus).
CREATE TABLE prisma_feedback_log (
  chave        uuid PRIMARY KEY,
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  origem       text NOT NULL CHECK (origem IN ('chamada', 'email')),
  origem_id    text NOT NULL,
  prisma_id    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, origem, origem_id)
);
GRANT SELECT, INSERT ON prisma_feedback_log TO omni_app;
ALTER TABLE prisma_feedback_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY prisma_feedback_proprio ON prisma_feedback_log FOR ALL TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
