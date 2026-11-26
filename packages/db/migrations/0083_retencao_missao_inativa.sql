-- Missão inativa sem data de encerramento também vence (E15, ajuste da 0081, 26/11/2026).
--
-- O filtroAPP só manda o status (e as datas de encerramento) das missões ativas: a que fica
-- inativa (marcada assim no filtroAPP ou que sumiu da lista) nunca recebe cycle_closed_at nem
-- closed_at, e pela 0081 nunca venceria. Agora o Omni guarda quando ela ficou inativa
-- (`inativada_em`, por gatilho) e a retenção conta os 5 anos da primeira data que houver, nesta
-- ordem: ciclo fechado, missão fechada, inativação. As que já estão inativas recebem a última
-- atualização vinda do filtroAPP (o mais perto que se sabe do encerramento).

ALTER TABLE missions ADD COLUMN inativada_em timestamptz;
UPDATE missions SET inativada_em = filtroapp_updated_at WHERE NOT is_active;

CREATE FUNCTION app.marcar_inativacao_missao() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.is_active THEN
    NEW.inativada_em := NULL;
  ELSIF TG_OP = 'INSERT' OR OLD.is_active THEN
    NEW.inativada_em := coalesce(NEW.inativada_em, now());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER missions_inativacao BEFORE INSERT OR UPDATE OF is_active ON missions
  FOR EACH ROW EXECUTE FUNCTION app.marcar_inativacao_missao();

CREATE OR REPLACE FUNCTION app.aplicar_retencao(p_aplicar boolean) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  r jsonb := '{}'::jsonb;
  n bigint;
  v_missoes uuid[];
  v_mensagens uuid[];
  v_perguntas uuid[];
  v_emails uuid[];
  v_reunioes uuid[];
  v_tarefas uuid[];
BEGIN
  -- ------------------------------------------------------------ dados técnicos (0066)

  -- Sessões encerradas (expiradas ou revogadas) há mais de 30 dias.
  IF p_aplicar THEN
    DELETE FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM sessions WHERE coalesce(revoked_at, expires_at) < now() - interval '30 days';
  END IF;
  r := r || jsonb_build_object('sessoes', n);

  -- Avisos do sino: lidos há mais de 180 dias; qualquer um com mais de 1 ano.
  IF p_aplicar THEN
    DELETE FROM notifications WHERE (read_at IS NOT NULL AND created_at < now() - interval '180 days') OR created_at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM notifications WHERE (read_at IS NOT NULL AND created_at < now() - interval '180 days') OR created_at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('avisos', n);

  -- Registro dos e-mails de aviso e das chamadas à IA (metadados): 1 ano.
  IF p_aplicar THEN
    DELETE FROM notification_emails WHERE created_at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM notification_emails WHERE created_at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('emails_de_aviso', n);
  IF p_aplicar THEN
    DELETE FROM llm_calls WHERE created_at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM llm_calls WHERE created_at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('chamadas_ia', n);

  -- Registro de downloads (alertas de risco): 1 ano.
  IF p_aplicar THEN
    PERFORM set_config('omni.retencao', 'on', true);
    DELETE FROM audit_log WHERE action = 'arquivo.baixado' AND at < now() - interval '365 days';
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('omni.retencao', 'off', true);
  ELSE
    SELECT count(*) INTO n FROM audit_log WHERE action = 'arquivo.baixado' AND at < now() - interval '365 days';
  END IF;
  r := r || jsonb_build_object('downloads', n);

  -- Alertas de risco: 2 anos.
  IF p_aplicar THEN
    DELETE FROM risk_alerts WHERE created_at < now() - interval '2 years';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM risk_alerts WHERE created_at < now() - interval '2 years';
  END IF;
  r := r || jsonb_build_object('alertas_de_risco', n);

  -- Termo aceito: IP e navegador anonimizados depois de 2 anos (a prova do aceite fica).
  IF p_aplicar THEN
    UPDATE terms_acceptances SET ip = NULL, user_agent = NULL WHERE aceito_em < now() - interval '2 years' AND (ip IS NOT NULL OR user_agent IS NOT NULL);
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM terms_acceptances WHERE aceito_em < now() - interval '2 years' AND (ip IS NOT NULL OR user_agent IS NOT NULL);
  END IF;
  r := r || jsonb_build_object('termos_anonimizados', n);

  -- ------------------------------------------------------------ dados de negócio (0081)

  -- Missões encerradas há mais de 5 anos (sem data de encerramento, conta de quando ficou inativa; 0083).
  v_missoes := ARRAY(
    SELECT id FROM missions WHERE NOT is_active AND coalesce(cycle_closed_at, closed_at, inativada_em) < now() - interval '5 years'
  );
  r := r || jsonb_build_object('missoes_vencidas', cardinality(v_missoes));

  -- Interno e Gerencial dessas missões, com as perguntas da IA (e o que elas geraram).
  v_mensagens := ARRAY(SELECT id FROM mission_messages WHERE mission_id = ANY (v_missoes));
  v_perguntas := ARRAY(SELECT id FROM ai_questions WHERE mission_id = ANY (v_missoes));
  SELECT count(*) INTO n FROM mission_message_files WHERE message_id = ANY (v_mensagens);
  r := r || jsonb_build_object('mensagens_dos_canais', cardinality(v_mensagens), 'arquivos_dos_canais', n, 'perguntas_da_ia', cardinality(v_perguntas));
  IF p_aplicar THEN
    INSERT INTO arquivos_para_apagar (sp_drive_id, sp_item_id, origem)
      SELECT sp_drive_id, sp_item_id, 'canal' FROM mission_message_files WHERE message_id = ANY (v_mensagens)
      ON CONFLICT DO NOTHING;
    DELETE FROM ai_deviations WHERE question_id = ANY (v_perguntas);
    DELETE FROM ai_unloadings WHERE question_id = ANY (v_perguntas);
    DELETE FROM ai_questions WHERE id = ANY (v_perguntas);
    DELETE FROM mission_messages WHERE id = ANY (v_mensagens);
  END IF;

  -- E-mails ligados a missões: vencem quando toda missão a que se ligam venceu (ou, sem ligação,
  -- recebidos há mais de 5 anos).
  v_emails := ARRAY(
    SELECT m.id FROM mail_messages m
     WHERE NOT EXISTS (SELECT 1 FROM mail_message_missions l WHERE l.message_id = m.id AND NOT (l.mission_id = ANY (v_missoes)))
       AND (EXISTS (SELECT 1 FROM mail_message_missions l WHERE l.message_id = m.id)
            OR coalesce(m.received_at, m.sent_at, m.first_seen_at) < now() - interval '5 years')
  );
  r := r || jsonb_build_object('emails_das_missoes', cardinality(v_emails));
  IF p_aplicar THEN
    DELETE FROM mail_messages WHERE id = ANY (v_emails);
  END IF;

  -- Reuniões do Teams: a mesma regra dos e-mails.
  v_reunioes := ARRAY(
    SELECT m.id FROM meetings m
     WHERE NOT EXISTS (SELECT 1 FROM meeting_missions l WHERE l.meeting_id = m.id AND NOT (l.mission_id = ANY (v_missoes)))
       AND (EXISTS (SELECT 1 FROM meeting_missions l WHERE l.meeting_id = m.id)
            OR coalesce(m.ends_at, m.starts_at, m.first_seen_at) < now() - interval '5 years')
  );
  r := r || jsonb_build_object('reunioes', cardinality(v_reunioes));
  IF p_aplicar THEN
    DELETE FROM meetings WHERE id = ANY (v_reunioes);
  END IF;

  -- WhatsApp guardado no Omni e envios pelo Omni: 5 anos.
  IF p_aplicar THEN
    DELETE FROM whatsapp_messages WHERE coalesce(sent_at, created_at) < now() - interval '5 years';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM whatsapp_messages WHERE coalesce(sent_at, created_at) < now() - interval '5 years';
  END IF;
  r := r || jsonb_build_object('whatsapp_mensagens', n);
  IF p_aplicar THEN
    DELETE FROM whatsapp_outbox WHERE created_at < now() - interval '5 years';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM whatsapp_outbox WHERE created_at < now() - interval '5 years';
  END IF;
  r := r || jsonb_build_object('whatsapp_envios', n);
  IF p_aplicar THEN
    DELETE FROM mail_outbox WHERE created_at < now() - interval '5 years';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM mail_outbox WHERE created_at < now() - interval '5 years';
  END IF;
  r := r || jsonb_build_object('emails_enviados', n);

  -- Cabeçalhos da caixa pessoal (caixa única): 1 ano depois da janela de 90 dias.
  IF p_aplicar THEN
    DELETE FROM mail_items WHERE coalesce(received_at, sent_at, created_at) < now() - interval '455 days';
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    SELECT count(*) INTO n FROM mail_items WHERE coalesce(received_at, sent_at, created_at) < now() - interval '455 days';
  END IF;
  r := r || jsonb_build_object('caixa_pessoal', n);

  -- Tarefas pessoais (fora de projeto) de quem foi desativado há mais de 2 anos.
  v_tarefas := ARRAY(
    SELECT t.id FROM tasks t JOIN people p ON p.id = t.owner_person_id
     WHERE t.project_id IS NULL AND NOT p.active AND p.deactivated_at < now() - interval '2 years'
  );
  SELECT count(*) INTO n FROM task_attachments WHERE task_id = ANY (v_tarefas);
  r := r || jsonb_build_object('tarefas_pessoais', cardinality(v_tarefas), 'anexos_das_tarefas', n);
  IF p_aplicar THEN
    INSERT INTO arquivos_para_apagar (sp_drive_id, sp_item_id, origem)
      SELECT sp_drive_id, sp_item_id, 'tarefa' FROM task_attachments WHERE task_id = ANY (v_tarefas)
      ON CONFLICT DO NOTHING;
    DELETE FROM tasks WHERE id = ANY (v_tarefas);
  END IF;

  SELECT count(*) INTO n FROM arquivos_para_apagar;
  RETURN r || jsonb_build_object('arquivos_na_fila', n, 'aplicado', p_aplicar);
END $$;
REVOKE ALL ON FUNCTION app.aplicar_retencao(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aplicar_retencao(boolean) TO omni_worker;
