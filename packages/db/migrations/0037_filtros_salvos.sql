-- Filtros salvos das Tarefas (porta de `saved_filters` do Foco): cada pessoa
-- guarda os seus (nome, consulta na linguagem do Foco, cor, favorito). A
-- consulta é aplicada sobre as tarefas que a pessoa já vê (RLS das tarefas).
-- `foco_id` guarda a origem para a migração dos dados.

CREATE TABLE task_saved_filters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  query       text NOT NULL CHECK (length(btrim(query)) BETWEEN 1 AND 500),
  color       text NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  favorite    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  foco_id     uuid UNIQUE
);
CREATE INDEX task_saved_filters_person ON task_saved_filters (person_id, created_at);

GRANT SELECT, INSERT, DELETE ON task_saved_filters TO omni_app;
GRANT UPDATE (name, query, color, favorite) ON task_saved_filters TO omni_app;

ALTER TABLE task_saved_filters ENABLE ROW LEVEL SECURITY;
CREATE POLICY saved_filters_proprios ON task_saved_filters FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id());
