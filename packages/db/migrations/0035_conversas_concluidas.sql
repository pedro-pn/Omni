-- Inbox zero nas Conversas (INSTRUCOES §6, "Concluir"): cada pessoa conclui as
-- próprias conversas; a conversa volta sozinha quando chega mensagem nova do
-- contato depois da conclusão. A busca continua achando as concluídas.
-- Só a própria pessoa lê e grava as suas conclusões, e só de conversas que ela vê.

CREATE TABLE whatsapp_chat_concluded (
  person_id     uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  chat_id       uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  concluded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, chat_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_chat_concluded TO omni_app;

ALTER TABLE whatsapp_chat_concluded ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_chat_concluded_propria ON whatsapp_chat_concluded FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id() AND app.ve_conversa_whatsapp(chat_id));
