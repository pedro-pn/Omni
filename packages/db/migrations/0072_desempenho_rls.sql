-- Desempenho das regras de acesso (Fase 11, teste de carga de 24/11/2026).
--
-- As políticas chamavam funções por LINHA (app.ve_missao, app.ve_conversa_whatsapp,
-- app.canal_desde): com o volume de uma empresa inteira, a lista de conversas levava
-- 0,4 s, a de missões 0,3 s e as mensagens novas dos canais 2 s por pessoa — e várias
-- pessoas ao mesmo tempo passavam de 10 s. Aqui as mesmas regras viram CONJUNTOS,
-- calculados uma vez por consulta (subconsulta com hash), e as políticas passam a usá-los.
-- As funções por linha continuam (usadas em outros lugares) e um teste confere que as
-- duas formas dão o mesmo resultado.

-- Missões de que a pessoa vê o Interno: a mesma regra de app.ve_interno (0014) para a pessoa atual.
CREATE FUNCTION app.internos_que_vejo() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp ROWS 100
  AS $$
    WITH eu AS (SELECT id, email FROM people WHERE id = app.current_person_id() AND active)
    SELECT m.id FROM missions m, eu
     WHERE EXISTS (SELECT 1 FROM person_profiles WHERE person_id = eu.id AND profile = 'diretoria')
    UNION SELECT mm.mission_id FROM mission_members mm JOIN eu ON eu.id = mm.person_id
           WHERE mm.channel = 'interno' AND mm.removed_at IS NULL
    UNION SELECT r.mission_id FROM mission_responsibles r JOIN people p ON p.email = r.email JOIN eu ON eu.id = p.id
           WHERE r.role IN ('LEADER', 'PLANNER')
    UNION SELECT a.mission_id FROM mission_function_access a JOIN function_assignments f ON f.function_code = a.function_code JOIN eu ON eu.id = f.person_id
           WHERE f.starts_on <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
             AND (f.ends_on IS NULL OR f.ends_on >= (now() AT TIME ZONE 'America/Sao_Paulo')::date)
  $$;

-- Missões que a pessoa vê: a mesma regra de app.ve_missao (0045).
CREATE FUNCTION app.missoes_que_vejo() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp ROWS 200
  AS $$
    WITH eu AS (SELECT id, email FROM people WHERE id = app.current_person_id() AND active)
    SELECT m.id FROM missions m, eu
     WHERE app.has_profile('diretoria') OR app.has_profile('admin') OR app.has_profile('gerente')
    UNION SELECT x FROM app.internos_que_vejo() x
    UNION SELECT mm.mission_id FROM mission_members mm JOIN eu ON eu.id = mm.person_id WHERE mm.removed_at IS NULL
    UNION SELECT r.mission_id FROM mission_responsibles r JOIN eu ON lower(eu.email) = lower(r.email)
    UNION SELECT a.mission_id FROM mission_allocations a JOIN people p ON p.filtroapp_collaborator_id = a.collaborator_id JOIN eu ON eu.id = p.id
           WHERE a.deleted_at IS NULL
    UNION SELECT v.mission_id FROM mission_viewers v JOIN eu ON eu.id = v.person_id
  $$;

-- Conversas do WhatsApp que a pessoa vê: a mesma regra de app.ve_conversa_whatsapp (0028/0054).
CREATE FUNCTION app.conversas_que_vejo() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp ROWS 1000
  AS $$
    SELECT c.id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE n.owner_person_id = app.current_person_id()
    UNION SELECT l.chat_id FROM whatsapp_chat_missions l WHERE l.mission_id IN (SELECT app.internos_que_vejo())
  $$;

REVOKE ALL ON FUNCTION app.missoes_que_vejo(), app.internos_que_vejo(), app.conversas_que_vejo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.missoes_que_vejo(), app.internos_que_vejo(), app.conversas_que_vejo() TO omni_app;

ALTER POLICY missions_select ON missions USING (id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY mission_responsibles_select ON mission_responsibles USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY reports_select ON reports USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY measurements_select ON mission_measurements USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY invoices_select ON mission_invoices USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY romaneios_select ON mission_romaneios USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY unloadings_select ON mission_unloadings USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY pending_select ON mission_pending USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY conditions_select ON mission_conditions USING (mission_id IN (SELECT app.missoes_que_vejo()));
ALTER POLICY progress_select ON mission_progress_history USING (mission_id IN (SELECT app.missoes_que_vejo()));

ALTER POLICY wa_chats_ver ON whatsapp_chats USING (id IN (SELECT app.conversas_que_vejo()));
ALTER POLICY wa_messages_ver ON whatsapp_messages USING (chat_id IN (SELECT app.conversas_que_vejo()));
ALTER POLICY wa_links_ver ON whatsapp_chat_missions USING (chat_id IN (SELECT app.conversas_que_vejo()));

-- Mensagens novas dos canais por missão e canal, para a pessoa atual. O acesso (app.canal_desde,
-- a mesma regra da política messages_select) é calculado uma vez por canal das missões
-- ativas, e as mensagens são contadas pelo índice (mission_id, channel, created_at).
-- Só números e a prévia da última mensagem de pessoa — o que a pessoa já pode ler.
CREATE FUNCTION app.novidades_dos_canais()
  RETURNS TABLE (mission_id uuid, channel text, de_pessoas integer, da_ia integer, ultima_de_pessoa timestamptz, previa text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH canais AS (
      SELECT m.id AS mission_id, c.channel, app.canal_desde(m.id, c.channel) AS desde
        FROM missions m CROSS JOIN (VALUES ('interno'), ('gerencial')) AS c(channel)
       WHERE m.is_active
    ), visiveis AS (
      SELECT v.mission_id, v.channel, greatest(v.desde, coalesce(r.last_read_at, '-infinity')) AS lido_ate, v.desde
        FROM canais v
        LEFT JOIN mission_reads r ON r.mission_id = v.mission_id AND r.channel = v.channel AND r.person_id = app.current_person_id()
       WHERE v.desde IS NOT NULL
    ), contagem AS (
      SELECT v.mission_id, v.channel,
             count(*) FILTER (WHERE mm.kind = 'texto' AND mm.author_person_id IS NOT NULL)::int AS de_pessoas,
             count(*) FILTER (WHERE NOT (mm.kind = 'texto' AND mm.author_person_id IS NOT NULL))::int AS da_ia
        FROM visiveis v
        JOIN mission_messages mm ON mm.mission_id = v.mission_id AND mm.channel = v.channel AND mm.created_at > v.lido_ate
       WHERE mm.author_person_id IS DISTINCT FROM app.current_person_id()
       GROUP BY v.mission_id, v.channel
    )
    SELECT c.mission_id, c.channel, c.de_pessoas, c.da_ia, u.created_at, left(u.body, 160)
      FROM contagem c
      JOIN visiveis v ON v.mission_id = c.mission_id AND v.channel = c.channel
      LEFT JOIN LATERAL (
        SELECT p.created_at, p.body FROM mission_messages p
         WHERE p.mission_id = c.mission_id AND p.channel = c.channel AND p.created_at >= v.desde
           AND p.kind = 'texto' AND p.author_person_id IS NOT NULL
         ORDER BY p.created_at DESC LIMIT 1
      ) u ON true
  $$;
REVOKE ALL ON FUNCTION app.novidades_dos_canais() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.novidades_dos_canais() TO omni_app;
