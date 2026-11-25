-- Lida / não lida nas conversas do WhatsApp (24/11/2026), por pessoa, como no WhatsApp:
-- até quando a pessoa leu a conversa e se ela marcou como não lida. Abrir a conversa (e ler
-- até o fim) marca como lida; na lista, clique, botão direito ou deslizar marcam e desmarcam.
-- Só no Omni: nada vai para o WhatsApp (o "visto" azul do contato continua do celular).

CREATE TABLE whatsapp_chat_reads (
  person_id      uuid NOT NULL DEFAULT app.current_person_id() REFERENCES people(id) ON DELETE CASCADE,
  chat_id        uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  read_at        timestamptz NOT NULL DEFAULT now(),
  marked_unread  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (person_id, chat_id)
);
ALTER TABLE whatsapp_chat_reads ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_chat_reads_minhas ON whatsapp_chat_reads FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id() AND chat_id IN (SELECT app.conversas_que_vejo()));
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_chat_reads TO omni_app;

-- O que já existe conta como lido agora (senão todo o histórico apareceria como não lido).
INSERT INTO whatsapp_chat_reads (person_id, chat_id, read_at)
SELECT n.owner_person_id, c.id, now()
  FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
 WHERE n.owner_person_id IS NOT NULL
ON CONFLICT DO NOTHING;
