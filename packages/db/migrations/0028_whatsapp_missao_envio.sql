-- 0028 · WhatsApp: grupo da missão, importação do histórico (só o escolhido) e envio.
--
-- * whatsapp_chat_missions: conversa (normalmente o grupo da missão) ligada a
--   uma missão. Quem vê o Interno da missão passa a ler essa conversa (e só ela).
-- * whatsapp_history_imports: pedido da administração para trazer o histórico
--   dos grupos escolhidos (opção A, decidida em 05/11/2026). O worker atende;
--   o que não foi escolhido nunca entra no Omni.
-- * whatsapp_outbox: respostas escritas no Omni. Só a partir de uma conversa do
--   WhatsApp (origem 'conversa'): mensagens do Interno e do Gerencial não têm
--   caminho até aqui (CHECK + nenhuma ligação com mission_messages). Em ensaio
--   fica registrada e não sai.

-- ---------------------------------------------------------------- grupo ↔ missão
CREATE TABLE whatsapp_chat_missions (
  chat_id     uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  mission_id  uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  linked_by   uuid REFERENCES people(id),
  linked_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, mission_id)
);
CREATE INDEX whatsapp_chat_missions_mission ON whatsapp_chat_missions (mission_id);

-- Quem lê uma conversa: quem vê o número, ou quem vê o Interno de uma missão ligada a ela.
CREATE FUNCTION app.ve_conversa_whatsapp(p_chat uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = p_chat AND app.ve_numero_whatsapp(c.number_id))
        OR EXISTS (SELECT 1 FROM whatsapp_chat_missions l WHERE l.chat_id = p_chat AND app.ve_interno(l.mission_id, app.current_person_id()))
  $$;
GRANT EXECUTE ON FUNCTION app.ve_conversa_whatsapp(uuid) TO omni_app;

DROP POLICY wa_chats_ver ON whatsapp_chats;
DROP POLICY wa_messages_ver ON whatsapp_messages;
CREATE POLICY wa_chats_ver    ON whatsapp_chats FOR SELECT TO omni_app USING (app.ve_conversa_whatsapp(id));
CREATE POLICY wa_messages_ver ON whatsapp_messages FOR SELECT TO omni_app USING (app.ve_conversa_whatsapp(chat_id));

ALTER TABLE whatsapp_chat_missions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON whatsapp_chat_missions TO omni_app;
-- Liga/desliga quem vê o número (responsável, membros, diretoria); lê quem vê a conversa.
CREATE POLICY wa_links_ver    ON whatsapp_chat_missions FOR SELECT TO omni_app USING (app.ve_conversa_whatsapp(chat_id));
CREATE POLICY wa_links_ligar  ON whatsapp_chat_missions FOR INSERT TO omni_app
  WITH CHECK (linked_by = app.current_person_id()
              AND EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = chat_id AND app.ve_numero_whatsapp(c.number_id)));
CREATE POLICY wa_links_tirar  ON whatsapp_chat_missions FOR DELETE TO omni_app
  USING (EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = chat_id AND app.ve_numero_whatsapp(c.number_id)));

-- ---------------------------------------------------------------- histórico escolhido
CREATE TABLE whatsapp_history_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id     uuid NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  -- Só grupos (…@g.us): conversas individuais não entram (decisão de 05/11/2026).
  group_jids    text[] NOT NULL CHECK (cardinality(group_jids) BETWEEN 1 AND 200
                                       AND array_to_string(group_jids, ',') ~ '^([\d-]{6,40}@g\.us)(,[\d-]{6,40}@g\.us)*$'),
  requested_by  uuid REFERENCES people(id),
  status        text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'importando', 'concluida', 'erro')),
  imported      integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
ALTER TABLE whatsapp_history_imports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON whatsapp_history_imports TO omni_app;
CREATE POLICY wa_imports_admin ON whatsapp_history_imports FOR ALL TO omni_app USING (app.has_profile('admin')) WITH CHECK (app.has_profile('admin'));

-- ---------------------------------------------------------------- envio
CREATE TABLE whatsapp_outbox (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  origem      text NOT NULL DEFAULT 'conversa' CHECK (origem = 'conversa'),
  body        text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 4096),
  mode        text NOT NULL CHECK (mode IN ('ensaio', 'real')),
  status      text NOT NULL DEFAULT 'registrada' CHECK (status IN ('registrada', 'enviada', 'erro')),
  wa_id       text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_outbox_chat ON whatsapp_outbox (chat_id, created_at);
ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON whatsapp_outbox TO omni_app;
GRANT UPDATE (status, wa_id, error) ON whatsapp_outbox TO omni_app;
-- Responde quem vê o número (não basta ver a missão); sempre em nome de si mesmo.
CREATE POLICY wa_outbox_enviar ON whatsapp_outbox FOR INSERT TO omni_app
  WITH CHECK (person_id = app.current_person_id()
              AND EXISTS (SELECT 1 FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
                           WHERE c.id = chat_id AND n.status = 'conectado' AND app.ve_numero_whatsapp(c.number_id)));
CREATE POLICY wa_outbox_ver    ON whatsapp_outbox FOR SELECT TO omni_app USING (app.ve_conversa_whatsapp(chat_id));
CREATE POLICY wa_outbox_marcar ON whatsapp_outbox FOR UPDATE TO omni_app USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());

-- ---------------------------------------------------------------- worker
GRANT SELECT, INSERT, UPDATE ON whatsapp_chats, whatsapp_messages TO omni_worker;
GRANT SELECT, UPDATE ON whatsapp_history_imports TO omni_worker;
GRANT SELECT ON whatsapp_chat_missions TO omni_worker;
CREATE POLICY wa_chats_worker    ON whatsapp_chats           FOR ALL    TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY wa_messages_worker ON whatsapp_messages        FOR ALL    TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY wa_imports_worker  ON whatsapp_history_imports FOR ALL    TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY wa_links_worker    ON whatsapp_chat_missions   FOR SELECT TO omni_worker USING (true);

-- O webhook dá nome ao grupo quando a Evolution informar (o worker também, ao importar).
CREATE FUNCTION app.whatsapp_nomear_conversa(p_instancia text, p_jid text, p_nome text) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE whatsapp_chats c SET name = left(btrim(p_nome), 120)
      FROM whatsapp_numbers n
     WHERE n.id = c.number_id AND n.instance_name = p_instancia AND c.jid = p_jid AND length(btrim(coalesce(p_nome, ''))) > 0
  $$;
GRANT EXECUTE ON FUNCTION app.whatsapp_nomear_conversa(text, text, text) TO omni_app, omni_worker;
