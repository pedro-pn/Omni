-- Liberação por módulo (Fase 11, 24/11/2026): a Administração escolhe, módulo a módulo,
-- se vale para todos, só para alguns perfis e pessoas, ou para ninguém (entrada aos
-- poucos). Sem linha = todos. Quem administra sempre vê (para configurar e testar).
-- A regra vale na tela, nas funções do servidor e nas notificações do celular.

CREATE TABLE module_access (
  module      text PRIMARY KEY CHECK (module IN ('whatsapp', 'emails', 'missoes', 'tarefas', 'chamadas', 'revisao')),
  mode        text NOT NULL DEFAULT 'todos' CHECK (mode IN ('todos', 'restrito', 'ninguem')),
  profiles    perfil[] NOT NULL DEFAULT '{}',
  people      uuid[] NOT NULL DEFAULT '{}',
  updated_by  uuid REFERENCES people(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE module_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY module_access_ler ON module_access FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY module_access_admin ON module_access FOR ALL TO omni_app USING (app.has_profile('admin')) WITH CHECK (app.has_profile('admin'));
GRANT SELECT, INSERT, UPDATE, DELETE ON module_access TO omni_app;
CREATE POLICY module_access_worker ON module_access FOR SELECT TO omni_worker USING (true);
GRANT SELECT ON module_access TO omni_worker;

CREATE FUNCTION app.modulo_liberado_para(p_person uuid, p_modulo text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT CASE
      WHEN p_person IS NULL THEN false
      WHEN EXISTS (SELECT 1 FROM person_profiles WHERE person_id = p_person AND profile = 'admin') THEN true
      ELSE coalesce((
        SELECT CASE m.mode
                 WHEN 'todos' THEN true
                 WHEN 'ninguem' THEN false
                 ELSE p_person = ANY (m.people)
                   OR EXISTS (SELECT 1 FROM person_profiles pp WHERE pp.person_id = p_person AND pp.profile = ANY (m.profiles))
               END
          FROM module_access m WHERE m.module = p_modulo), true)
    END
  $$;
CREATE FUNCTION app.modulo_liberado(p_modulo text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT app.modulo_liberado_para(app.current_person_id(), p_modulo) $$;
REVOKE ALL ON FUNCTION app.modulo_liberado_para(uuid, text), app.modulo_liberado(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.modulo_liberado(text) TO omni_app;
GRANT EXECUTE ON FUNCTION app.modulo_liberado_para(uuid, text) TO omni_worker;
