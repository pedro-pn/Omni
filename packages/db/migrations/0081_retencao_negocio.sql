-- Retenção dos dados de negócio (E15, pilar 9; decisão de 26/11/2026, sugestões de
-- docs/producao/retencao.md). Continua num lugar só, app.aplicar_retencao, que passa a cobrir:
--
--   Missão encerrada há mais de 5 anos (inativa e com o ciclo ou a missão fechados):
--     mensagens do Interno e do Gerencial (e os arquivos no SharePoint), perguntas da IA e o que
--     elas geraram, e-mails ligados a ela e reuniões do Teams ligadas a ela.
--   5 anos: mensagens do WhatsApp guardadas no Omni, e-mails e mensagens enviados pelo Omni.
--   1 ano e 90 dias: cabeçalhos da caixa pessoal (caixa única; a leitura cobre 90 dias).
--   Pessoa desativada há mais de 2 anos: as tarefas pessoais dela (caixa própria, fora de projeto;
--   a caixa não se delega) e os anexos.
--
-- Missão sem data de encerramento nunca vence (não se apaga pelo que não se sabe). Tarefas de
-- projetos ficam: são do projeto, não da pessoa. Gravações das ligações seguem o prazo próprio
-- (chamadas-arquivar). Arquivos no SharePoint não se apagam do banco: os ids vão para
-- `arquivos_para_apagar` na mesma transação e o worker os apaga de vez (job retencao).

-- Quando a pessoa foi desativada (as tarefas pessoais vencem 2 anos depois).
ALTER TABLE people ADD COLUMN deactivated_at timestamptz;
UPDATE people SET deactivated_at = updated_at WHERE NOT active;

CREATE FUNCTION app.marcar_desativacao() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.active THEN
    NEW.deactivated_at := NULL;
  ELSIF OLD.active THEN
    NEW.deactivated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER people_desativacao BEFORE UPDATE OF active ON people
  FOR EACH ROW EXECUTE FUNCTION app.marcar_desativacao();

-- Arquivos do SharePoint a apagar de vez (só o dono do banco e o worker; a tela não vê).
CREATE TABLE arquivos_para_apagar (
  id          bigserial PRIMARY KEY,
  sp_drive_id text NOT NULL,
  sp_item_id  text NOT NULL,
  origem      text NOT NULL CHECK (origem IN ('canal', 'tarefa')),
  tentativas  int NOT NULL DEFAULT 0,
  ultimo_erro text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sp_drive_id, sp_item_id)
);
ALTER TABLE arquivos_para_apagar ENABLE ROW LEVEL SECURITY;
CREATE POLICY arquivos_para_apagar_worker ON arquivos_para_apagar FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE, DELETE ON arquivos_para_apagar TO omni_worker;

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

  -- Missões encerradas há mais de 5 anos.
  v_missoes := ARRAY(
    SELECT id FROM missions WHERE NOT is_active AND coalesce(cycle_closed_at, closed_at) < now() - interval '5 years'
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
