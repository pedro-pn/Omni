-- Anexos das tarefas (24/11/2026; Fase 3, destino dos anexos do Foco). O arquivo fica no
-- SharePoint do Omni (site OmniAnexos), em Tarefas/<tarefa>/<id>.<extensão> (sem o nome do
-- arquivo no caminho); aqui ficam o nome original, o tipo, o tamanho e onde está. Vê e
-- anexa quem vê a tarefa (como os comentários); apaga quem anexou. Os do Foco chegam pela
-- migração com o mesmo id (`foco_id`) e o SHA-256 conferido.

CREATE TABLE task_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime         text NOT NULL CHECK (length(mime) BETWEEN 3 AND 150),
  size         bigint NOT NULL CHECK (size > 0),
  sha256       text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  sp_drive_id  text NOT NULL,
  sp_item_id   text NOT NULL,
  uploaded_by  uuid REFERENCES people(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  foco_id      uuid UNIQUE
);
CREATE INDEX task_attachments_tarefa ON task_attachments (task_id, created_at);

ALTER TABLE task_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY anexos_select ON task_attachments FOR SELECT TO omni_app USING (app.pode_ver_tarefa(task_id));
CREATE POLICY anexos_insert ON task_attachments FOR INSERT TO omni_app
  WITH CHECK (uploaded_by = app.current_person_id() AND app.pode_ver_tarefa(task_id));
CREATE POLICY anexos_delete ON task_attachments FOR DELETE TO omni_app
  USING (uploaded_by = app.current_person_id() AND app.pode_ver_tarefa(task_id));
GRANT SELECT, INSERT, DELETE ON task_attachments TO omni_app;
