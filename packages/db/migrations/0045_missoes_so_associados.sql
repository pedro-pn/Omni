-- Quem vê cada missão (decisão de 10/11/2026; substitui a regra provisória
-- "qualquer pessoa com perfil vê todas as missões", PLANEJAMENTO §13 item 13):
--
-- * Diretoria, Administração e Gerentes: todas as missões.
-- * Os demais (inclusive Operação): só as missões a que estão associados —
--   responsáveis no filtroAPP (pelo e-mail), equipe alocada no filtroAPP (pelo
--   colaborador ligado à conta), membros do Interno ou do Gerencial, quem ocupa
--   uma função chamada pela IA, e quem a Diretoria ou a Administração liberar.
--
-- Vale para a missão e o que vem com ela do filtroAPP (responsáveis, RDOs e
-- relatórios, medição, notas, romaneios, descargas, pendências, condições,
-- avanço) e para as pastas da missão. Os canais, os e-mails e a Gestão seguem
-- as regras próprias (mais restritas).

-- Colaborador do filtroAPP ligado à conta do Omni (o worker liga pelo e-mail dos responsáveis).
ALTER TABLE people ADD COLUMN filtroapp_collaborator_id text UNIQUE;

-- Liberados à mão para visualizar a missão.
CREATE TABLE mission_viewers (
  mission_id  uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  added_by    uuid NOT NULL REFERENCES people(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mission_id, person_id)
);

CREATE FUNCTION app.ve_missao(p_mission uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM people WHERE id = app.current_person_id() AND active) AND (
         app.has_profile('diretoria') OR app.has_profile('admin') OR app.has_profile('gerente')
      OR app.ve_interno(p_mission, app.current_person_id())
      OR EXISTS (SELECT 1 FROM mission_members m
                  WHERE m.mission_id = p_mission AND m.person_id = app.current_person_id() AND m.removed_at IS NULL)
      OR EXISTS (SELECT 1 FROM mission_responsibles r JOIN people p ON lower(p.email) = lower(r.email)
                  WHERE r.mission_id = p_mission AND p.id = app.current_person_id())
      OR EXISTS (SELECT 1 FROM mission_allocations a JOIN people p ON p.filtroapp_collaborator_id = a.collaborator_id
                  WHERE a.mission_id = p_mission AND a.deleted_at IS NULL AND p.id = app.current_person_id())
      OR EXISTS (SELECT 1 FROM mission_viewers v WHERE v.mission_id = p_mission AND v.person_id = app.current_person_id())
    )
  $$;
REVOKE ALL ON FUNCTION app.ve_missao(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ve_missao(uuid) TO omni_app;

GRANT SELECT, INSERT, DELETE ON mission_viewers TO omni_app;
ALTER TABLE mission_viewers ENABLE ROW LEVEL SECURITY;
-- Diretoria e Administração liberam e tiram; a própria pessoa vê que foi liberada.
CREATE POLICY viewers_select ON mission_viewers FOR SELECT TO omni_app
  USING (app.has_profile('diretoria') OR app.has_profile('admin') OR person_id = app.current_person_id());
CREATE POLICY viewers_insert ON mission_viewers FOR INSERT TO omni_app
  WITH CHECK ((app.has_profile('diretoria') OR app.has_profile('admin')) AND added_by = app.current_person_id());
CREATE POLICY viewers_delete ON mission_viewers FOR DELETE TO omni_app
  USING (app.has_profile('diretoria') OR app.has_profile('admin'));

-- A missão e o que vem dela do filtroAPP: de "qualquer perfil" para "quem vê a missão".
ALTER POLICY missions_select ON missions USING (app.ve_missao(id));
ALTER POLICY mission_responsibles_select ON mission_responsibles USING (app.ve_missao(mission_id));
ALTER POLICY reports_select ON reports USING (app.ve_missao(mission_id));
ALTER POLICY measurements_select ON mission_measurements USING (app.ve_missao(mission_id));
ALTER POLICY invoices_select ON mission_invoices USING (app.ve_missao(mission_id));
ALTER POLICY romaneios_select ON mission_romaneios USING (app.ve_missao(mission_id));
ALTER POLICY unloadings_select ON mission_unloadings USING (app.ve_missao(mission_id));
ALTER POLICY pending_select ON mission_pending USING (app.ve_missao(mission_id));
ALTER POLICY conditions_select ON mission_conditions USING (app.ve_missao(mission_id));
ALTER POLICY progress_select ON mission_progress_history USING (app.ve_missao(mission_id));

-- Pastas da missão: as comerciais continuam com o comercial; as da missão, com quem vê a missão.
CREATE OR REPLACE FUNCTION app.pode_ver_pasta(p_ref uuid) RETURNS boolean
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
                   OR (r.source = 'mission' AND EXISTS (SELECT 1 FROM prisma_mission_links l
                                                         WHERE l.prisma_mission_id = r.owner_id AND app.ve_missao(l.mission_id)))
                 )
             END
    )
  $$;
