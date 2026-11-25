-- 0016 · Entrega B do filtroAPP (spec 034): medição, notas, romaneios,
-- pendências no Omie e descargas, mais as confirmações de descarga pedidas
-- pela IA.
--
-- * As cinco tabelas são cópias de leitura (só o worker escreve), como `reports`.
--   Valores financeiros ficam fora do acesso da tela (GRANT por coluna): a IA usa
--   no worker; a tela mostra situação e datas.
-- * ai_unloadings: confirmação de descarga respondida no Omni e enviada ao
--   filtroAPP pelo worker, conforme FILTROAPP_ESCRITA (mesmo padrão de ai_deviations).

CREATE TABLE mission_measurements (
  mission_id            uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  situacao              text NOT NULL CHECK (situacao IN ('SEM_MEDICAO', 'PREPARADA', 'ENVIADA', 'APROVADA')),
  prepared_at           timestamptz,
  sent_at               timestamptz,
  approved_at           timestamptz,
  saldo_pendente        boolean,
  executed_amount       numeric(14, 2),
  measured_amount       numeric(14, 2),
  approved_amount       numeric(14, 2),
  currency              text,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mission_invoices (
  id                    text PRIMARY KEY,                 -- id do filtroAPP
  mission_id            uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  tipo                  text NOT NULL CHECK (tipo IN ('NFSE', 'NFE', 'ND')),
  numero                text NOT NULL,
  serie                 text,
  data_emissao          timestamptz NOT NULL,
  valor                 numeric(14, 2),
  situacao_recebimento  text NOT NULL CHECK (situacao_recebimento IN ('RECEBIDA', 'PARCIAL', 'EM_ABERTO', 'ATRASADA', 'DESCONHECIDA')),
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_invoices_mission ON mission_invoices (mission_id, data_emissao DESC);

CREATE TABLE mission_romaneios (
  id                    text PRIMARY KEY,
  mission_id            uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  tipo                  text NOT NULL CHECK (tipo IN ('SAIDA', 'RETORNO')),
  data                  timestamptz NOT NULL,
  emitido_em            timestamptz,
  quantidade_itens      integer NOT NULL,
  peso_carga            numeric(12, 3),
  unidade_peso          text,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_romaneios_mission ON mission_romaneios (mission_id, data DESC);

CREATE TABLE mission_pending (
  mission_id            uuid PRIMARY KEY REFERENCES missions(id) ON DELETE CASCADE,
  a_pagar_qtd           integer NOT NULL,
  a_pagar_valor         numeric(14, 2),                    -- NULL: título parcial sem saldo confiável
  a_pagar_vencimento    timestamptz,
  a_receber_qtd         integer NOT NULL,
  a_receber_valor       numeric(14, 2),
  a_receber_vencimento  timestamptz,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mission_unloadings (
  id                    text PRIMARY KEY,
  romaneio_id           text NOT NULL,
  mission_id            uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  tipo                  text NOT NULL CHECK (tipo IN ('PARCIAL', 'TOTAL')),
  confirmada_em         timestamptz NOT NULL,
  confirmada_por_email  citext NOT NULL,
  cte                   jsonb,
  filtroapp_updated_at  timestamptz NOT NULL,
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mission_unloadings_romaneio ON mission_unloadings (romaneio_id);

-- Leitura na tela (sem valores) para quem tem perfil; o worker escreve.
GRANT SELECT (mission_id, situacao, prepared_at, sent_at, approved_at, saldo_pendente, filtroapp_updated_at, synced_at)
  ON mission_measurements TO omni_app;
GRANT SELECT (id, mission_id, tipo, numero, serie, data_emissao, situacao_recebimento, filtroapp_updated_at, synced_at)
  ON mission_invoices TO omni_app;
GRANT SELECT ON mission_romaneios, mission_unloadings TO omni_app;
GRANT SELECT (mission_id, a_pagar_qtd, a_pagar_vencimento, a_receber_qtd, a_receber_vencimento, filtroapp_updated_at, synced_at)
  ON mission_pending TO omni_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON mission_measurements, mission_invoices, mission_romaneios, mission_pending, mission_unloadings
  TO omni_worker;

ALTER TABLE mission_measurements ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_invoices     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_romaneios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_pending      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mission_unloadings   ENABLE ROW LEVEL SECURITY;

CREATE POLICY measurements_select ON mission_measurements FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY invoices_select     ON mission_invoices     FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY romaneios_select    ON mission_romaneios    FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY pending_select      ON mission_pending      FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY unloadings_select   ON mission_unloadings   FOR SELECT TO omni_app USING (app.has_any_profile());
CREATE POLICY measurements_worker ON mission_measurements FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY invoices_worker     ON mission_invoices     FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY romaneios_worker    ON mission_romaneios    FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY pending_worker      ON mission_pending      FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY unloadings_worker   ON mission_unloadings   FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- confirmação de descarga pedida pela IA

CREATE TABLE ai_unloadings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id       uuid NOT NULL UNIQUE REFERENCES ai_questions(id),
  mission_id        uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  idempotency_key   uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  request           jsonb NOT NULL,                     -- corpo do POST /logistica/descargas (o e-mail entra no envio)
  status            text NOT NULL DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'enviado', 'simulado', 'ensaio', 'falhou')),
  filtroapp_id      text,
  error             text,
  attempts          integer NOT NULL DEFAULT 0,
  created_by        uuid NOT NULL REFERENCES people(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz
);
CREATE INDEX ai_unloadings_pending ON ai_unloadings (status) WHERE status IN ('pendente', 'falhou');

GRANT SELECT, INSERT ON ai_unloadings TO omni_app;
GRANT SELECT, UPDATE ON ai_unloadings TO omni_worker;
ALTER TABLE ai_unloadings ENABLE ROW LEVEL SECURITY;
CREATE POLICY unloadings_req_select ON ai_unloadings FOR SELECT TO omni_app
  USING (app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY unloadings_req_insert ON ai_unloadings FOR INSERT TO omni_app
  WITH CHECK (created_by = app.current_person_id() AND status = 'pendente'
              AND app.canal_desde(mission_id, 'interno') IS NOT NULL);
CREATE POLICY unloadings_req_worker ON ai_unloadings FOR ALL TO omni_worker USING (true) WITH CHECK (true);
