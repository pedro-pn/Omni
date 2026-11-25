-- 0010 · Tarefas: comentários e histórico (como `comments` e `activity_log` do Foco).
--
-- * task_comments: quem vê a tarefa vê e comenta; cada um edita e apaga só o seu.
-- * task_activity: escrito só por trigger em `tasks` (a tela não grava nem forja
--   histórico). O autor é quem está na sessão (NULL quando é o worker ou a migração).
--   Concluir uma ocorrência de tarefa que repete marca `app.acao_tarefa = 'concluir'`
--   na transação; sem a marca, avançar a data é "mudou a data".

CREATE FUNCTION app.pode_ver_tarefa(p_task uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM tasks t
       WHERE t.id = p_task AND app.current_person_id() IS NOT NULL
         AND (t.owner_person_id = app.current_person_id()
              OR (t.project_id IS NOT NULL AND app.pode_ver_projeto(t.project_id)))
    )
  $$;
GRANT EXECUTE ON FUNCTION app.pode_ver_tarefa(uuid) TO omni_app;

-- ---------------------------------------------------------------- comentários

CREATE TABLE task_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_person_id  uuid NOT NULL REFERENCES people(id),
  body              text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  edited_at         timestamptz,
  foco_id           uuid UNIQUE
);
CREATE INDEX task_comments_task ON task_comments (task_id, created_at);

GRANT SELECT, INSERT, DELETE ON task_comments TO omni_app;
GRANT UPDATE (body, edited_at) ON task_comments TO omni_app;
GRANT SELECT ON task_comments TO omni_worker;
ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY comments_select ON task_comments FOR SELECT TO omni_app USING (app.pode_ver_tarefa(task_id));
CREATE POLICY comments_insert ON task_comments FOR INSERT TO omni_app
  WITH CHECK (author_person_id = app.current_person_id() AND app.pode_ver_tarefa(task_id));
CREATE POLICY comments_update ON task_comments FOR UPDATE TO omni_app
  USING (author_person_id = app.current_person_id()) WITH CHECK (author_person_id = app.current_person_id());
CREATE POLICY comments_delete ON task_comments FOR DELETE TO omni_app
  USING (author_person_id = app.current_person_id());
CREATE POLICY comments_worker ON task_comments FOR SELECT TO omni_worker USING (true);

-- ---------------------------------------------------------------- histórico

CREATE TABLE task_activity (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id          uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_person_id  uuid REFERENCES people(id),
  action           text NOT NULL,     -- criada, concluida, reaberta, repetiu, data, responsavel, projeto, titulo, prioridade, descricao, repeticao
  summary          text NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  foco_id          uuid UNIQUE
);
CREATE INDEX task_activity_task ON task_activity (task_id, created_at);

GRANT SELECT ON task_activity TO omni_app, omni_worker;
ALTER TABLE task_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_select ON task_activity FOR SELECT TO omni_app USING (app.pode_ver_tarefa(task_id));
CREATE POLICY activity_worker ON task_activity FOR SELECT TO omni_worker USING (true);

CREATE FUNCTION app.data_br(d date) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT to_char(d, 'DD/MM/YYYY') $$;

CREATE FUNCTION app.registrar_atividade_tarefa() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_ator uuid := app.current_person_id();
  v_nome text;
  v_proj text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary)
      VALUES (NEW.id, v_ator, 'criada', 'Criou a tarefa');
    RETURN NEW;
  END IF;

  IF NEW.completed AND NOT OLD.completed THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary) VALUES (NEW.id, v_ator, 'concluida', 'Concluiu');
  ELSIF OLD.completed AND NOT NEW.completed THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary) VALUES (NEW.id, v_ator, 'reaberta', 'Reabriu');
  END IF;

  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    IF coalesce(current_setting('app.acao_tarefa', true), '') = 'concluir' AND NEW.recurrence IS NOT NULL THEN
      INSERT INTO task_activity (task_id, actor_person_id, action, summary, metadata)
        VALUES (NEW.id, v_ator, 'repetiu', 'Concluiu esta ocorrência; a próxima é ' || app.data_br(NEW.due_date),
                jsonb_build_object('de', OLD.due_date, 'para', NEW.due_date));
    ELSE
      INSERT INTO task_activity (task_id, actor_person_id, action, summary, metadata)
        VALUES (NEW.id, v_ator, 'data', 'Mudou a data de ' || app.data_br(OLD.due_date) || ' para ' || app.data_br(NEW.due_date),
                jsonb_build_object('de', OLD.due_date, 'para', NEW.due_date));
    END IF;
  ELSIF NEW.due_time IS DISTINCT FROM OLD.due_time THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary)
      VALUES (NEW.id, v_ator, 'data', CASE WHEN NEW.due_time IS NULL THEN 'Tirou o horário'
                                          ELSE 'Mudou o horário para ' || to_char(NEW.due_time, 'HH24:MI') END);
  END IF;

  IF NEW.assignee_person_id IS DISTINCT FROM OLD.assignee_person_id THEN
    SELECT display_name INTO v_nome FROM people WHERE id = NEW.assignee_person_id;
    INSERT INTO task_activity (task_id, actor_person_id, action, summary, metadata)
      VALUES (NEW.id, v_ator, 'responsavel', CASE WHEN v_nome IS NULL THEN 'Deixou sem responsável' ELSE 'Passou para ' || v_nome END,
              jsonb_build_object('de', OLD.assignee_person_id, 'para', NEW.assignee_person_id));
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    SELECT name INTO v_proj FROM task_projects WHERE id = NEW.project_id;
    INSERT INTO task_activity (task_id, actor_person_id, action, summary, metadata)
      VALUES (NEW.id, v_ator, 'projeto', CASE WHEN v_proj IS NULL THEN 'Moveu para a caixa pessoal' ELSE 'Moveu para ' || v_proj END,
              jsonb_build_object('de', OLD.project_id, 'para', NEW.project_id));
  END IF;

  IF NEW.content IS DISTINCT FROM OLD.content THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary, metadata)
      VALUES (NEW.id, v_ator, 'titulo', 'Mudou o título', jsonb_build_object('de', OLD.content));
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary) VALUES (NEW.id, v_ator, 'descricao', 'Editou a descrição');
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary)
      VALUES (NEW.id, v_ator, 'prioridade', 'Mudou a prioridade de P' || OLD.priority || ' para P' || NEW.priority);
  END IF;
  IF NEW.recurrence IS DISTINCT FROM OLD.recurrence THEN
    INSERT INTO task_activity (task_id, actor_person_id, action, summary)
      VALUES (NEW.id, v_ator, 'repeticao', CASE WHEN NEW.recurrence IS NULL THEN 'Deixou de repetir' ELSE 'Mudou a repetição' END);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER tasks_atividade AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.registrar_atividade_tarefa();
