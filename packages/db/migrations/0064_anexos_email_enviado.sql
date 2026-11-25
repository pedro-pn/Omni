-- Anexos nos e-mails enviados pelo Omni (16/11/2026): o registro de envio guarda o
-- nome, o tipo e o tamanho de cada anexo (o conteúdo vai ao Microsoft 365 e não fica no Omni).
ALTER TABLE mail_outbox ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(attachments) = 'array' AND jsonb_array_length(attachments) <= 20);
