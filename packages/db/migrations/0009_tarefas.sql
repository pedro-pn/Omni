-- 0009 · Tarefas (Fase 3: o Foco vira o módulo Tarefas do Omni).
--
-- Mesma estrutura do Foco (projetos, membros, seções, tarefas), com `foco_id`
-- em cada linha para a migração dos dados. Diferenças:
--   * pessoas são `people` (login Entra), não `auth.users`; responsável por id;
--   * o "workspace" do Foco é a empresa: quem tem o perfil diretoria vê todos
--     os projetos (o papel de owner/admin do workspace no Foco);
--   * projeto pode ser ligado a uma missão (`mission_id`).
--
-- Quem vê e edita (regras do Foco, can_access_project / can_edit_task):
--   * caixa pessoal (`owner_person_id`): só o dono;
--   * projeto: membros e diretoria veem; owner/manager (e diretoria) gerenciam;
--   * tarefa de projeto: edita quem gerencia, o responsável ou qualquer membro
--     se ela não tem responsável;
--   * responsável de tarefa de projeto precisa ser membro do projeto.

CREATE TABLE task_projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  color        text NOT NULL DEFAULT '#1e6b4a' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  description  text NOT NULL DEFAULT '',
  mission_id   uuid REFERENCES missions(id) ON DELETE SET NULL,
  archived_at  timestamptz,
  created_by   uuid NOT NULL REFERENCES people(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  foco_id      uuid UNIQUE
);
CREATE TRIGGER task_projects_updated_at BEFORE UPDATE ON task_projects
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE INDEX task_projects_mission ON task_projects (mission_id) WHERE mission_id IS NOT NULL;

CREATE TABLE task_project_members (
  project_id  uuid NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'manager', 'member')),
  added_by    uuid REFERENCES people(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, person_id)
);
CREATE INDEX task_project_members_person ON task_project_members (person_id);

CREATE TABLE task_sections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES task_projects(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  foco_id     uuid UNIQUE
);
CREATE INDEX task_sections_project ON task_sections (project_id, position);

CREATE TABLE tasks (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content                  text NOT NULL CHECK (length(trim(content)) BETWEEN 1 AND 500),
  description              text NOT NULL DEFAULT '',
  project_id               uuid REFERENCES task_projects(id) ON DELETE CASCADE,
  owner_person_id          uuid REFERENCES people(id),          -- caixa pessoal
  section_id               uuid REFERENCES task_sections(id) ON DELETE SET NULL,
  parent_task_id           uuid REFERENCES tasks(id) ON DELETE CASCADE,
  assignee_person_id       uuid REFERENCES people(id),
  due_date                 date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date),
  due_time                 time,
  deadline                 date,
  duration_minutes         integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  priority                 integer NOT NULL DEFAULT 4 CHECK (priority BETWEEN 1 AND 4),
  labels                   text[] NOT NULL DEFAULT '{}',
  recurrence               text,                                -- regra do Foco (@omni/core recurrence.ts)
  reminder_offset_minutes  integer CHECK (reminder_offset_minutes IS NULL OR reminder_offset_minutes >= 0),
  reminder_at              timestamptz,
  reminder_sent_at         timestamptz,
  position                 integer NOT NULL DEFAULT 0,
  completed                boolean NOT NULL DEFAULT false,
  completed_at             timestamptz,
  completed_by             uuid REFERENCES people(id),
  created_by               uuid NOT NULL REFERENCES people(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  foco_id                  uuid UNIQUE,
  CONSTRAINT tasks_um_lugar CHECK ((project_id IS NULL) <> (owner_person_id IS NULL)),
  CONSTRAINT tasks_caixa_sem_delegar CHECK (project_id IS NOT NULL OR assignee_person_id IS NULL OR assignee_person_id = owner_person_id)
);
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE INDEX tasks_open_assignee ON tasks (assignee_person_id, due_date) WHERE NOT completed;
CREATE INDEX tasks_open_owner ON tasks (owner_person_id, due_date) WHERE NOT completed AND owner_person_id IS NOT NULL;
CREATE INDEX tasks_project ON tasks (project_id, completed, position);

-- ---------------------------------------------------------------- regras de acesso

CREATE FUNCTION app.membro_do_projeto(p_project uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM task_project_members m JOIN people p ON p.id = m.person_id
       WHERE m.project_id = p_project AND m.person_id = p_person AND p.active
    )
  $$;

CREATE FUNCTION app.pode_ver_projeto(p_project uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.current_person_id() IS NOT NULL
       AND (app.has_profile('diretoria') OR app.membro_do_projeto(p_project, app.current_person_id()))
  $$;

CREATE FUNCTION app.pode_gerenciar_projeto(p_project uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.current_person_id() IS NOT NULL AND (
      app.has_profile('diretoria') OR EXISTS (
        SELECT 1 FROM task_project_members m
         WHERE m.project_id = p_project AND m.person_id = app.current_person_id() AND m.role IN ('owner', 'manager')
      )
    )
  $$;

CREATE FUNCTION app.pode_editar_tarefa(p_task uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM tasks t
       WHERE t.id = p_task AND app.current_person_id() IS NOT NULL AND (
         t.owner_person_id = app.current_person_id()
         OR (t.project_id IS NOT NULL AND app.pode_ver_projeto(t.project_id) AND (
               app.pode_gerenciar_projeto(t.project_id)
               OR t.assignee_person_id IS NULL
               OR t.assignee_person_id = app.current_person_id()))
       )
    )
  $$;

-- Onde a tarefa pode ficar: na própria caixa, ou num projeto que vejo, com
-- responsável membro e seção do mesmo projeto.
CREATE FUNCTION app.lugar_valido_tarefa(p_project uuid, p_owner uuid, p_assignee uuid, p_section uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT CASE
      WHEN p_project IS NULL THEN p_owner = app.current_person_id() AND p_section IS NULL
      ELSE app.pode_ver_projeto(p_project)
           AND (p_assignee IS NULL OR app.membro_do_projeto(p_project, p_assignee))
           AND (p_section IS NULL OR EXISTS (SELECT 1 FROM task_sections s WHERE s.id = p_section AND s.project_id = p_project))
    END
  $$;

-- Cria o projeto e coloca quem criou como owner, de uma vez.
CREATE FUNCTION app.criar_projeto_tarefas(p_name text, p_color text, p_mission uuid) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_me uuid := app.current_person_id();
  v_id uuid;
BEGIN
  IF v_me IS NULL OR NOT app.has_any_profile() THEN
    RAISE EXCEPTION 'sem permissão para criar projeto' USING ERRCODE = '42501';
  END IF;
  INSERT INTO task_projects (name, color, mission_id, created_by)
    VALUES (p_name, coalesce(p_color, '#1e6b4a'), p_mission, v_me) RETURNING id INTO v_id;
  INSERT INTO task_project_members (project_id, person_id, role, added_by) VALUES (v_id, v_me, 'owner', v_me);
  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION app.membro_do_projeto(uuid, uuid), app.pode_ver_projeto(uuid), app.pode_gerenciar_projeto(uuid),
  app.pode_editar_tarefa(uuid), app.lugar_valido_tarefa(uuid, uuid, uuid, uuid), app.criar_projeto_tarefas(text, text, uuid)
  TO omni_app;

-- ---------------------------------------------------------------- permissões

GRANT SELECT, UPDATE, DELETE ON task_projects TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_project_members, task_sections, tasks TO omni_app;
GRANT SELECT ON task_projects, task_project_members, task_sections, tasks TO omni_worker;

ALTER TABLE task_projects        ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_sections        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks                ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_select ON task_projects FOR SELECT TO omni_app USING (app.pode_ver_projeto(id));
CREATE POLICY projects_update ON task_projects FOR UPDATE TO omni_app
  USING (app.pode_gerenciar_projeto(id)) WITH CHECK (app.pode_gerenciar_projeto(id));
CREATE POLICY projects_delete ON task_projects FOR DELETE TO omni_app USING (app.pode_gerenciar_projeto(id));

CREATE POLICY members_select ON task_project_members FOR SELECT TO omni_app USING (app.pode_ver_projeto(project_id));
CREATE POLICY members_insert ON task_project_members FOR INSERT TO omni_app
  WITH CHECK (app.pode_gerenciar_projeto(project_id) AND added_by = app.current_person_id());
CREATE POLICY members_update ON task_project_members FOR UPDATE TO omni_app
  USING (app.pode_gerenciar_projeto(project_id)) WITH CHECK (app.pode_gerenciar_projeto(project_id));
CREATE POLICY members_delete ON task_project_members FOR DELETE TO omni_app
  USING (app.pode_gerenciar_projeto(project_id) OR person_id = app.current_person_id());   -- sair do projeto

CREATE POLICY sections_select ON task_sections FOR SELECT TO omni_app USING (app.pode_ver_projeto(project_id));
CREATE POLICY sections_write ON task_sections FOR ALL TO omni_app
  USING (app.pode_ver_projeto(project_id)) WITH CHECK (app.pode_ver_projeto(project_id));

CREATE POLICY tasks_select ON tasks FOR SELECT TO omni_app
  USING (owner_person_id = app.current_person_id() OR (project_id IS NOT NULL AND app.pode_ver_projeto(project_id)));
CREATE POLICY tasks_insert ON tasks FOR INSERT TO omni_app
  WITH CHECK (created_by = app.current_person_id()
              AND app.lugar_valido_tarefa(project_id, owner_person_id, assignee_person_id, section_id));
CREATE POLICY tasks_update ON tasks FOR UPDATE TO omni_app
  USING (app.pode_editar_tarefa(id))
  WITH CHECK (app.lugar_valido_tarefa(project_id, owner_person_id, assignee_person_id, section_id));
CREATE POLICY tasks_delete ON tasks FOR DELETE TO omni_app
  USING (owner_person_id = app.current_person_id()
         OR (project_id IS NOT NULL AND (app.pode_gerenciar_projeto(project_id)
                                         OR (created_by = app.current_person_id() AND app.pode_ver_projeto(project_id)))));

CREATE POLICY task_projects_worker ON task_projects FOR SELECT TO omni_worker USING (true);
CREATE POLICY task_members_worker  ON task_project_members FOR SELECT TO omni_worker USING (true);
CREATE POLICY task_sections_worker ON task_sections FOR SELECT TO omni_worker USING (true);
CREATE POLICY tasks_worker         ON tasks FOR SELECT TO omni_worker USING (true);
