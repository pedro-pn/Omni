-- 0023 · Desvincular um e-mail de uma missão (vínculo automático errado).
--
-- A exclusão é guardada pelo internetMessageId (sobrevive a o e-mail sair e
-- voltar do banco) e o worker não religa o par. E-mail que fica sem missão sai
-- do banco (só guardamos e-mails ligados a missões). Diretoria e gerentes.

CREATE TABLE mail_link_exclusions (
  internet_message_id  text NOT NULL,
  mission_id           uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  excluded_by          uuid NOT NULL REFERENCES people(id),
  excluded_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (internet_message_id, mission_id)
);

GRANT SELECT ON mail_link_exclusions TO omni_worker;
ALTER TABLE mail_link_exclusions ENABLE ROW LEVEL SECURITY;
CREATE POLICY exclusions_worker ON mail_link_exclusions FOR SELECT TO omni_worker USING (true);

CREATE FUNCTION app.desvincular_email(p_message uuid, p_mission uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_imid text;
  BEGIN
    IF NOT app.ve_emails() THEN RETURN false; END IF;
    SELECT internet_message_id INTO v_imid FROM mail_messages WHERE id = p_message;
    IF v_imid IS NULL OR NOT EXISTS (SELECT 1 FROM mail_message_missions WHERE message_id = p_message AND mission_id = p_mission) THEN
      RETURN false;
    END IF;
    INSERT INTO mail_link_exclusions (internet_message_id, mission_id, excluded_by)
      VALUES (v_imid, p_mission, app.current_person_id()) ON CONFLICT DO NOTHING;
    DELETE FROM mail_message_missions WHERE message_id = p_message AND mission_id = p_mission;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
      VALUES (app.current_person_id(), 'email.desvinculado', 'mail_message', p_message::text, jsonb_build_object('mission_id', p_mission));
    -- Sem nenhuma missão, o e-mail sai do Omni.
    DELETE FROM mail_messages m WHERE m.id = p_message AND NOT EXISTS (SELECT 1 FROM mail_message_missions l WHERE l.message_id = m.id);
    RETURN true;
  END $$;

GRANT EXECUTE ON FUNCTION app.desvincular_email(uuid, uuid) TO omni_app;
