-- 0003 · Missões: dados do cliente, regime e datas comerciais (filtroAPP, spec
-- "api-omni-projetos") e responsáveis de cada missão.

ALTER TABLE missions
  ADD COLUMN client_legal_name                      text,
  ADD COLUMN client_cnpj                            text CHECK (client_cnpj IS NULL OR client_cnpj ~ '^\d{14}$'),
  ADD COLUMN commercial_proposal_code               text,
  ADD COLUMN end_date                               date,
  ADD COLUMN includes_saturday                      boolean,
  ADD COLUMN includes_sunday                        boolean,
  ADD COLUMN workday_hours                          text,
  ADD COLUMN weekend_workday_hours                  text,
  ADD COLUMN executed_at_headquarters               boolean,
  ADD COLUMN commercial_expected_mobilization_date  date,
  ADD COLUMN commercial_expected_start_date         date,
  ADD COLUMN commercial_expected_duration_days      integer,
  ADD COLUMN actual_mobilization_date               date;

-- Responsáveis vindos do filtroAPP (/projetos/responsaveis):
--   LEADER = Líder de Projetos (o "planejador"), PLANNER = Gestor de Contrato,
--   FIELD_OPERATOR = líder/operador de campo.
-- A ligação com `people` é feita na consulta, pelo e-mail (citext), para valer
-- também para quem entrar no Omni depois da sincronização.
CREATE TABLE mission_responsibles (
  mission_id                 uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  role                       text NOT NULL CHECK (role IN ('LEADER', 'PLANNER', 'FIELD_OPERATOR')),
  filtroapp_user_id          text,
  filtroapp_collaborator_id  text,
  name                       text NOT NULL,
  email                      citext,
  filtroapp_updated_at       timestamptz NOT NULL,
  synced_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, role)
);
CREATE INDEX mission_responsibles_email ON mission_responsibles (email);

GRANT SELECT ON mission_responsibles TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mission_responsibles TO omni_worker;
ALTER TABLE mission_responsibles ENABLE ROW LEVEL SECURITY;

-- Mesma regra provisória da lista de missões (PLANEJAMENTO §13, item 13).
CREATE POLICY mission_responsibles_select ON mission_responsibles FOR SELECT TO omni_app
  USING (app.has_any_profile());
CREATE POLICY mission_responsibles_worker ON mission_responsibles FOR ALL TO omni_worker
  USING (true) WITH CHECK (true);
