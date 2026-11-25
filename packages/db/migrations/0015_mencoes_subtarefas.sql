-- 0015 · Menções com @pessoa nos comentários e subtarefas.
--
-- * task_comment_mentions: como `comment_mentions` do Foco. Quem escreveu o
--   comentário marca as pessoas; só vale quem enxerga a tarefa. A menção vira
--   aviso no sino ("mencionou você") e substitui o aviso de comentário que a
--   mesma pessoa receberia pelo mesmo comentário.
-- * Subtarefas (`tasks.parent_task_id`, já existia): um nível só e sempre no
--   mesmo lugar da tarefa principal (mesmo projeto ou mesma caixa pessoal).
--   Tarefa com subtarefas não muda de lugar (mova as subtarefas antes).

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete', 'tarefa_mencao'));

-- Quem enxerga a tarefa (qualquer pessoa, não só a logada): dono da caixa ou quem vê o projeto.
CREATE FUNCTION app.pessoa_ve_tarefa(p_task uuid, p_person uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM tasks t
       WHERE t.id = p_task AND (
         t.owner_person_id = p_person
         OR (t.project_id IS NOT NULL AND (
               app.membro_do_projeto(t.project_id, p_person)
               OR EXISTS (SELECT 1 FROM person_profiles pp JOIN people pe ON pe.id = pp.person_id
                           WHERE pp.person_id = p_person AND pp.profile = 'diretoria' AND pe.active)))
       )
    )
  $$;
GRANT EXECUTE ON FUNCTION app.pessoa_ve_tarefa(uuid, uuid) TO omni_app;

CREATE TABLE task_comment_mentions (
  comment_id  uuid NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  PRIMARY KEY (comment_id, person_id)
);

GRANT SELECT, INSERT ON task_comment_mentions TO omni_app;
GRANT SELECT ON task_comment_mentions TO omni_worker;
ALTER TABLE task_comment_mentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY mentions_select ON task_comment_mentions FOR SELECT TO omni_app
  USING (EXISTS (SELECT 1 FROM task_comments c WHERE c.id = comment_id AND app.pode_ver_tarefa(c.task_id)));
-- Só quem escreveu o comentário marca, e só quem enxerga a tarefa pode ser marcado.
CREATE POLICY mentions_insert ON task_comment_mentions FOR INSERT TO omni_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM task_comments c
     WHERE c.id = comment_id AND c.author_person_id = app.current_person_id()
       AND app.pessoa_ve_tarefa(c.task_id, person_id)
  ));
CREATE POLICY mentions_worker ON task_comment_mentions FOR SELECT TO omni_worker USING (true);

CREATE FUNCTION app.avisar_mencao() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_comentario task_comments;
  v_tarefa text;
BEGIN
  SELECT * INTO v_comentario FROM task_comments WHERE id = NEW.comment_id;
  IF NEW.person_id = v_comentario.author_person_id THEN RETURN NEW; END IF;
  SELECT content INTO v_tarefa FROM tasks WHERE id = v_comentario.task_id;
  -- A menção substitui o aviso de comentário do mesmo comentário (mesma transação).
  DELETE FROM notifications
   WHERE person_id = NEW.person_id AND task_id = v_comentario.task_id
     AND kind = 'tarefa_comentario' AND created_at = now();
  INSERT INTO notifications (person_id, actor_person_id, kind, title, body, task_id, dedupe_key)
    VALUES (NEW.person_id, v_comentario.author_person_id, 'tarefa_mencao',
            app.nome_pessoa(v_comentario.author_person_id) || ' mencionou você em “' || left(v_tarefa, 80) || '”',
            left(v_comentario.body, 280), v_comentario.task_id, 'mencao:' || NEW.comment_id || ':' || NEW.person_id)
    ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER task_comment_mentions_avisos AFTER INSERT ON task_comment_mentions
  FOR EACH ROW EXECUTE FUNCTION app.avisar_mencao();

-- ---------------------------------------------------------------- subtarefas

CREATE FUNCTION app.validar_subtarefa() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_pai tasks;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT * INTO v_pai FROM tasks WHERE id = NEW.parent_task_id;
    IF v_pai.id IS NULL OR v_pai.id = NEW.id THEN
      RAISE EXCEPTION 'tarefa principal inválida' USING ERRCODE = '23514';
    END IF;
    IF v_pai.parent_task_id IS NOT NULL THEN
      RAISE EXCEPTION 'subtarefa não pode ter subtarefas' USING ERRCODE = '23514';
    END IF;
    IF v_pai.project_id IS DISTINCT FROM NEW.project_id OR v_pai.owner_person_id IS DISTINCT FROM NEW.owner_person_id THEN
      RAISE EXCEPTION 'subtarefa fica no mesmo lugar da tarefa principal' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE'
     AND (NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.owner_person_id IS DISTINCT FROM OLD.owner_person_id)
     AND EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = NEW.id) THEN
    RAISE EXCEPTION 'mova as subtarefas antes de mudar a tarefa de lugar' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_subtarefa BEFORE INSERT OR UPDATE OF parent_task_id, project_id, owner_person_id ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.validar_subtarefa();
CREATE INDEX tasks_parent ON tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
