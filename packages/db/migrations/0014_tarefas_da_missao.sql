-- 0014 · Tarefas da missão.
--
-- Cada missão tem no máximo um projeto de tarefas (`task_projects.mission_id`).
-- Quem vê o Interno da missão é membro implícito desse projeto: vê as tarefas
-- e pode recebê-las, sem cadastro manual. Quem gerencia o Interno (diretoria e
-- líder de projetos) gerencia o projeto. Membros explícitos continuam valendo.

-- Mesma regra de app.canal_desde(…, 'interno'), para qualquer pessoa (não só a logada).
CREATE FUNCTION app.ve_interno(p_mission uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM people WHERE id = p_person AND active) AND (
      EXISTS (SELECT 1 FROM person_profiles WHERE person_id = p_person AND profile = 'diretoria')
      OR EXISTS (SELECT 1 FROM mission_members m
                  WHERE m.mission_id = p_mission AND m.channel = 'interno' AND m.person_id = p_person AND m.removed_at IS NULL)
      OR EXISTS (SELECT 1 FROM mission_responsibles r JOIN people p ON p.email = r.email
                  WHERE r.mission_id = p_mission AND r.role IN ('LEADER', 'PLANNER') AND p.id = p_person)
      OR EXISTS (SELECT 1 FROM mission_function_access a JOIN function_assignments f ON f.function_code = a.function_code
                  WHERE a.mission_id = p_mission AND f.person_id = p_person
                    AND f.starts_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
                    AND (f.ends_on IS NULL OR f.ends_on >= (now() AT TIME ZONE 'America/Sao_Paulo')::date))
    )
  $$;

CREATE UNIQUE INDEX task_projects_uma_por_missao ON task_projects (mission_id) WHERE mission_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.membro_do_projeto(p_project uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM task_project_members m JOIN people p ON p.id = m.person_id
       WHERE m.project_id = p_project AND m.person_id = p_person AND p.active
    ) OR EXISTS (
      SELECT 1 FROM task_projects tp
       WHERE tp.id = p_project AND tp.mission_id IS NOT NULL AND app.ve_interno(tp.mission_id, p_person)
    )
  $$;

CREATE OR REPLACE FUNCTION app.pode_gerenciar_projeto(p_project uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.current_person_id() IS NOT NULL AND (
      app.has_profile('diretoria')
      OR EXISTS (
        SELECT 1 FROM task_project_members m
         WHERE m.project_id = p_project AND m.person_id = app.current_person_id() AND m.role IN ('owner', 'manager')
      )
      OR EXISTS (
        SELECT 1 FROM task_projects tp
         WHERE tp.id = p_project AND tp.mission_id IS NOT NULL AND app.pode_gerenciar_canal(tp.mission_id, 'interno')
      )
    )
  $$;

-- O projeto da missão (cria na primeira vez). Só para quem vê o Interno.
CREATE FUNCTION app.projeto_da_missao(p_mission uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_nome text;
BEGIN
  IF app.canal_desde(p_mission, 'interno') IS NULL THEN
    RAISE EXCEPTION 'sem acesso ao Interno da missão' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM task_projects WHERE mission_id = p_mission;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT 'Missão ' || code || CASE WHEN btrim(client_name) <> '' THEN ' - ' || btrim(client_name) ELSE '' END
    INTO v_nome FROM missions WHERE id = p_mission;
  INSERT INTO task_projects (name, mission_id, created_by)
    VALUES (left(v_nome, 120), p_mission, app.current_person_id())
    ON CONFLICT (mission_id) WHERE mission_id IS NOT NULL DO NOTHING
    RETURNING id INTO v_id;
  RETURN coalesce(v_id, (SELECT id FROM task_projects WHERE mission_id = p_mission));
END $$;

-- Membros do projeto para a tela (explícitos + implícitos da missão), só para quem vê o projeto.
CREATE FUNCTION app.membros_do_projeto(p_project uuid)
  RETURNS TABLE (person_id uuid, role text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH projeto AS (
      SELECT id, mission_id FROM task_projects WHERE id = p_project AND app.pode_ver_projeto(p_project)
    ), explicitos AS (
      SELECT m.person_id, m.role FROM task_project_members m JOIN projeto ON projeto.id = m.project_id
    ), candidatos AS (
      SELECT pp.person_id FROM person_profiles pp, projeto WHERE projeto.mission_id IS NOT NULL AND pp.profile = 'diretoria'
      UNION SELECT mm.person_id FROM mission_members mm JOIN projeto ON projeto.mission_id = mm.mission_id
             WHERE mm.channel = 'interno' AND mm.removed_at IS NULL
      UNION SELECT p.id FROM mission_responsibles r JOIN projeto ON projeto.mission_id = r.mission_id JOIN people p ON p.email = r.email
             WHERE r.role IN ('LEADER', 'PLANNER')
      UNION SELECT f.person_id FROM mission_function_access a JOIN projeto ON projeto.mission_id = a.mission_id
             JOIN function_assignments f ON f.function_code = a.function_code
    ), implicitos AS (
      SELECT c.person_id,
             CASE WHEN EXISTS (SELECT 1 FROM person_profiles WHERE person_id = c.person_id AND profile = 'diretoria')
                    OR EXISTS (SELECT 1 FROM mission_responsibles r JOIN people p ON p.email = r.email, projeto
                                WHERE r.mission_id = projeto.mission_id AND r.role = 'LEADER' AND p.id = c.person_id)
                  THEN 'manager' ELSE 'member' END AS role
        FROM candidatos c, projeto
       WHERE app.ve_interno(projeto.mission_id, c.person_id)
    )
    SELECT person_id, role FROM explicitos
    UNION ALL
    SELECT person_id, role FROM implicitos WHERE person_id NOT IN (SELECT person_id FROM explicitos)
  $$;

GRANT EXECUTE ON FUNCTION app.ve_interno(uuid, uuid), app.projeto_da_missao(uuid), app.membros_do_projeto(uuid) TO omni_app;
