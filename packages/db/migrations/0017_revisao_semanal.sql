-- 0017 · Revisão semanal (Fase 9, primeira versão).
--
-- * mission_quality_records: registros da Qualidade do filtroAPP por missão
--   (desvios, reclamações, lições). Só o necessário para acompanhar: sem a
--   descrição e sem o nome do responsável pela ação. Vê quem gerencia
--   (gerente, diretoria) e quem vê o Interno da missão.
-- * mission_progress_history: avanço (%) e etapa por dia, para a revisão
--   mostrar quanto a missão andou na semana. O worker grava.
-- * app.financeiro_missoes: valores em reais (medição, notas, pendências) só
--   para gerente e diretoria — a tela não lê essas colunas diretamente (0016).

CREATE TABLE mission_quality_records (
  id                    text PRIMARY KEY,
  mission_id            uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  number                text NOT NULL,
  type                  text NOT NULL,                   -- DESVIO, RECLAMACAO_CLIENTE, LICAO_APRENDIDA, INCIDENTE…
  status                text NOT NULL,                   -- ABERTO, EM_ACAO, EM_OBSERVACAO, FECHADO, DIVULGADO
  impact                text,
  event_date            date,
  nature                text,
  action_deadline       date,
  recurrent             boolean,
  deleted_at            timestamptz,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_quality_mission ON mission_quality_records (mission_id, status);

CREATE TABLE mission_progress_history (
  mission_id        uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  dia               date NOT NULL,
  progress_percent  numeric(6, 2),
  stage             text,
  PRIMARY KEY (mission_id, dia)
);

CREATE FUNCTION app.ve_gestao() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT app.has_profile('gerente') OR app.has_profile('diretoria') $$;

GRANT SELECT ON mission_quality_records, mission_progress_history TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mission_quality_records, mission_progress_history TO omni_worker;
ALTER TABLE mission_quality_records  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_progress_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY quality_select ON mission_quality_records FOR SELECT TO omni_app
  USING (app.ve_gestao() OR app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY progress_select ON mission_progress_history FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY quality_worker  ON mission_quality_records  FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY progress_worker ON mission_progress_history FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- Valores em reais por missão: só gerente e diretoria (para os demais, nenhuma linha).
CREATE FUNCTION app.financeiro_missoes()
  RETURNS TABLE (
    mission_id uuid,
    medicao_executada numeric, medicao_medida numeric, medicao_aprovada numeric,
    notas_emitidas numeric, notas_em_aberto numeric,
    a_pagar numeric, a_receber numeric
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id,
           mm.executed_amount, mm.measured_amount, mm.approved_amount,
           (SELECT sum(i.valor) FROM mission_invoices i WHERE i.mission_id = m.id),
           (SELECT sum(i.valor) FROM mission_invoices i WHERE i.mission_id = m.id AND i.situacao_recebimento IN ('EM_ABERTO', 'ATRASADA', 'PARCIAL')),
           p.a_pagar_valor, p.a_receber_valor
      FROM missions m
      LEFT JOIN mission_measurements mm ON mm.mission_id = m.id
      LEFT JOIN mission_pending p ON p.mission_id = m.id
     WHERE app.ve_gestao() AND m.is_active
  $$;

GRANT EXECUTE ON FUNCTION app.ve_gestao(), app.financeiro_missoes() TO omni_app;

-- Contagens por missão para a revisão (só números, nunca o conteúdo), só para
-- gerente e diretoria: um gerente que não está no Interno da missão não vê as
-- perguntas nem as tarefas, mas precisa saber quantas estão paradas.
CREATE FUNCTION app.contagens_revisao(p_hoje date)
  RETURNS TABLE (mission_id uuid, perguntas_sem_resposta integer, tarefas_atrasadas integer, tarefas_abertas integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.id,
           (SELECT count(*)::int FROM ai_questions q JOIN mission_messages mm ON mm.id = q.message_id
             WHERE q.mission_id = m.id AND q.status = 'enviada' AND mm.created_at < now() - interval '2 days'),
           (SELECT count(*)::int FROM tasks t JOIN task_projects tp ON tp.id = t.project_id
             WHERE tp.mission_id = m.id AND NOT t.completed AND t.due_date < p_hoje),
           (SELECT count(*)::int FROM tasks t JOIN task_projects tp ON tp.id = t.project_id
             WHERE tp.mission_id = m.id AND NOT t.completed)
      FROM missions m
     WHERE app.ve_gestao() AND m.is_active
  $$;
GRANT EXECUTE ON FUNCTION app.contagens_revisao(date) TO omni_app;
