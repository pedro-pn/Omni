-- Composição do avanço por serviço (24/11/2026): cópia de leitura do filtroAPP
-- (`/acompanhamento/projetos/servicos`), os mesmos cartões do detalhe do projeto. O Omni
-- não recalcula: guarda o que vem e substitui a cada leitura. Vê quem vê a aba Gestão
-- (gerente, diretoria e quem vê o Interno) — com a regra em conjunto (0072).

CREATE TABLE mission_service_progress (
  mission_id            uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  avanco_total          numeric(7, 2),
  servicos              jsonb NOT NULL DEFAULT '[]'::jsonb,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE mission_service_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_progress_select ON mission_service_progress FOR SELECT TO omni_app
  USING (app.ve_gestao() OR mission_id IN (SELECT app.internos_que_vejo()));
GRANT SELECT ON mission_service_progress TO omni_app;
CREATE POLICY service_progress_worker ON mission_service_progress FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON mission_service_progress TO omni_worker;
