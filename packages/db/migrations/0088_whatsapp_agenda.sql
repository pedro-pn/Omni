-- Agenda do celular no Omni (26/11/2026): nomes como no WhatsApp Web.
--   * whatsapp_contacts: os contatos SALVOS na agenda do celular de cada número (nome salvo pela
--     pessoa), lidos pela ponte de ações da Evolution (job whatsapp-agenda) e por "Adicionar
--     contato" no Omni (que salva no celular). O nome de perfil (o que a pessoa escolheu no
--     WhatsApp) não entra aqui.
--   * Com a agenda lida (whatsapp_numbers.contacts_synced_at), a conversa com quem não está salvo
--     mostra o número (e o nome de perfil discreto, "~ Nome"); antes disso, vale o nome de sempre.

ALTER TABLE whatsapp_numbers ADD COLUMN contacts_synced_at timestamptz;

CREATE TABLE whatsapp_contacts (
  number_id   uuid NOT NULL REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
  jid         text NOT NULL CHECK (jid ~ '^\d{5,20}@(s\.whatsapp\.net|lid)$'),
  lid         text,
  phone       text CHECK (phone IS NULL OR phone ~ '^\d{8,15}$'),
  saved_name  text NOT NULL CHECK (char_length(btrim(saved_name)) BETWEEN 1 AND 120),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (number_id, jid)
);
CREATE INDEX whatsapp_contacts_telefone ON whatsapp_contacts (number_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX whatsapp_contacts_lid ON whatsapp_contacts (number_id, lid) WHERE lid IS NOT NULL;

ALTER TABLE whatsapp_contacts ENABLE ROW LEVEL SECURITY;
-- Lê a agenda quem vê alguma conversa do número (o dono; e, nos grupos das missões, quem vê o Interno).
CREATE POLICY wa_contacts_ver ON whatsapp_contacts FOR SELECT TO omni_app
  USING (number_id IN (SELECT c.number_id FROM whatsapp_chats c WHERE c.id IN (SELECT app.conversas_que_vejo())));
-- "Adicionar contato": só o dono do número.
CREATE POLICY wa_contacts_dono ON whatsapp_contacts FOR INSERT TO omni_app
  WITH CHECK (EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = number_id AND n.owner_person_id = app.current_person_id()));
CREATE POLICY wa_contacts_dono_mudar ON whatsapp_contacts FOR UPDATE TO omni_app
  USING (EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = number_id AND n.owner_person_id = app.current_person_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = number_id AND n.owner_person_id = app.current_person_id()));
CREATE POLICY wa_contacts_worker ON whatsapp_contacts FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON whatsapp_contacts TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_contacts TO omni_worker;

-- A agenda inteira de um número (o worker): troca pela lista nova e marca quando leu.
CREATE FUNCTION app.whatsapp_salvar_agenda(p_number uuid, p_contatos jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE n integer;
  BEGIN
    WITH novos AS (
      SELECT DISTINCT ON (x->>'jid') x->>'jid' AS jid, nullif(x->>'lid', '') AS lid,
             nullif(regexp_replace(coalesce(x->>'telefone', ''), '\D', '', 'g'), '') AS phone, left(btrim(x->>'nome'), 120) AS nome
        FROM jsonb_array_elements(p_contatos) x
       WHERE x->>'jid' ~ '^\d{5,20}@(s\.whatsapp\.net|lid)$' AND btrim(coalesce(x->>'nome', '')) <> ''
    ), apagar AS (
      DELETE FROM whatsapp_contacts c WHERE c.number_id = p_number AND c.jid NOT IN (SELECT jid FROM novos)
    )
    INSERT INTO whatsapp_contacts (number_id, jid, lid, phone, saved_name, updated_at)
    SELECT p_number, jid, lid, CASE WHEN phone ~ '^\d{8,15}$' THEN phone END, nome, now() FROM novos
    ON CONFLICT (number_id, jid) DO UPDATE SET lid = EXCLUDED.lid, phone = EXCLUDED.phone, saved_name = EXCLUDED.saved_name, updated_at = now();
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE whatsapp_numbers SET contacts_synced_at = now() WHERE id = p_number;
    PERFORM pg_notify('omni_whatsapp', json_build_object('numberId', p_number, 'agenda', true)::text);
    RETURN n;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_salvar_agenda(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_salvar_agenda(uuid, jsonb) TO omni_worker;
