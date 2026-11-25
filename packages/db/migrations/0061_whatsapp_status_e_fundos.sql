-- Status de entrega/leitura na hora e plano de fundo das conversas (13/11/2026).

-- 1. Status (✓ enviada, ✓✓ entregue, ✓✓ azul lida): o WhatsApp manda o status pela
--    conversa do número ou pelo @lid da pessoa (0048); antes só o número contava.
--    Avisa a tela (omni_whatsapp com "status": o worker não manda notificação disso).
CREATE OR REPLACE FUNCTION app.whatsapp_registrar_status(p_instancia text, p_chat_jid text, p_wa_id text, p_status text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_chat uuid; v_number uuid;
  BEGIN
    IF p_status NOT IN ('enviada', 'entregue', 'lida', 'erro') THEN RETURN; END IF;
    WITH u AS (
      UPDATE whatsapp_messages m SET status = p_status
        FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
       WHERE m.chat_id = c.id AND n.instance_name = p_instancia AND (c.jid = p_chat_jid OR c.lid = p_chat_jid) AND m.wa_id = p_wa_id
         -- só avança (lida não volta para entregue)
         AND array_position(ARRAY['enviada', 'entregue', 'lida'], p_status) > coalesce(array_position(ARRAY['enviada', 'entregue', 'lida'], m.status), 0)
      RETURNING c.id AS chat, c.number_id AS numero
    )
    SELECT chat, numero INTO v_chat, v_number FROM u LIMIT 1;
    IF v_chat IS NOT NULL THEN
      PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', v_number, 'chatId', v_chat, 'status', true)::text);
    END IF;
  END $$;

-- 2. Plano de fundo das conversas, de cada pessoa: geral (chat_id NULL) ou por conversa.
--    Formato "<cor>|<padrão>": cor de uma lista ou #rrggbb; padrão nenhum, pontos, grade ou listras.
CREATE TABLE whatsapp_fundos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  chat_id uuid REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  fundo text NOT NULL CHECK (fundo ~ '^([a-z]{3,12}|#[0-9a-f]{6})\|(nenhum|pontos|grade|listras)$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX whatsapp_fundos_geral ON whatsapp_fundos (person_id) WHERE chat_id IS NULL;
CREATE UNIQUE INDEX whatsapp_fundos_conversa ON whatsapp_fundos (person_id, chat_id) WHERE chat_id IS NOT NULL;

ALTER TABLE whatsapp_fundos ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_fundos_proprios ON whatsapp_fundos FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id() AND (chat_id IS NULL OR app.ve_conversa_whatsapp(chat_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_fundos TO omni_app;
