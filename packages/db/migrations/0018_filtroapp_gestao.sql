-- 0018 · Gestão do filtroAPP (spec 034, B6) para a revisão semanal.
--
-- Cópias de leitura (só o worker escreve), como as da Entrega B (0016):
-- * mission_weekly_progress: avanço no início e no fim de cada semana, meta da
--   semana (pontos percentuais) e a revisão semanal feita no filtroAPP.
-- * mission_costs: orçamento, custo realizado e consumo do custo — tudo
--   financeiro: a tela não lê a tabela; gerente e diretoria leem por
--   app.custos_missoes().
-- * mission_conditions: permanência prevista dos equipamentos; a diária de
--   stand-by (reais) fica fora do acesso da tela e sai por app.custos_missoes().
-- * mission_allocations: quem está alocado (só o id do colaborador no filtroAPP,
--   sem nome nem dados pessoais).
-- * mission_timesheet_weeks: horas do ponto por missão e semana, só agregadas.

CREATE TABLE mission_weekly_progress (
  mission_id             uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  week_start             date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  avanco_inicio          numeric(6, 2),
  avanco_fim             numeric(6, 2),
  meta_pontos            numeric(6, 2),
  meta_definida_por      text CHECK (meta_definida_por IN ('PROJETO', 'GRUPO')),
  revisao_concluida_em   timestamptz,
  revisao_pendencias     integer,
  revisao_itens          jsonb,
  filtroapp_updated_at   timestamptz NOT NULL,
  synced_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, week_start)
);

CREATE TABLE mission_costs (
  mission_id             uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  preco_venda            numeric(14, 2),
  custo_previsto         numeric(14, 2),
  margem_prevista        numeric(8, 2),
  dias_previstos         numeric(8, 2),                   -- pode vir fracionário (ex.: 49,7)
  custo_total            numeric(14, 2) NOT NULL,
  custo_por_categoria    jsonb NOT NULL,                  -- [{codigo, rotulo, valor}]
  custo_ate              date NOT NULL,
  avanco_fisico          numeric(6, 2),
  consumo_do_custo       integer,
  filtroapp_updated_at   timestamptz NOT NULL,
  synced_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mission_conditions (
  mission_id                 uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  permanencia_prevista_dias  numeric(8, 2),
  diaria_stand_by            numeric(14, 2),
  filtroapp_updated_at       timestamptz NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mission_allocations (
  id                     text PRIMARY KEY,
  mission_id             uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  collaborator_id        text NOT NULL,
  funcao                 text,
  mobilizacao            date,
  desmobilizacao         date,
  deleted_at             timestamptz,
  filtroapp_updated_at   timestamptz NOT NULL,
  synced_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_allocations_mission ON mission_allocations (mission_id, mobilizacao);

CREATE TABLE mission_timesheet_weeks (
  mission_id             uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  week_start             date NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  minutos_normais        numeric(12, 2) NOT NULL,
  minutos_extra_70       numeric(12, 2) NOT NULL,
  minutos_extra_100      numeric(12, 2) NOT NULL,
  minutos_noturnos       numeric(12, 2) NOT NULL,
  pessoas                integer NOT NULL,
  filtroapp_updated_at   timestamptz NOT NULL,
  synced_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, week_start)
);

-- Tela: avanço, alocações e ponto para gestão e quem vê o Interno da missão;
-- permanência prevista para quem tem perfil; custos e diária só pela função.
GRANT SELECT ON mission_weekly_progress, mission_allocations, mission_timesheet_weeks TO omni_app;
GRANT SELECT (mission_id, permanencia_prevista_dias, filtroapp_updated_at, synced_at) ON mission_conditions TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON mission_weekly_progress, mission_costs, mission_conditions, mission_allocations, mission_timesheet_weeks
  TO omni_worker;

ALTER TABLE mission_weekly_progress  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_costs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_conditions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_allocations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_timesheet_weeks  ENABLE ROW LEVEL SECURITY;

CREATE POLICY weekly_select      ON mission_weekly_progress FOR SELECT TO omni_app
  USING (app.ve_gestao() OR app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY allocations_select ON mission_allocations     FOR SELECT TO omni_app
  USING (app.ve_gestao() OR app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY timesheet_select   ON mission_timesheet_weeks FOR SELECT TO omni_app
  USING (app.ve_gestao() OR app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY conditions_select  ON mission_conditions      FOR SELECT TO omni_app USING (app.has_any_profile());
-- mission_costs: nenhuma política para omni_app (sem GRANT também).

CREATE POLICY weekly_worker      ON mission_weekly_progress FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY costs_worker       ON mission_costs           FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY conditions_worker  ON mission_conditions      FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY allocations_worker ON mission_allocations     FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY timesheet_worker   ON mission_timesheet_weeks FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- Custos × avanço e diária de stand-by: só gerente e diretoria (para os demais, nenhuma linha).
CREATE FUNCTION app.custos_missoes()
  RETURNS TABLE (
    mission_id uuid,
    preco_venda numeric, custo_previsto numeric, margem_prevista numeric, dias_previstos numeric,
    custo_total numeric, custo_por_categoria jsonb, custo_ate date,
    avanco_fisico numeric, consumo_do_custo integer,
    diaria_stand_by numeric
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id,
           c.preco_venda, c.custo_previsto, c.margem_prevista, c.dias_previstos,
           c.custo_total, c.custo_por_categoria, c.custo_ate,
           c.avanco_fisico, c.consumo_do_custo,
           cd.diaria_stand_by
      FROM missions m
      LEFT JOIN mission_costs c ON c.mission_id = m.id
      LEFT JOIN mission_conditions cd ON cd.mission_id = m.id
     WHERE app.ve_gestao() AND m.is_active AND (c.mission_id IS NOT NULL OR cd.mission_id IS NOT NULL)
  $$;
GRANT EXECUTE ON FUNCTION app.custos_missoes() TO omni_app;
