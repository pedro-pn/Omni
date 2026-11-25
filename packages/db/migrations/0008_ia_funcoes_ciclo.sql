-- 0008 · IA do ciclo completo (desmobilização → medição → faturamento → pagamentos).
--
-- * mission_function_access: quando a IA endereça ou marca uma FUNÇÃO numa missão
--   (Medição, Faturamento, Qualidade, Gerente comercial…), quem ocupa a função
--   naquele momento passa a ver o Interno da missão, com todo o histórico. Quem
--   ocupa é sempre consultado na hora (function_assignments): trocar a pessoa na
--   Administração troca o acesso. Só o worker registra.
-- * missions.cycle_closed_at: ciclo encerrado no Omni (Faturamento respondeu que
--   não há mais pagamentos). A IA para de acompanhar a missão.

CREATE TABLE mission_function_access (
  mission_id     uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  function_code  text NOT NULL REFERENCES functions(code),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  reason         text NOT NULL,                     -- fluxo da IA que endereçou a função
  PRIMARY KEY (mission_id, function_code)
);

GRANT SELECT, INSERT ON mission_function_access TO omni_worker;
ALTER TABLE mission_function_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY function_access_worker ON mission_function_access FOR ALL TO omni_worker USING (true) WITH CHECK (true);
-- omni_app não lê a tabela diretamente: o acesso é decidido em app.canal_desde.

CREATE FUNCTION app.ocupo_funcao_na_missao(p_mission uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1
        FROM mission_function_access a
        JOIN function_assignments f ON f.function_code = a.function_code
        JOIN people p ON p.id = f.person_id
       WHERE a.mission_id = p_mission
         AND f.person_id = app.current_person_id()
         AND p.active
         AND f.starts_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
         AND (f.ends_on IS NULL OR f.ends_on >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)
    )
  $$;
GRANT EXECUTE ON FUNCTION app.ocupo_funcao_na_missao(uuid) TO omni_app;

CREATE OR REPLACE FUNCTION app.canal_desde(p_mission uuid, p_channel text) RETURNS timestamptz
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
  IF p_channel = 'interno' AND app.ocupo_funcao_na_missao(p_mission) THEN
    RETURN '-infinity';
  END IF;
  RETURN NULL;
END $$;

ALTER TABLE missions ADD COLUMN cycle_closed_at timestamptz;
