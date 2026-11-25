-- Agenda das tarefas por link privado (.ics) — porta de `apple_calendar_feeds`
-- do Foco. O link é `<id>.<HMAC(chave, id:assunto:criado)>`; o banco guarda o
-- que foi assinado (`signed_subject`, `signed_created`) para os links do Foco
-- migrados continuarem válidos com a mesma chave (APPLE_CALENDAR_SIGNING_KEY).
-- Um link por pessoa; trocar = apagar e criar outro (o antigo para de abrir).

CREATE TABLE calendar_feeds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         uuid NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  signed_subject    text NOT NULL,
  signed_created    text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_accessed_at  timestamptz
);

GRANT SELECT, INSERT, DELETE ON calendar_feeds TO omni_app;
ALTER TABLE calendar_feeds ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendar_feeds_proprio ON calendar_feeds FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id() AND signed_subject = person_id::text);

-- O link é aberto sem sessão (pelo app de agenda): só o necessário para conferir a assinatura.
CREATE FUNCTION app.agenda_por_link(p_id uuid)
  RETURNS TABLE (person_id uuid, signed_subject text, signed_created text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT f.person_id, f.signed_subject, f.signed_created
      FROM calendar_feeds f JOIN people p ON p.id = f.person_id
     WHERE f.id = p_id AND p.active
  $$;
CREATE FUNCTION app.agenda_acessada(p_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ UPDATE calendar_feeds SET last_accessed_at = now() WHERE id = p_id $$;
REVOKE ALL ON FUNCTION app.agenda_por_link(uuid), app.agenda_acessada(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.agenda_por_link(uuid), app.agenda_acessada(uuid) TO omni_app;
