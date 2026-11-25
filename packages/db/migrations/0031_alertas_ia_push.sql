-- 0031 · Alertas pedidos à IA (@IA / /alerta, INSTRUCOES §7.6) e notificações no celular (PWA + Web Push).
--
-- Alertas
-- * ai_alerts: regra entendida pelo LLM (o que vigiar nos RDOs, falta ou presença,
--   quantos RDOs seguidos, quem marcar), criada no canal onde foi pedida e só
--   vale depois que quem pediu ATIVA. Exemplos aprendidos ("veio, mas você não
--   encontrou") entram nas próximas leituras.
-- * ai_alert_checks: cada RDO lido contra o alerta (com o trecho conferido).
-- * ai_alert_fires: disparos; publicados no canal na janela útil, com as respostas
--   "realmente não veio", "vou cobrar o líder de campo", "veio, mas você não encontrou".
-- * mission_messages.alert_id / alert_fire_id: o cartão do alerta na conversa.
--
-- Notificações
-- * push_subscriptions: aparelhos de cada pessoa (Web Push); push_preferences.
-- * notifications ganha 'ia_alerta', 'ia_pergunta' e 'teste_push'; pergunta da IA
--   publicada vira aviso para quem ela endereça (trigger).
-- * app.destinatarios_canal / app.destinatarios_whatsapp: quem acompanha (para o
--   push de mensagens; a diretoria não recebe push de todas as missões só pelo perfil).

-- ---------------------------------------------------------------- alertas
CREATE TABLE ai_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id      uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('interno', 'gerencial')),
  created_by      uuid NOT NULL REFERENCES people(id),
  request_text    text NOT NULL CHECK (length(request_text) BETWEEN 3 AND 2000),
  -- {fonte:'rdo', tipo:'ausencia'|'presenca', oQue, dias, marcar:'LEADER'|'PLANNER'|'FIELD_OPERATOR'|'eu'}
  spec            jsonb NOT NULL,
  examples        text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'ativo', 'pausado', 'cancelado')),
  after_date      date,
  prompt_version  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  fires           integer NOT NULL DEFAULT 0
);
CREATE INDEX ai_alerts_mission ON ai_alerts (mission_id, status);

CREATE TABLE ai_alert_checks (
  alert_id    uuid NOT NULL REFERENCES ai_alerts(id) ON DELETE CASCADE,
  report_id   text NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  present     boolean NOT NULL,
  quote       text,
  model       text,
  checked_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, report_id)
);

CREATE TABLE ai_alert_fires (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id     uuid NOT NULL REFERENCES ai_alerts(id) ON DELETE CASCADE,
  report_ids   text[] NOT NULL CHECK (cardinality(report_ids) BETWEEN 1 AND 20),
  status       text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'publicado')),
  message_id   uuid REFERENCES mission_messages(id) ON DELETE SET NULL,
  answer       jsonb,
  answered_by  uuid REFERENCES people(id),
  answered_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_alert_fires_pendentes ON ai_alert_fires (status) WHERE status = 'pendente';

ALTER TABLE mission_messages
  ADD COLUMN alert_id uuid REFERENCES ai_alerts(id) ON DELETE SET NULL,
  ADD COLUMN alert_fire_id uuid REFERENCES ai_alert_fires(id) ON DELETE SET NULL;

ALTER TABLE ai_alerts       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_alert_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_alert_fires  ENABLE ROW LEVEL SECURITY;

-- Quem vê o canal vê os alertas dele; ativar, pausar e cancelar: quem pediu ou a diretoria.
GRANT SELECT ON ai_alerts, ai_alert_fires TO omni_app;
GRANT UPDATE (status, activated_at, after_date) ON ai_alerts TO omni_app;
CREATE POLICY alerts_ver    ON ai_alerts FOR SELECT TO omni_app USING (app.canal_desde(mission_id, channel) IS NOT NULL);
CREATE POLICY alerts_mudar  ON ai_alerts FOR UPDATE TO omni_app
  USING ((created_by = app.current_person_id() OR app.has_profile('diretoria')) AND app.canal_desde(mission_id, channel) IS NOT NULL)
  WITH CHECK (status IN ('ativo', 'pausado', 'cancelado'));
CREATE POLICY fires_ver     ON ai_alert_fires FOR SELECT TO omni_app
  USING (EXISTS (SELECT 1 FROM ai_alerts a WHERE a.id = alert_id AND app.canal_desde(a.mission_id, a.channel) IS NOT NULL));

GRANT SELECT, UPDATE ON ai_alerts TO omni_worker;
GRANT SELECT, INSERT, UPDATE ON ai_alert_checks, ai_alert_fires TO omni_worker;
CREATE POLICY alerts_worker ON ai_alerts       FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY checks_worker ON ai_alert_checks FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY fires_worker  ON ai_alert_fires  FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- Cria o alerta (rascunho) e o cartão "entendi assim" no canal, em nome da IA.
CREATE FUNCTION app.criar_alerta(p_mission uuid, p_channel text, p_texto text, p_spec jsonb, p_resumo text, p_prompt text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_id uuid;
  BEGIN
    IF app.current_person_id() IS NULL OR app.canal_desde(p_mission, p_channel) IS NULL THEN
      RAISE EXCEPTION 'Você não participa deste canal';
    END IF;
    IF p_spec->>'fonte' IS DISTINCT FROM 'rdo' OR p_spec->>'tipo' NOT IN ('ausencia', 'presenca')
       OR (p_spec->>'dias')::int NOT BETWEEN 1 AND 10 OR p_spec->>'marcar' NOT IN ('LEADER', 'PLANNER', 'FIELD_OPERATOR', 'eu')
       OR length(coalesce(p_spec->>'oQue', '')) NOT BETWEEN 3 AND 300 THEN
      RAISE EXCEPTION 'Regra de alerta inválida';
    END IF;
    INSERT INTO ai_alerts (mission_id, channel, created_by, request_text, spec, prompt_version)
         VALUES (p_mission, p_channel, app.current_person_id(), left(p_texto, 2000), p_spec, p_prompt)
      RETURNING id INTO v_id;
    INSERT INTO mission_messages (mission_id, channel, author_person_id, kind, body, alert_id)
         VALUES (p_mission, p_channel, NULL, 'ia', left(p_resumo, 8000), v_id);
    RETURN v_id;
  END $$;

-- Resposta a um disparo (quem vê o canal). "veio" ensina um exemplo ao alerta.
CREATE FUNCTION app.responder_alerta(p_fire uuid, p_opcao text, p_exemplo text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_alert ai_alerts%ROWTYPE;
  BEGIN
    SELECT a.* INTO v_alert FROM ai_alert_fires f JOIN ai_alerts a ON a.id = f.alert_id
     WHERE f.id = p_fire AND f.status = 'publicado' AND f.answered_at IS NULL;
    IF v_alert.id IS NULL THEN RAISE EXCEPTION 'Este alerta já foi respondido'; END IF;
    IF app.current_person_id() IS NULL OR app.canal_desde(v_alert.mission_id, v_alert.channel) IS NULL THEN
      RAISE EXCEPTION 'Você não participa deste canal';
    END IF;
    IF p_opcao NOT IN ('nao_veio', 'cobrar', 'veio') THEN RAISE EXCEPTION 'Opção inválida'; END IF;
    IF p_opcao = 'veio' AND length(btrim(coalesce(p_exemplo, ''))) < 3 THEN RAISE EXCEPTION 'Conte como estava escrito no RDO'; END IF;
    UPDATE ai_alert_fires
       SET answer = jsonb_build_object('opcao', p_opcao, 'exemplo', nullif(btrim(coalesce(p_exemplo, '')), '')),
           answered_by = app.current_person_id(), answered_at = now()
     WHERE id = p_fire;
    IF p_opcao = 'veio' THEN
      UPDATE ai_alerts SET examples = (examples || left(btrim(p_exemplo), 300))[greatest(1, cardinality(examples) - 8):] WHERE id = v_alert.id;
    END IF;
    RETURN v_alert.mission_id;
  END $$;
GRANT EXECUTE ON FUNCTION app.criar_alerta(uuid, text, text, jsonb, text, text), app.responder_alerta(uuid, text, text) TO omni_app;

-- ---------------------------------------------------------------- notificações
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete', 'tarefa_mencao', 'ia_alerta', 'ia_pergunta', 'teste_push'));

-- Pessoas que acompanham um canal (para push de mensagens): membros, e no Interno
-- também líder de projetos, gestor de contrato e quem ocupa função endereçada.
CREATE FUNCTION app.destinatarios_canal(p_mission uuid, p_channel text) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT p.id FROM people p WHERE p.active AND (
      EXISTS (SELECT 1 FROM mission_members m WHERE m.mission_id = p_mission AND m.channel = p_channel AND m.person_id = p.id AND m.removed_at IS NULL)
      OR (p_channel = 'interno' AND EXISTS (SELECT 1 FROM mission_responsibles r WHERE r.mission_id = p_mission AND r.role IN ('LEADER', 'PLANNER') AND r.email = p.email))
      OR (p_channel = 'interno' AND EXISTS (
            SELECT 1 FROM mission_function_access a JOIN function_assignments f ON f.function_code = a.function_code
             WHERE a.mission_id = p_mission AND f.person_id = p.id
               AND f.starts_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
               AND (f.ends_on IS NULL OR f.ends_on >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)))
    )
  $$;

-- Quem acompanha um número de WhatsApp (responsável e membros escolhidos).
CREATE FUNCTION app.destinatarios_whatsapp(p_chat uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT n.owner_person_id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE c.id = p_chat AND n.owner_person_id IS NOT NULL AND n.status <> 'removido'
    UNION
    SELECT m.person_id FROM whatsapp_chats c JOIN whatsapp_number_members m ON m.number_id = c.number_id WHERE c.id = p_chat
  $$;

-- Pessoas endereçadas por uma pergunta da IA ({"papel":"LEADER"} ou {"funcao":"qualidade"}).
CREATE FUNCTION app.pessoas_do_destino(p_mission uuid, p_destino jsonb) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT p.id FROM people p JOIN mission_responsibles r ON r.email = p.email
     WHERE p.active AND r.mission_id = p_mission AND r.role = p_destino->>'papel'
    UNION
    SELECT f.person_id FROM function_assignments f JOIN people p ON p.id = f.person_id
     WHERE p.active AND f.function_code = p_destino->>'funcao'
       AND f.starts_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
       AND (f.ends_on IS NULL OR f.ends_on >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)
  $$;
GRANT EXECUTE ON FUNCTION app.destinatarios_canal(uuid, text), app.destinatarios_whatsapp(uuid), app.pessoas_do_destino(uuid, jsonb) TO omni_worker;

-- Pergunta da IA publicada → aviso (sino e push) para quem ela endereça.
CREATE FUNCTION app.avisar_pergunta_ia() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    INSERT INTO notifications (person_id, kind, title, body, mission_id, dedupe_key)
    SELECT d, 'ia_pergunta', 'Pergunta do assistente · Missão ' || m.code,
           left(coalesce(NEW.payload->'missao'->>'titulo', m.code), 200), NEW.mission_id, 'ia_pergunta:' || NEW.id || ':' || d
      FROM missions m, app.pessoas_do_destino(NEW.mission_id, NEW.addressed_to) d
     WHERE m.id = NEW.mission_id
    ON CONFLICT (dedupe_key) DO NOTHING;
    RETURN NEW;
  END $$;
CREATE TRIGGER ai_questions_avisar AFTER UPDATE OF status ON ai_questions
  FOR EACH ROW WHEN (NEW.status = 'enviada' AND OLD.status IS DISTINCT FROM 'enviada')
  EXECUTE FUNCTION app.avisar_pergunta_ia();

-- Aviso de teste (a própria pessoa, para conferir o push no aparelho).
CREATE FUNCTION app.aviso_de_teste() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    INSERT INTO notifications (person_id, kind, title, body)
    SELECT app.current_person_id(), 'teste_push', 'Teste de notificação', 'Se você está vendo isto, as notificações do Omni chegam neste aparelho.'
     WHERE app.current_person_id() IS NOT NULL
  $$;
GRANT EXECUTE ON FUNCTION app.aviso_de_teste() TO omni_app;

-- ---------------------------------------------------------------- Web Push
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh       text NOT NULL CHECK (length(p256dh) BETWEEN 40 AND 200),
  auth         text NOT NULL CHECK (length(auth) BETWEEN 10 AND 100),
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  failures     integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_person ON push_subscriptions (person_id);

CREATE TABLE push_preferences (
  person_id  uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  canais     boolean NOT NULL DEFAULT true,
  whatsapp   boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_preferences   ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscriptions, push_preferences TO omni_app;
CREATE POLICY push_subs_minhas  ON push_subscriptions FOR ALL TO omni_app USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
CREATE POLICY push_prefs_minhas ON push_preferences   FOR ALL TO omni_app USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
GRANT SELECT, UPDATE, DELETE ON push_subscriptions TO omni_worker;
GRANT SELECT ON push_preferences TO omni_worker;
CREATE POLICY push_subs_worker  ON push_subscriptions FOR ALL    TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY push_prefs_worker ON push_preferences   FOR SELECT TO omni_worker USING (true);
