-- Chamadas: somente o dono do número controla a linha. Gravações privadas,
-- compartilhadas individualmente pelo dono; nenhum acesso implícito da gestão.
CREATE TABLE whatsapp_call_permissions (
  person_id uuid PRIMARY KEY REFERENCES people(id),
  can_record boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES people(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE whatsapp_call_permissions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON whatsapp_call_permissions TO omni_app;
CREATE POLICY call_permissions_admin ON whatsapp_call_permissions FOR ALL TO omni_app
  USING (app.has_profile('admin')) WITH CHECK (app.has_profile('admin'));
CREATE POLICY call_permissions_self ON whatsapp_call_permissions FOR SELECT TO omni_app
  USING (person_id = app.current_person_id());

CREATE TABLE whatsapp_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number_id uuid NOT NULL REFERENCES whatsapp_numbers(id),
  owner_person_id uuid NOT NULL REFERENCES people(id),
  recording_id text NOT NULL CHECK (recording_id ~ '^[a-f0-9]{32}$'),
  peer text NOT NULL CHECK (peer ~ '^[1-9][0-9]{9,14}$'),
  direction text NOT NULL CHECK (direction IN ('entrada','saida')),
  state text NOT NULL CHECK (state IN ('ligando','recebendo','tocando','conectando','ativa','encerrada')),
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  ended_at timestamptz,
  recording boolean NOT NULL DEFAULT false,
  audio boolean NOT NULL DEFAULT false,
  recording_error boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  UNIQUE (number_id, owner_person_id, recording_id)
);
CREATE INDEX whatsapp_calls_owner ON whatsapp_calls(owner_person_id, created_at DESC);
CREATE TABLE whatsapp_call_shares (
  call_id uuid NOT NULL REFERENCES whatsapp_calls(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id),
  shared_by uuid NOT NULL REFERENCES people(id),
  shared_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(call_id, person_id)
);

CREATE FUNCTION app.chamada_dono(p_call uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM whatsapp_calls c JOIN people p ON p.id=c.owner_person_id
      WHERE c.id=p_call AND p.id=app.current_person_id() AND p.active)
  $$;
CREATE FUNCTION app.ve_chamada(p_call uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM people p WHERE p.id=app.current_person_id() AND p.active)
      AND EXISTS (SELECT 1 FROM whatsapp_calls c WHERE c.id=p_call AND (
        c.owner_person_id=app.current_person_id() OR (
          c.audio AND c.deleted_at IS NULL AND c.expires_at>now() AND
          EXISTS (SELECT 1 FROM whatsapp_call_shares s WHERE s.call_id=c.id AND s.person_id=app.current_person_id())
        )))
  $$;
CREATE FUNCTION app.pode_usar_linha_chamada(p_number uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (SELECT 1 FROM whatsapp_numbers n JOIN people p ON p.id=n.owner_person_id
      WHERE n.id=p_number AND n.status<>'removido' AND p.id=app.current_person_id() AND p.active)
  $$;
GRANT EXECUTE ON FUNCTION app.chamada_dono(uuid), app.ve_chamada(uuid), app.pode_usar_linha_chamada(uuid) TO omni_app;

ALTER TABLE whatsapp_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_call_shares ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON whatsapp_calls TO omni_app;
GRANT SELECT, INSERT, DELETE ON whatsapp_call_shares TO omni_app;
CREATE POLICY calls_read ON whatsapp_calls FOR SELECT TO omni_app USING (app.ve_chamada(id));
CREATE POLICY shares_read ON whatsapp_call_shares FOR SELECT TO omni_app USING (app.chamada_dono(call_id) OR person_id=app.current_person_id());
CREATE POLICY shares_insert ON whatsapp_call_shares FOR INSERT TO omni_app WITH CHECK (
  app.chamada_dono(call_id) AND shared_by=app.current_person_id() AND person_id<>app.current_person_id()
  AND EXISTS (SELECT 1 FROM people p WHERE p.id=person_id AND p.active)
  AND EXISTS (SELECT 1 FROM whatsapp_calls c WHERE c.id=call_id AND c.audio AND c.ended_at IS NOT NULL AND c.deleted_at IS NULL AND c.expires_at>now())
);
CREATE POLICY shares_delete ON whatsapp_call_shares FOR DELETE TO omni_app USING (app.chamada_dono(call_id));

-- Chamado somente pelo endpoint autenticado de eventos do motor. Replay é
-- idempotente; o dono de uma chamada finalizada nunca muda com o dono da linha.
CREATE FUNCTION app.chamada_registrar(
  p_number uuid, p_owner uuid, p_record text, p_peer text, p_direction text,
  p_state text, p_created timestamptz, p_started timestamptz, p_ended timestamptz,
  p_recording boolean, p_audio boolean, p_error boolean, p_expires timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_call whatsapp_calls; v_allowed boolean;
BEGIN
  SELECT * INTO v_call FROM whatsapp_calls WHERE number_id=p_number AND owner_person_id=p_owner AND recording_id=p_record FOR UPDATE;
  SELECT coalesce((SELECT can_record FROM whatsapp_call_permissions WHERE person_id=p_owner),false) INTO v_allowed;
  IF v_call.id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM whatsapp_numbers n JOIN people p ON p.id=n.owner_person_id
      WHERE n.id=p_number AND n.owner_person_id=p_owner AND n.status<>'removido' AND p.active) THEN RETURN false; END IF;
    IF p_recording AND NOT v_allowed THEN RETURN false; END IF;
    INSERT INTO whatsapp_calls(number_id,owner_person_id,recording_id,peer,direction,state,created_at,started_at,ended_at,recording,audio,recording_error,expires_at)
      VALUES(p_number,p_owner,p_record,p_peer,p_direction,p_state,p_created,p_started,p_ended,p_recording,p_audio AND p_recording,p_error,least(p_expires,p_created+interval '7 days'));
  ELSE
    IF v_call.ended_at IS NOT NULL AND p_ended IS NULL THEN RETURN true; END IF;
    IF p_recording AND NOT v_call.recording AND NOT v_allowed THEN RETURN false; END IF;
    UPDATE whatsapp_calls SET state=p_state, started_at=coalesce(p_started,started_at), ended_at=coalesce(p_ended,ended_at),
      recording=recording OR p_recording, audio=p_audio AND p_recording AND deleted_at IS NULL,
      recording_error=p_error WHERE id=v_call.id;
  END IF;
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION app.chamada_registrar(uuid,uuid,text,text,text,text,timestamptz,timestamptz,timestamptz,boolean,boolean,boolean,timestamptz) TO omni_app;

CREATE FUNCTION app.excluir_gravacao(p_call uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT app.chamada_dono(p_call) THEN RETURN false; END IF;
  UPDATE whatsapp_calls SET deleted_at=now(),audio=false WHERE id=p_call;
  DELETE FROM whatsapp_call_shares WHERE call_id=p_call;
  INSERT INTO audit_log(actor_person_id,action,entity_type,entity_id) VALUES(app.current_person_id(),'chamada.gravacao_excluida','whatsapp_call',p_call);
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION app.excluir_gravacao(uuid) TO omni_app;

CREATE FUNCTION app.pessoas_para_compartilhar_gravacao() RETURNS TABLE(id uuid,nome text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT p.id,p.display_name FROM people p WHERE p.active AND p.id<>app.current_person_id()
      AND EXISTS (SELECT 1 FROM people eu WHERE eu.id=app.current_person_id() AND eu.active)
    ORDER BY p.display_name
  $$;
GRANT EXECUTE ON FUNCTION app.pessoas_para_compartilhar_gravacao() TO omni_app;
