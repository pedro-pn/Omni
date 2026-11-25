-- Gravações das ligações guardadas por 5 anos na produção (decisão de 11/11/2026,
-- LGPD; CHAMADA_RETENCAO_HORAS no serviço de voz, até 10 anos). A 0032 limitava o
-- vencimento no banco a 7 dias depois da ligação (teto da prova de conceito): o
-- arquivo continuaria no serviço de voz, mas o Omni deixaria de mostrá-lo. O teto
-- passa a ser o mesmo do serviço de voz. O dono continua podendo excluir a qualquer
-- momento (app.excluir_gravacao).

CREATE OR REPLACE FUNCTION app.chamada_registrar(
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
      VALUES(p_number,p_owner,p_record,p_peer,p_direction,p_state,p_created,p_started,p_ended,p_recording,p_audio AND p_recording,p_error,least(p_expires,p_created+interval '10 years'));
  ELSE
    IF v_call.ended_at IS NOT NULL AND p_ended IS NULL THEN RETURN true; END IF;
    IF p_recording AND NOT v_call.recording AND NOT v_allowed THEN RETURN false; END IF;
    UPDATE whatsapp_calls SET state=p_state, started_at=coalesce(p_started,started_at), ended_at=coalesce(p_ended,ended_at),
      recording=recording OR p_recording, audio=p_audio AND p_recording AND deleted_at IS NULL,
      recording_error=p_error WHERE id=v_call.id;
  END IF;
  RETURN true;
END $$;
