-- Reações nos comentários das tarefas (porta de `comment_reactions` do Foco):
-- os mesmos seis emojis; uma reação por pessoa e emoji; quem vê a tarefa vê e
-- reage; cada um só tira a própria. Quem escreveu o comentário recebe aviso
-- (uma vez por pessoa e emoji, mesmo que tire e ponha de novo).

CREATE TABLE task_comment_reactions (
  comment_id  uuid NOT NULL REFERENCES task_comments(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  emoji       text NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '🎉', '😮', '😢')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, person_id, emoji)
);
CREATE INDEX task_comment_reactions_comment ON task_comment_reactions (comment_id, created_at);

GRANT SELECT, INSERT, DELETE ON task_comment_reactions TO omni_app;

ALTER TABLE task_comment_reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY reactions_select ON task_comment_reactions FOR SELECT TO omni_app
  USING (EXISTS (SELECT 1 FROM task_comments c WHERE c.id = comment_id AND app.pode_ver_tarefa(c.task_id)));
CREATE POLICY reactions_insert ON task_comment_reactions FOR INSERT TO omni_app
  WITH CHECK (person_id = app.current_person_id()
              AND EXISTS (SELECT 1 FROM task_comments c WHERE c.id = comment_id AND app.pode_ver_tarefa(c.task_id)));
CREATE POLICY reactions_delete ON task_comment_reactions FOR DELETE TO omni_app
  USING (person_id = app.current_person_id());

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete', 'tarefa_mencao', 'tarefa_reacao',
                  'ia_alerta', 'ia_pergunta', 'teste_push', 'chamada_perdida'));

CREATE FUNCTION app.avisar_reacao() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_comentario task_comments;
  v_tarefa tasks;
BEGIN
  SELECT * INTO v_comentario FROM task_comments WHERE id = NEW.comment_id;
  IF v_comentario.author_person_id = NEW.person_id THEN RETURN NEW; END IF;
  SELECT * INTO v_tarefa FROM tasks WHERE id = v_comentario.task_id;
  INSERT INTO notifications (person_id, actor_person_id, kind, title, body, task_id, dedupe_key)
    VALUES (v_comentario.author_person_id, NEW.person_id, 'tarefa_reacao',
            app.nome_pessoa(NEW.person_id) || ' reagiu ' || NEW.emoji || ' ao seu comentário em “' || left(v_tarefa.content, 80) || '”',
            left(v_comentario.body, 140), v_tarefa.id,
            'reacao:' || NEW.comment_id || ':' || NEW.person_id || ':' || NEW.emoji)
    ON CONFLICT (dedupe_key) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER task_comment_reactions_avisos AFTER INSERT ON task_comment_reactions
  FOR EACH ROW EXECUTE FUNCTION app.avisar_reacao();
