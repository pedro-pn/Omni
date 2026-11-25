-- 0001 · Fundação: pessoas, perfis, funções, feriados, sessões e auditoria.
--
-- Regras:
--  * Roda como omni_owner (dono das tabelas). Donos não passam pelo RLS, por isso
--    o web e o worker usam omni_app/omni_worker, que nunca têm BYPASSRLS.
--  * A pessoa da requisição chega em `app.person_id` (set_config local à transação).
--  * Funções SECURITY DEFINER ficam no schema `app`, com search_path fixo e
--    EXECUTE revogado de PUBLIC.

CREATE SCHEMA app;
GRANT USAGE ON SCHEMA app TO omni_app, omni_worker;
GRANT USAGE ON SCHEMA public TO omni_app, omni_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE FUNCTION app.current_person_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.person_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app.current_person_id() TO omni_app, omni_worker;

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------- pessoas

CREATE TYPE perfil AS ENUM (
  'admin', 'diretoria', 'gerente', 'lider_projetos', 'vendas', 'marketing', 'supervisor', 'operacao'
);

CREATE TABLE people (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_oid          uuid UNIQUE,
  email              citext NOT NULL UNIQUE CHECK (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name       text NOT NULL CHECK (length(trim(display_name)) > 0),
  job_title          text,
  phone              text,
  active             boolean NOT NULL DEFAULT true,
  -- vínculos com os outros sistemas
  filtroapp_user_id  text UNIQUE,
  prisma_user_id     text UNIQUE,
  foco_user_id       uuid UNIQUE,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER people_updated_at BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE person_profiles (
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  profile     perfil NOT NULL,
  granted_by  uuid REFERENCES people(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, profile)
);

-- SECURITY DEFINER: lê person_profiles sem passar pelo RLS dela mesma (evita recursão).
CREATE FUNCTION app.has_profile(wanted perfil) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM person_profiles pp
      JOIN people pe ON pe.id = pp.person_id
      WHERE pp.person_id = app.current_person_id() AND pp.profile = wanted AND pe.active
    )
  $$;
GRANT EXECUTE ON FUNCTION app.has_profile(perfil) TO omni_app, omni_worker;

CREATE FUNCTION app.is_manager_of_settings() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT app.has_profile('admin') OR app.has_profile('diretoria') $$;
GRANT EXECUTE ON FUNCTION app.is_manager_of_settings() TO omni_app, omni_worker;

-- ---------------------------------------------------------------- funções da empresa

CREATE TABLE functions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO functions (code, name, description) VALUES
  ('qualidade',               'Qualidade',                  'Recebe todo desvio aberto pela IA'),
  ('documentacao',            'Documentação',               'Documentos de colaboradores e liberação no cliente'),
  ('coordenacao_mobilizacao', 'Coordenação de mobilização', 'Conduz equipe e equipamentos na mobilização'),
  ('medicao',                 'Medição',                    'Mede o término dos serviços'),
  ('faturamento',             'Faturamento',                'Emite NF e fecha a missão no Omie'),
  ('gerente_comercial',       'Gerente comercial',          'Recebe o saldo não medido');

CREATE TABLE function_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_code  text NOT NULL REFERENCES functions(code),
  person_id      uuid NOT NULL REFERENCES people(id),
  starts_on      date NOT NULL DEFAULT current_date,
  ends_on        date,
  is_substitute  boolean NOT NULL DEFAULT false,
  created_by     uuid REFERENCES people(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX function_assignments_lookup ON function_assignments (function_code, starts_on);

-- ---------------------------------------------------------------- feriados
-- Nacionais são calculados em código (@omni/core). Aqui só municipais e da empresa.

CREATE TABLE holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL,
  name        text NOT NULL,
  scope       text NOT NULL CHECK (scope IN ('municipal', 'empresa')),
  city        text,
  created_by  uuid REFERENCES people(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (scope <> 'municipal' OR city IS NOT NULL),
  UNIQUE (date, scope, city)
);

-- Municipais de Itajaí (fonte: feriadosapi.com, conferir com a prefeitura).
-- Corpus Christi já é calculado como nacional, como no filtroAPP.
INSERT INTO holidays (date, name, scope, city)
SELECT make_date(y, m, d), n, 'municipal', 'Itajaí'
FROM generate_series(2026, 2030) AS y,
     (VALUES (6, 15, 'Aniversário de Itajaí'), (12, 8, 'Imaculada Conceição')) AS f(m, d, n);

-- ---------------------------------------------------------------- sessões
-- Ninguém lê esta tabela diretamente: só pelas funções app.login/resolve_session/logout.

CREATE TABLE sessions (
  token_hash    bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  user_agent    text,
  ip            inet
);
CREATE INDEX sessions_person ON sessions (person_id);

-- ---------------------------------------------------------------- auditoria (só inserção)

CREATE TABLE audit_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  actor_person_id  uuid REFERENCES people(id),
  action           text NOT NULL,
  entity_type      text,
  entity_id        text,
  request_id       text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_log_actor_at ON audit_log (actor_person_id, at DESC);
CREATE INDEX audit_log_entity ON audit_log (entity_type, entity_id);

CREATE FUNCTION app.audit_log_immutable() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_log é somente inserção'; END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_log_immutable();

-- ---------------------------------------------------------------- login e sessão

CREATE FUNCTION app.login(
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
    INSERT INTO people (entra_oid, email, display_name)
    VALUES (p_entra_oid, p_email, p_display_name)
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

CREATE FUNCTION app.resolve_session(p_token_hash bytea) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_person uuid;
BEGIN
  SELECT s.person_id INTO v_person
    FROM sessions s JOIN people p ON p.id = s.person_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND p.active;
  IF v_person IS NOT NULL THEN
    UPDATE sessions SET last_seen_at = now()
     WHERE token_hash = p_token_hash AND last_seen_at < now() - interval '5 minutes';
  END IF;
  RETURN v_person;
END $$;

CREATE FUNCTION app.logout(p_token_hash bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ UPDATE sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL $$;

REVOKE EXECUTE ON FUNCTION app.login(uuid, text, text, bytea, interval, text, inet) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.resolve_session(bytea) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.logout(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.login(uuid, text, text, bytea, interval, text, inet) TO omni_app;
GRANT EXECUTE ON FUNCTION app.resolve_session(bytea) TO omni_app;
GRANT EXECUTE ON FUNCTION app.logout(bytea) TO omni_app;

-- ---------------------------------------------------------------- privilégios e RLS

GRANT SELECT, UPDATE ON people TO omni_app, omni_worker;
GRANT SELECT, INSERT, DELETE ON person_profiles TO omni_app;
GRANT SELECT ON person_profiles TO omni_worker;
GRANT SELECT ON functions TO omni_app, omni_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON function_assignments TO omni_app;
GRANT SELECT ON function_assignments TO omni_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON holidays TO omni_app;
GRANT SELECT ON holidays TO omni_worker;
GRANT SELECT, INSERT ON audit_log TO omni_app, omni_worker;
-- sessions: nenhum privilégio direto

ALTER TABLE people               ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE functions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE function_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays             ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;

-- Diretório: quem está logado vê as pessoas (nome, cargo, e-mail).
CREATE POLICY people_select_logged ON people FOR SELECT TO omni_app
  USING (app.current_person_id() IS NOT NULL);
CREATE POLICY people_update_settings ON people FOR UPDATE TO omni_app
  USING (app.is_manager_of_settings()) WITH CHECK (app.is_manager_of_settings());
CREATE POLICY people_worker ON people FOR ALL TO omni_worker USING (true) WITH CHECK (true);

CREATE POLICY profiles_select_logged ON person_profiles FOR SELECT TO omni_app
  USING (app.current_person_id() IS NOT NULL);
-- Só admin concede ou retira o perfil admin; diretoria cuida dos demais.
CREATE POLICY profiles_insert ON person_profiles FOR INSERT TO omni_app
  WITH CHECK (app.is_manager_of_settings() AND (profile <> 'admin' OR app.has_profile('admin'))
              AND granted_by = app.current_person_id());
CREATE POLICY profiles_delete ON person_profiles FOR DELETE TO omni_app
  USING (app.is_manager_of_settings() AND (profile <> 'admin' OR app.has_profile('admin')));
CREATE POLICY profiles_worker ON person_profiles FOR SELECT TO omni_worker USING (true);

CREATE POLICY functions_select ON functions FOR SELECT TO omni_app, omni_worker
  USING (app.current_person_id() IS NOT NULL OR current_user = 'omni_worker');

CREATE POLICY assignments_select ON function_assignments FOR SELECT TO omni_app
  USING (app.current_person_id() IS NOT NULL);
CREATE POLICY assignments_write ON function_assignments FOR ALL TO omni_app
  USING (app.is_manager_of_settings()) WITH CHECK (app.is_manager_of_settings());
CREATE POLICY assignments_worker ON function_assignments FOR SELECT TO omni_worker USING (true);

CREATE POLICY holidays_select ON holidays FOR SELECT TO omni_app
  USING (app.current_person_id() IS NOT NULL);
CREATE POLICY holidays_write ON holidays FOR ALL TO omni_app
  USING (app.is_manager_of_settings()) WITH CHECK (app.is_manager_of_settings());
CREATE POLICY holidays_worker ON holidays FOR SELECT TO omni_worker USING (true);

CREATE POLICY audit_insert_self ON audit_log FOR INSERT TO omni_app
  WITH CHECK (actor_person_id = app.current_person_id());
CREATE POLICY audit_select_settings ON audit_log FOR SELECT TO omni_app
  USING (app.is_manager_of_settings());
CREATE POLICY audit_worker_insert ON audit_log FOR INSERT TO omni_worker
  WITH CHECK (actor_person_id IS NULL);
