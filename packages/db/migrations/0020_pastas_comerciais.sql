-- 0020 · Pastas comerciais do SharePoint, pelos vínculos do Prisma (contrato 1.66.0).
--
-- O Prisma cria e organiza as pastas; o Omni só guarda as referências
-- (driveId + folderId) que o Prisma confirma em oportunidades e missões e as
-- abre pelo Graph, no servidor, depois de conferir a permissão da pessoa aqui.
-- Nunca procura pasta pelo nome do cliente.
--
-- * prisma_companies / prisma_deals / prisma_missions: cópia mínima de
--   identidade (sem valores, contatos ou participantes), só o worker escreve.
-- * prisma_mission_links: missão do Prisma ↔ missão do Omni, com o método que
--   comprovou o vínculo ('numero': número único da missão = código no
--   filtroAPP, sem CNPJ em conflito; 'filtroapp': mapeamento oficial do
--   filtroAPP, quando ele for exposto).
-- * sharepoint_folder_refs: lista atual de `sharepointFolders` de cada
--   oportunidade e missão; o id é estável (a tela usa como referência).
-- * A tela não lê essas tabelas: tudo passa pelas funções app.* abaixo, que
--   aplicam a regra de acesso (INSTRUCOES §8):
--     pasta de oportunidade (propostas, valores) → comercial (diretoria,
--       gerente, vendas, marketing, supervisor);
--     pasta da missão → comercial, gestão e quem vê o Interno da missão.

CREATE TABLE prisma_companies (
  id                 text PRIMARY KEY,
  name               text,
  tax_id             text,
  deleted_at         timestamptz,
  prisma_updated_at  timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prisma_companies_tax ON prisma_companies (tax_id);

CREATE TABLE prisma_deals (
  id                 text PRIMARY KEY,
  code               text,
  proposal_code      text,
  title              text,
  status             text,
  company_id         text,
  prisma_mission_id  text,
  deleted_at         timestamptz,
  prisma_updated_at  timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prisma_deals_company ON prisma_deals (company_id);

CREATE TABLE prisma_missions (
  id                 text PRIMARY KEY,
  number             text,
  title              text,
  status             text,
  company_ids        text[] NOT NULL DEFAULT '{}',
  deal_ids           text[] NOT NULL DEFAULT '{}',
  deleted_at         timestamptz,
  prisma_updated_at  timestamptz,
  synced_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prisma_missions_number ON prisma_missions (number);

CREATE TABLE prisma_mission_links (
  prisma_mission_id  text PRIMARY KEY REFERENCES prisma_missions(id) ON DELETE CASCADE,
  mission_id         uuid NOT NULL UNIQUE REFERENCES missions(id) ON DELETE CASCADE,
  method             text NOT NULL CHECK (method IN ('numero', 'filtroapp')),
  linked_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sharepoint_folder_refs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  text NOT NULL CHECK (owner_type IN ('deal', 'mission')),
  owner_id    text NOT NULL,
  drive_id    text,
  folder_id   text NOT NULL,
  web_url     text,
  source      text NOT NULL CHECK (source IN ('opportunity', 'mission')),
  status      text NOT NULL CHECK (status IN ('ready', 'configuration_required')),
  synced_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id, folder_id),
  -- Sem biblioteca configurada no Prisma não há o que abrir no Graph.
  CHECK (status = 'configuration_required' OR drive_id IS NOT NULL)
);
CREATE INDEX sharepoint_folder_refs_folder ON sharepoint_folder_refs (folder_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON prisma_companies, prisma_deals, prisma_missions, prisma_mission_links, sharepoint_folder_refs TO omni_worker;
GRANT SELECT ON missions TO omni_worker;

ALTER TABLE prisma_companies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE prisma_deals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE prisma_missions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE prisma_mission_links   ENABLE ROW LEVEL SECURITY;
ALTER TABLE sharepoint_folder_refs ENABLE ROW LEVEL SECURITY;
-- Só o worker; a tela usa as funções (sem GRANT nem política para omni_app).
CREATE POLICY companies_worker ON prisma_companies       FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY deals_worker     ON prisma_deals           FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY pmissions_worker ON prisma_missions        FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY plinks_worker    ON prisma_mission_links   FOR ALL TO omni_worker USING (true) WITH CHECK (true);
CREATE POLICY folders_worker   ON sharepoint_folder_refs FOR ALL TO omni_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- permissão

-- Quem vê oportunidades, propostas e valores (INSTRUCOES §8), mais gerentes (já veem preço de venda e custos).
CREATE FUNCTION app.ve_comercial() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT app.has_profile('diretoria') OR app.has_profile('gerente') OR app.has_profile('vendas')
        OR app.has_profile('marketing') OR app.has_profile('supervisor')
  $$;

-- A pessoa atual pode abrir esta referência?
CREATE FUNCTION app.pode_ver_pasta(p_ref uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM sharepoint_folder_refs r
       WHERE r.id = p_ref
         AND CASE
               WHEN r.owner_type = 'deal' THEN
                 app.ve_comercial() AND EXISTS (SELECT 1 FROM prisma_deals d WHERE d.id = r.owner_id AND d.deleted_at IS NULL)
               ELSE
                 EXISTS (SELECT 1 FROM prisma_missions pm WHERE pm.id = r.owner_id AND pm.deleted_at IS NULL)
                 AND (
                   app.ve_comercial()
                   OR (r.source = 'mission' AND (
                         app.ve_gestao()
                         OR EXISTS (SELECT 1 FROM prisma_mission_links l
                                     WHERE l.prisma_mission_id = r.owner_id
                                       AND app.ve_interno(l.mission_id, app.current_person_id()))))
                 )
             END
    )
  $$;

-- Rótulo de uma referência: pasta da missão, ou a oportunidade dona da pasta.
CREATE FUNCTION app.rotulo_pasta(p_ref uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT CASE
             WHEN r.source = 'mission' THEN
               'Missão ' || coalesce((SELECT pm.number FROM prisma_missions pm WHERE pm.id = r.owner_id), '')
             ELSE
               coalesce((SELECT 'Oportunidade ' || concat_ws(' · ', nullif(d.code, ''), nullif(d.title, ''))
                           FROM prisma_deals d
                          WHERE d.id = CASE WHEN r.owner_type = 'deal' THEN r.owner_id
                                            ELSE (SELECT x.owner_id FROM sharepoint_folder_refs x
                                                   WHERE x.owner_type = 'deal' AND x.folder_id = r.folder_id LIMIT 1) END),
                        'Oportunidade')
           END
      FROM sharepoint_folder_refs r WHERE r.id = p_ref
  $$;

-- Pastas que o Prisma liga à missão (a principal e as das oportunidades), só as que a pessoa pode ver.
CREATE FUNCTION app.pastas_da_missao(p_mission uuid)
  RETURNS TABLE (id uuid, origem text, rotulo text, web_url text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.id, r.source, app.rotulo_pasta(r.id), r.web_url, r.status
      FROM prisma_mission_links l
      JOIN sharepoint_folder_refs r ON r.owner_type = 'mission' AND r.owner_id = l.prisma_mission_id
     WHERE l.mission_id = p_mission AND app.pode_ver_pasta(r.id)
     ORDER BY (r.source = 'mission') DESC, 3
  $$;

-- Pastas do cliente da missão: as das outras oportunidades e missões das mesmas
-- empresas no Prisma (por companyId/companyIds), sem repetir as da missão.
CREATE FUNCTION app.pastas_do_cliente(p_mission uuid)
  RETURNS TABLE (id uuid, origem text, rotulo text, web_url text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH empresas AS (
      SELECT unnest(pm.company_ids) AS company_id
        FROM prisma_mission_links l JOIN prisma_missions pm ON pm.id = l.prisma_mission_id
       WHERE l.mission_id = p_mission
    ), propria AS (
      SELECT r.folder_id FROM prisma_mission_links l
        JOIN sharepoint_folder_refs r ON r.owner_type = 'mission' AND r.owner_id = l.prisma_mission_id
       WHERE l.mission_id = p_mission
    ), candidatas AS (
      SELECT r.* FROM sharepoint_folder_refs r JOIN prisma_deals d ON r.owner_type = 'deal' AND d.id = r.owner_id
       WHERE d.company_id IN (SELECT company_id FROM empresas)
      UNION ALL
      SELECT r.* FROM sharepoint_folder_refs r JOIN prisma_missions pm ON r.owner_type = 'mission' AND pm.id = r.owner_id AND r.source = 'mission'
       WHERE pm.company_ids && (SELECT coalesce(array_agg(company_id), '{}') FROM empresas)
         AND NOT EXISTS (SELECT 1 FROM prisma_mission_links l WHERE l.prisma_mission_id = pm.id AND l.mission_id = p_mission)
    )
    SELECT DISTINCT ON (c.folder_id) c.id, c.source, app.rotulo_pasta(c.id), c.web_url, c.status
      FROM candidatas c
     WHERE c.folder_id NOT IN (SELECT folder_id FROM propria) AND app.pode_ver_pasta(c.id)
     ORDER BY c.folder_id, c.source DESC
  $$;

-- Para o servidor abrir no Graph: só devolve a pasta se a pessoa pode vê-la.
CREATE FUNCTION app.pasta_para_leitura(p_ref uuid)
  RETURNS TABLE (drive_id text, folder_id text, status text, web_url text, rotulo text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT r.drive_id, r.folder_id, r.status, r.web_url, app.rotulo_pasta(r.id)
      FROM sharepoint_folder_refs r WHERE r.id = p_ref AND app.pode_ver_pasta(r.id)
  $$;

GRANT EXECUTE ON FUNCTION app.ve_comercial(), app.pode_ver_pasta(uuid), app.rotulo_pasta(uuid),
  app.pastas_da_missao(uuid), app.pastas_do_cliente(uuid), app.pasta_para_leitura(uuid) TO omni_app;
