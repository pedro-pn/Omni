-- 0011 · Avisos (o sino) e lembretes de tarefas.
--
-- * notifications: avisos de uma pessoa. A tela só lê e marca como lido; os
--   avisos nascem de triggers (tarefa passada para você, tarefa que você criou
--   foi concluída, comentário em tarefa sua) ou do worker (lembretes).
-- * Cada aviso novo faz pg_notify('omni_avisos') para o SSE entregar só ao
--   destinatário. O conteúdo é relido pela tela, com RLS.
-- * Lembretes: o worker marca `tasks.reminder_sent_at` para não repetir.

CREATE TABLE notifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id        uuid NOT NULL REFERENCES people(id),
  actor_person_id  uuid REFERENCES people(id),
  kind             text NOT NULL CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete')),
  title            text NOT NULL,
  body             text NOT NULL DEFAULT '',
  task_id          uuid REFERENCES tasks(id) ON DELETE CASCADE,
  mission_id       uuid REFERENCES missions(id) ON DELETE CASCADE,
  dedupe_key       text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz
);
CREATE INDEX notifications_person ON notifications (person_id, created_at DESC);
CREATE INDEX notifications_unread ON notifications (person_id) WHERE read_at IS NULL;

GRANT SELECT ON notifications TO omni_app;
GRANT UPDATE (read_at) ON notifications TO omni_app;
GRANT SELECT, INSERT ON notifications TO omni_worker;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_select ON notifications FOR SELECT TO omni_app USING (person_id = app.current_person_id());
CREATE POLICY notifications_read ON notifications FOR UPDATE TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
CREATE POLICY notifications_worker ON notifications FOR ALL TO omni_worker USING (true) WITH CHECK (true);

CREATE FUNCTION app.notificar_aviso() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('omni_avisos', json_build_object('personId', NEW.person_id, 'id', NEW.id)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER notifications_notify AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION app.notificar_aviso();

-- ---------------------------------------------------------------- avisos das tarefas

CREATE FUNCTION app.nome_pessoa(p uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT coalesce((SELECT display_name FROM people WHERE id = p), 'Omni') $$;

CREATE FUNCTION app.avisar_tarefa() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_ator uuid := app.current_person_id();
BEGIN
  -- Passou para alguém (que não é quem fez a mudança)
  IF NEW.assignee_person_id IS NOT NULL AND NEW.assignee_person_id IS DISTINCT FROM v_ator
     AND (TG_OP = 'INSERT' OR NEW.assignee_person_id IS DISTINCT FROM OLD.assignee_person_id)
     AND NOT NEW.completed THEN
    INSERT INTO notifications (person_id, actor_person_id, kind, title, body, task_id)
      VALUES (NEW.assignee_person_id, v_ator, 'tarefa_atribuida',
              app.nome_pessoa(v_ator) || ' passou uma tarefa para você', NEW.content, NEW.id);
  END IF;
  -- Concluída por outra pessoa: avisa quem criou (conclusão sem pessoa na sessão,
  -- como importação ou worker, não avisa)
  IF TG_OP = 'UPDATE' AND NEW.completed AND NOT OLD.completed AND v_ator IS NOT NULL AND NEW.created_by <> v_ator THEN
    INSERT INTO notifications (person_id, actor_person_id, kind, title, body, task_id)
      VALUES (NEW.created_by, v_ator, 'tarefa_concluida', app.nome_pessoa(v_ator) || ' concluiu uma tarefa', NEW.content, NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tasks_avisos AFTER INSERT OR UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION app.avisar_tarefa();

-- Comentário: avisa o responsável e quem criou (sem repetir e sem avisar o autor).
CREATE FUNCTION app.avisar_comentario() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_tarefa tasks;
BEGIN
  SELECT * INTO v_tarefa FROM tasks WHERE id = NEW.task_id;
  INSERT INTO notifications (person_id, actor_person_id, kind, title, body, task_id)
    SELECT DISTINCT d, NEW.author_person_id, 'tarefa_comentario',
           app.nome_pessoa(NEW.author_person_id) || ' comentou em “' || left(v_tarefa.content, 80) || '”',
           left(NEW.body, 280), NEW.task_id
      FROM unnest(ARRAY[v_tarefa.assignee_person_id, v_tarefa.created_by, v_tarefa.owner_person_id]) AS d
     WHERE d IS NOT NULL AND d <> NEW.author_person_id;
  RETURN NEW;
END $$;
CREATE TRIGGER task_comments_avisos AFTER INSERT ON task_comments
  FOR EACH ROW EXECUTE FUNCTION app.avisar_comentario();

-- ---------------------------------------------------------------- lembretes (worker)

GRANT UPDATE (reminder_sent_at) ON tasks TO omni_worker;
CREATE POLICY tasks_worker_lembrete ON tasks FOR UPDATE TO omni_worker USING (true) WITH CHECK (true);

-- Horário do lembrete: data + hora (09:00 sem hora, como no Foco) em São Paulo, menos a antecedência.
CREATE FUNCTION app.horario_lembrete(p_data date, p_hora time, p_antes integer) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT ((p_data + coalesce(p_hora, time '09:00')) AT TIME ZONE 'America/Sao_Paulo') - make_interval(mins => p_antes) $$;
GRANT EXECUTE ON FUNCTION app.horario_lembrete(date, time, integer) TO omni_worker;
