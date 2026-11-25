-- Domínios de e-mail do cliente da missão (das empresas do Prisma ligadas a ela),
-- para separar cliente × terceiros nos participantes. A tela não lê as tabelas do
-- Prisma; esta função devolve só os domínios, e só para quem vê o Interno.

CREATE FUNCTION app.dominios_do_cliente(p_mission uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT coalesce(array_agg(DISTINCT lower(dom)), '{}')
      FROM prisma_mission_links l
      JOIN prisma_missions pm ON pm.id = l.prisma_mission_id
      JOIN prisma_companies c ON c.id = ANY (pm.company_ids) AND c.deleted_at IS NULL
      CROSS JOIN LATERAL unnest(c.email_domains) dom
     WHERE l.mission_id = p_mission AND app.ve_interno(p_mission, app.current_person_id())
  $$;
REVOKE ALL ON FUNCTION app.dominios_do_cliente(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.dominios_do_cliente(uuid) TO omni_app;
