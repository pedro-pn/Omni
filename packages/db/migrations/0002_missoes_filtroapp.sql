-- 0002 · Missões (espelho de leitura do filtroAPP), estado das sincronizações e
-- correção do last_login_at no primeiro login.
--
-- A verdade da missão é do filtroAPP (PLANEJAMENTO.md §4). Esta tabela é cache:
-- só o worker escreve; o web só lê, com RLS.

-- ---------------------------------------------------------------- login: grava last_login_at também no 1º acesso

CREATE OR REPLACE FUNCTION app.login(
  p_entra_oid     uuid,
  p_email         text,
  p_display_name  text,
  p_token_hash    bytea,
  p_ttl           interval,
  p_user_agent    text,
  p_ip            inet
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_person people%ROWTYPE;
BEGIN
  IF p_ttl <= interval '0' OR p_ttl > interval '30 days' THEN
    RAISE EXCEPTION 'Validade de sessão inválida';
  END IF;

  IF p_entra_oid IS NOT NULL THEN
    SELECT * INTO v_person FROM people WHERE entra_oid = p_entra_oid;
  END IF;
  IF v_person.id IS NULL THEN
    SELECT * INTO v_person FROM people WHERE email = p_email::citext;
    IF v_person.id IS NOT NULL AND v_person.entra_oid IS NOT NULL
       AND p_entra_oid IS DISTINCT FROM v_person.entra_oid THEN
      RAISE EXCEPTION 'E-mail já vinculado a outra conta Microsoft';
    END IF;
  END IF;

  IF v_person.id IS NULL THEN
    INSERT INTO people (entra_oid, email, display_name, last_login_at)
    VALUES (p_entra_oid, p_email, p_display_name, now())
    RETURNING * INTO v_person;
  ELSE
    IF NOT v_person.active THEN
      RAISE EXCEPTION 'Pessoa desativada';
    END IF;
    UPDATE people
       SET entra_oid = coalesce(entra_oid, p_entra_oid),
           display_name = coalesce(nullif(trim(p_display_name), ''), display_name),
           last_login_at = now()
     WHERE id = v_person.id;
  END IF;

  INSERT INTO sessions (token_hash, person_id, expires_at, user_agent, ip)
  VALUES (p_token_hash, v_person.id, now() + p_ttl, left(p_user_agent, 400), p_ip);

  INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
  VALUES (v_person.id, 'login', 'person', v_person.id::text,
          jsonb_build_object('via', CASE WHEN p_entra_oid IS NULL THEN 'dev' ELSE 'entra' END));

  RETURN v_person.id;
END $$;

UPDATE people p SET last_login_at = (
  SELECT max(a.at) FROM audit_log a WHERE a.action = 'login' AND a.actor_person_id = p.id
) WHERE p.last_login_at IS NULL;

-- ---------------------------------------------------------------- perfis

-- Tem pelo menos um perfil ativo? (pessoa recém-chegada, sem perfil, não vê dados)
CREATE FUNCTION app.has_any_profile() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM person_profiles pp
      JOIN people pe ON pe.id = pp.person_id
      WHERE pp.person_id = app.current_person_id() AND pe.active
    )
  $$;
GRANT EXECUTE ON FUNCTION app.has_any_profile() TO omni_app, omni_worker;

-- ---------------------------------------------------------------- missões

CREATE TABLE missions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                          text NOT NULL UNIQUE CHECK (code ~ '^\d{4}$'),
  filtroapp_project_id          text NOT NULL UNIQUE,
  -- /projetos
  client_name                   text NOT NULL,
  location                      text,
  client_segment                text,
  is_active                     boolean NOT NULL,
  mobilization_at               timestamptz,
  demobilization_at             timestamptz,
  started_at                    timestamptz,
  filtroapp_updated_at          timestamptz NOT NULL,
  project_synced_at             timestamptz NOT NULL DEFAULT now(),
  -- /efetivo/projetos/{id}/status (null = sem workflow no filtroAPP)
  workflow_started              boolean,
  stage                         text,
  workflow_version              integer,
  planned_mobilization_date     date,
  planned_execution_start_date  date,
  planned_execution_end_date    date,
  field_completion_date         date,
  demobilization_date           date,
  commercial_readiness          text,
  mobilization_ready            boolean,
  closure_ready                 boolean,
  open_issue_count              integer,
  critical_issue_count          integer,
  progress_percent              numeric(6, 2),
  progress_method               text,
  closed_at                     timestamptz,
  status_synced_at              timestamptz,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER missions_updated_at BEFORE UPDATE ON missions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE INDEX missions_active_stage ON missions (is_active, stage);

-- ---------------------------------------------------------------- sincronizações

CREATE TABLE sync_state (
  source           text NOT NULL,
  resource         text NOT NULL,
  watermark        timestamptz,            -- maior updatedAt já gravado (para updatedSince)
  last_success_at  timestamptz,
  last_full_at     timestamptz,            -- última reconciliação completa
  PRIMARY KEY (source, resource)
);

CREATE TABLE sync_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source       text NOT NULL,
  resource     text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'rodando' CHECK (status IN ('rodando', 'ok', 'erro')),
  items        integer,
  error        text
);
CREATE INDEX sync_runs_recent ON sync_runs (source, resource, started_at DESC);

-- ---------------------------------------------------------------- privilégios e RLS

GRANT SELECT ON missions TO omni_app;
GRANT SELECT, INSERT, UPDATE ON missions TO omni_worker;
GRANT SELECT ON sync_state, sync_runs TO omni_app;
GRANT SELECT, INSERT, UPDATE ON sync_state, sync_runs TO omni_worker;

ALTER TABLE missions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs  ENABLE ROW LEVEL SECURITY;

-- Lista de missões: qualquer pessoa com perfil no Omni. Canais Interno/Gerencial
-- terão regras próprias por membro (próxima migration).
CREATE POLICY missions_select ON missions FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY missions_worker ON missions FOR ALL TO omni_worker USING (true) WITH CHECK (true);

CREATE POLICY sync_state_select ON sync_state FOR SELECT TO omni_app USING (app.is_manager_of_settings());
CREATE POLICY sync_state_worker ON sync_state FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY sync_runs_select ON sync_runs FOR SELECT TO omni_app USING (app.is_manager_of_settings());
CREATE POLICY sync_runs_worker ON sync_runs FOR ALL TO omni_worker USING (true) WITH CHECK (true);
