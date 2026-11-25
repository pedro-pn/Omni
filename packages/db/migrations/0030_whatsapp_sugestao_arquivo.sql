-- 0030 · WhatsApp: "não é desta missão" para a sugestão grupo ↔ missão e envio de arquivo.
--
-- * whatsapp_link_dismissals: quem acompanha o número recusou a sugestão de
--   ligar a conversa a uma missão (pelo número da missão no nome do grupo);
--   a sugestão não volta.
-- * whatsapp_outbox: arquivo enviado pelo Omni (nome, tipo e tamanho; o
--   conteúdo não fica no banco). A legenda pode ficar vazia quando há arquivo.

CREATE TABLE whatsapp_link_dismissals (
  chat_id       uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  mission_id    uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  dismissed_by  uuid NOT NULL REFERENCES people(id),
  dismissed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, mission_id)
);
ALTER TABLE whatsapp_link_dismissals ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON whatsapp_link_dismissals TO omni_app;
CREATE POLICY wa_dismissals_ver ON whatsapp_link_dismissals FOR SELECT TO omni_app
  USING (EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = chat_id AND app.ve_numero_whatsapp(c.number_id)));
CREATE POLICY wa_dismissals_recusar ON whatsapp_link_dismissals FOR INSERT TO omni_app
  WITH CHECK (dismissed_by = app.current_person_id()
              AND EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = chat_id AND app.ve_numero_whatsapp(c.number_id)));

ALTER TABLE whatsapp_outbox
  ADD COLUMN file_name text CHECK (length(file_name) BETWEEN 1 AND 255),
  ADD COLUMN file_mime text CHECK (file_mime ~ '^[a-z]+/[a-z0-9.+-]+$'),
  ADD COLUMN file_size integer CHECK (file_size BETWEEN 1 AND 16777216);
ALTER TABLE whatsapp_outbox DROP CONSTRAINT whatsapp_outbox_body_check;
ALTER TABLE whatsapp_outbox ADD CONSTRAINT whatsapp_outbox_body_check
  CHECK (length(body) <= 4096 AND (length(btrim(body)) >= 1 OR file_name IS NOT NULL));
ALTER TABLE whatsapp_outbox ADD CONSTRAINT whatsapp_outbox_arquivo_completo
  CHECK ((file_name IS NULL) = (file_mime IS NULL) AND (file_name IS NULL) = (file_size IS NULL));
