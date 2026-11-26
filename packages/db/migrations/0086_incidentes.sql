-- Registro de incidentes (E21, pilar 12.4): Administração → Incidentes, só para quem administra.
--
-- Cada incidente fica registrado com o que aconteceu, o impacto, a causa e o que muda para não
-- repetir. Um incidente só é encerrado com a causa e a correção escritas; se envolveu dado pessoal,
-- também com os titulares afetados (categorias, sem nomes) e as comunicações feitas.
-- O registro não se apaga: a Resolução CD/ANPD nº 15/2024 pede a guarda por pelo menos 5 anos.
-- Quem criou e cada alteração (campos mudados, sem o texto) vão para o audit_log.

CREATE TABLE incidentes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo           text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 3 AND 160),
  tipo             text NOT NULL CHECK (tipo IN ('indisponibilidade', 'dados', 'seguranca', 'integracao', 'erro', 'outro')),
  gravidade        text NOT NULL CHECK (gravidade IN ('baixa', 'media', 'alta')),
  inicio           timestamptz NOT NULL,
  conhecido_em     timestamptz NOT NULL,
  resolvido_em     timestamptz,
  o_que_aconteceu  text NOT NULL CHECK (length(btrim(o_que_aconteceu)) BETWEEN 3 AND 4000),
  impacto          text CHECK (length(impacto) <= 2000),
  dados_pessoais   boolean NOT NULL DEFAULT false,
  titulares        text CHECK (length(titulares) <= 1000),
  acoes            text CHECK (length(acoes) <= 4000),
  causa            text CHECK (length(causa) <= 4000),
  correcao         text CHECK (length(correcao) <= 4000),
  comunicacoes     text CHECK (length(comunicacoes) <= 2000),
  referencias      text CHECK (length(referencias) <= 1000),
  status           text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'resolvido', 'encerrado')),
  criado_por       uuid NOT NULL REFERENCES people(id) DEFAULT app.current_person_id(),
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_por   uuid REFERENCES people(id),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incidentes_datas CHECK (conhecido_em >= inicio AND (resolvido_em IS NULL OR resolvido_em >= inicio)),
  CONSTRAINT incidentes_resolvido CHECK (status = 'aberto' OR resolvido_em IS NOT NULL),
  CONSTRAINT incidentes_causa CHECK (
    status <> 'encerrado' OR (length(btrim(coalesce(causa, ''))) >= 3 AND length(btrim(coalesce(correcao, ''))) >= 3)
  ),
  CONSTRAINT incidentes_titulares CHECK (
    status <> 'encerrado' OR NOT dados_pessoais
    OR (length(btrim(coalesce(titulares, ''))) >= 3 AND length(btrim(coalesce(comunicacoes, ''))) >= 3)
  )
);
CREATE INDEX incidentes_recentes ON incidentes (inicio DESC);

ALTER TABLE incidentes ENABLE ROW LEVEL SECURITY;
CREATE POLICY incidentes_admin_select ON incidentes FOR SELECT TO omni_app USING (app.has_profile('admin'));
CREATE POLICY incidentes_admin_insert ON incidentes FOR INSERT TO omni_app
  WITH CHECK (app.has_profile('admin') AND criado_por = app.current_person_id());
CREATE POLICY incidentes_admin_update ON incidentes FOR UPDATE TO omni_app
  USING (app.has_profile('admin'))
  WITH CHECK (app.has_profile('admin') AND atualizado_por = app.current_person_id());
GRANT SELECT, INSERT ON incidentes TO omni_app;
GRANT UPDATE (titulo, tipo, gravidade, inicio, conhecido_em, resolvido_em, o_que_aconteceu, impacto, dados_pessoais,
              titulares, acoes, causa, correcao, comunicacoes, referencias, status, atualizado_por, atualizado_em)
  ON incidentes TO omni_app;
-- Sem DELETE para ninguém da aplicação: o registro é permanente.

-- Histórico: quem criou e quem mudou o quê (só os nomes dos campos e a situação, nunca o texto).
CREATE FUNCTION app.incidentes_auditoria() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  campos text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (NEW.criado_por, 'incidente.criado', 'incidente', NEW.id::text, jsonb_build_object('status', NEW.status));
    RETURN NEW;
  END IF;
  SELECT array_agg(n.key ORDER BY n.key) INTO campos
    FROM jsonb_each(to_jsonb(NEW)) n
    JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
   WHERE n.value IS DISTINCT FROM o.value AND n.key NOT IN ('atualizado_por', 'atualizado_em');
  IF campos IS NOT NULL THEN
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (NEW.atualizado_por, 'incidente.alterado', 'incidente', NEW.id::text,
            jsonb_build_object('campos', campos, 'status', NEW.status));
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.incidentes_auditoria() FROM PUBLIC;
CREATE TRIGGER incidentes_auditoria AFTER INSERT OR UPDATE ON incidentes
  FOR EACH ROW EXECUTE FUNCTION app.incidentes_auditoria();
