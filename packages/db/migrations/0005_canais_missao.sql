-- 0005 · Canais Interno e Gerencial das missões (INSTRUCOES §6.8 e §8).
--
-- Quem vê cada canal (app.canal_desde):
--   * diretoria: todos os canais de todas as missões, todo o histórico;
--   * Interno: líder de projetos e gestor de contrato da missão (responsáveis do
--     filtroAPP, ligados pelo e-mail) são membros implícitos, todo o histórico;
--   * membros explícitos: a partir de `history_since` (NULL = todo o histórico).
-- Quem gerencia membros (app.pode_gerenciar_canal):
--   * Gerencial: só diretoria; Interno: diretoria e o líder de projetos da missão.
-- Mensagens internas e gerenciais nunca saem do Omni (não há integração com WhatsApp aqui).

CREATE FUNCTION app.meu_email() RETURNS citext
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT email FROM people WHERE id = app.current_person_id() AND active $$;
GRANT EXECUTE ON FUNCTION app.meu_email() TO omni_app;

CREATE FUNCTION app.sou_responsavel(p_mission uuid, p_roles text[]) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM mission_responsibles r
      WHERE r.mission_id = p_mission AND r.role = ANY (p_roles) AND r.email IS NOT NULL AND r.email = app.meu_email()
    )
  $$;
GRANT EXECUTE ON FUNCTION app.sou_responsavel(uuid, text[]) TO omni_app;

CREATE TABLE mission_members (
  mission_id     uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  channel        text NOT NULL CHECK (channel IN ('interno', 'gerencial')),
  person_id      uuid NOT NULL REFERENCES people(id),
  history_since  timestamptz,                 -- NULL = vê todo o histórico
  added_by       uuid NOT NULL REFERENCES people(id),
  added_at       timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  removed_by     uuid REFERENCES people(id),
  PRIMARY KEY (mission_id, channel, person_id)
);
CREATE INDEX mission_members_person ON mission_members (person_id) WHERE removed_at IS NULL;

-- Desde quando a pessoa da transação vê o canal; NULL = não vê.
CREATE FUNCTION app.canal_desde(p_mission uuid, p_channel text) RETURNS timestamptz
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  v_since timestamptz;
BEGIN
  IF app.current_person_id() IS NULL THEN RETURN NULL; END IF;
  IF app.has_profile('diretoria') THEN RETURN '-infinity'; END IF;
  SELECT coalesce(m.history_since, '-infinity') INTO v_since
    FROM mission_members m JOIN people p ON p.id = m.person_id
   WHERE m.mission_id = p_mission AND m.channel = p_channel
     AND m.person_id = app.current_person_id() AND m.removed_at IS NULL AND p.active;
  IF v_since IS NOT NULL THEN RETURN v_since; END IF;
  IF p_channel = 'interno' AND app.sou_responsavel(p_mission, ARRAY['LEADER', 'PLANNER']) THEN
    RETURN '-infinity';
  END IF;
  RETURN NULL;
END $$;
GRANT EXECUTE ON FUNCTION app.canal_desde(uuid, text) TO omni_app;

CREATE FUNCTION app.pode_gerenciar_canal(p_mission uuid, p_channel text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.has_profile('diretoria')
        OR (p_channel = 'interno' AND app.sou_responsavel(p_mission, ARRAY['LEADER']))
  $$;
GRANT EXECUTE ON FUNCTION app.pode_gerenciar_canal(uuid, text) TO omni_app;

CREATE TABLE mission_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id        uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  channel           text NOT NULL CHECK (channel IN ('interno', 'gerencial')),
  author_person_id  uuid REFERENCES people(id),          -- NULL = sistema/IA
  kind              text NOT NULL DEFAULT 'texto' CHECK (kind IN ('texto', 'sistema')),
  body              text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_messages_timeline ON mission_messages (mission_id, channel, created_at);

CREATE TABLE mission_reads (
  mission_id    uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('interno', 'gerencial')),
  person_id     uuid NOT NULL REFERENCES people(id),
  last_read_at  timestamptz NOT NULL,
  PRIMARY KEY (mission_id, channel, person_id)
);

-- Aviso de mensagem nova para o tempo real (SSE). Só identificadores: o conteúdo
-- é sempre relido pelo RLS de quem recebe.
CREATE FUNCTION app.avisar_mensagem() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM pg_notify('omni_mensagens', json_build_object('missionId', NEW.mission_id, 'channel', NEW.channel, 'id', NEW.id)::text);
  RETURN NEW;
END $$;
CREATE TRIGGER mission_messages_avisar AFTER INSERT ON mission_messages
  FOR EACH ROW EXECUTE FUNCTION app.avisar_mensagem();

-- ---------------------------------------------------------------- privilégios e RLS

GRANT SELECT, INSERT, UPDATE ON mission_members TO omni_app;
GRANT SELECT, INSERT ON mission_messages TO omni_app;
GRANT SELECT, INSERT, UPDATE ON mission_reads TO omni_app;
GRANT SELECT ON mission_members, mission_messages TO omni_worker;
GRANT INSERT ON mission_messages TO omni_worker;   -- mensagens da IA (author NULL)

ALTER TABLE mission_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_reads    ENABLE ROW LEVEL SECURITY;

-- Membros: quem vê o canal vê a lista; quem gerencia adiciona e remove.
CREATE POLICY members_select ON mission_members FOR SELECT TO omni_app
  USING (app.canal_desde(mission_id, channel) IS NOT NULL OR person_id = app.current_person_id());
CREATE POLICY members_insert ON mission_members FOR INSERT TO omni_app
  WITH CHECK (app.pode_gerenciar_canal(mission_id, channel) AND added_by = app.current_person_id());
CREATE POLICY members_update ON mission_members FOR UPDATE TO omni_app
  USING (app.pode_gerenciar_canal(mission_id, channel))
  WITH CHECK (app.pode_gerenciar_canal(mission_id, channel));

-- Mensagens: lê a partir do corte de histórico; escreve quem vê o canal.
-- Mensagem de sistema (entrou/saiu) só por quem gerencia o canal.
CREATE POLICY messages_select ON mission_messages FOR SELECT TO omni_app
  USING (created_at >= app.canal_desde(mission_id, channel));
CREATE POLICY messages_insert ON mission_messages FOR INSERT TO omni_app
  WITH CHECK (
    author_person_id = app.current_person_id()
    AND app.canal_desde(mission_id, channel) IS NOT NULL
    AND (kind = 'texto' OR app.pode_gerenciar_canal(mission_id, channel))
  );
CREATE POLICY messages_worker_select ON mission_messages FOR SELECT TO omni_worker USING (true);
CREATE POLICY messages_worker_insert ON mission_messages FOR INSERT TO omni_worker
  WITH CHECK (author_person_id IS NULL);
CREATE POLICY members_worker_select ON mission_members FOR SELECT TO omni_worker USING (true);

CREATE POLICY reads_own ON mission_reads FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id());
