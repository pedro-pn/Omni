-- Arquivos no Interno e no Gerencial (16/11/2026; Fase 2/4 do planejamento: "arrastar
-- para a conversa"). O arquivo fica no SharePoint do Omni (site OmniAnexos), em
-- Canais/<missão>/<id>.<extensão>; aqui ficam o nome original, o tipo, o tamanho e
-- onde está. Quem lê a mensagem (RLS de mission_messages, com o corte de histórico)
-- abre o arquivo; só o autor da mensagem anexa.

CREATE TABLE mission_message_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id   uuid NOT NULL REFERENCES mission_messages(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime         text NOT NULL CHECK (length(mime) BETWEEN 3 AND 150),
  size         bigint NOT NULL CHECK (size > 0),
  sp_drive_id  text NOT NULL,
  sp_item_id   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_message_files_mensagem ON mission_message_files (message_id);

ALTER TABLE mission_message_files ENABLE ROW LEVEL SECURITY;
-- A subconsulta passa pela RLS de mission_messages: vê o arquivo quem vê a mensagem.
CREATE POLICY files_select ON mission_message_files FOR SELECT TO omni_app
  USING (EXISTS (SELECT 1 FROM mission_messages m WHERE m.id = message_id));
CREATE POLICY files_insert ON mission_message_files FOR INSERT TO omni_app
  WITH CHECK (EXISTS (SELECT 1 FROM mission_messages m WHERE m.id = message_id AND m.author_person_id = app.current_person_id()));
GRANT SELECT, INSERT ON mission_message_files TO omni_app;
