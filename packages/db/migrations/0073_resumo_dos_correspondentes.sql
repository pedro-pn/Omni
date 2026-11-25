-- Caixa única mais leve (teste de carga de 24/11/2026): resumo por correspondente.
--
-- A lista "Tudo" agrupava, a cada abertura, todos os cabeçalhos dos últimos 90 dias da
-- caixa da pessoa (dezenas de milhares numa caixa movimentada). Agora um resumo por
-- (dono, endereço) é mantido por gatilho em mail_items — quem enviou (Entrada) e para
-- quem foi enviado (Enviados) — e a tela lê só os mais recentes pelo índice.
-- Mesmas regras de antes: o próprio endereço não entra; só o dono lê.
--
-- O gatilho é por COMANDO (tabelas de transição): uma importação grande recalcula cada
-- (dono, endereço) uma vez só. Cada recálculo parte do índice GIN dos endereços (CTE
-- materializada), sem a lista pendente do GIN (fastupdate), que toda busca varreria.

CREATE TABLE mail_correspondents (
  owner_person_id  uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  address          text NOT NULL CHECK (address = lower(address)),
  name             text,
  last_at          timestamptz NOT NULL,
  last_item_id     uuid NOT NULL,
  last_subject     text,
  last_preview     text,
  unread           integer NOT NULL DEFAULT 0,
  total            integer NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_person_id, address)
);
CREATE INDEX mail_correspondents_recentes ON mail_correspondents (owner_person_id, last_at DESC);
ALTER TABLE mail_correspondents ENABLE ROW LEVEL SECURITY;
CREATE POLICY mail_correspondents_dono ON mail_correspondents FOR SELECT TO omni_app USING (owner_person_id = app.current_person_id());
GRANT SELECT ON mail_correspondents TO omni_app;
CREATE POLICY mail_correspondents_worker ON mail_correspondents FOR SELECT TO omni_worker USING (true);
GRANT SELECT ON mail_correspondents TO omni_worker;

ALTER INDEX mail_items_enderecos SET (fastupdate = off);
SELECT gin_clean_pending_list('mail_items_enderecos'::regclass);

-- Refaz o resumo destes endereços para o dono.
CREATE FUNCTION app.recalcular_correspondentes(p_owner uuid, p_enderecos text[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_end text;
    v_eu text := (SELECT lower(email) FROM people WHERE id = p_owner);
  BEGIN
    FOREACH v_end IN ARRAY coalesce(p_enderecos, '{}') LOOP
      -- O próprio endereço (a caixa do dono) não é correspondente.
      CONTINUE WHEN v_end IS NULL OR v_end = '' OR v_end = v_eu;
      WITH candidatos AS MATERIALIZED (
        SELECT * FROM mail_items WHERE addresses @> ARRAY[v_end]
      ), pares AS (
        SELECT c.id, c.from_name AS nome, coalesce(c.received_at, c.sent_at, c.created_at) AS em, NOT c.is_read AS nao_lido, c.subject, c.preview
          FROM candidatos c
         WHERE c.owner_person_id = p_owner AND c.folder = 'inbox' AND c.from_address = v_end
        UNION ALL
        SELECT c.id, r->>'nome', coalesce(c.received_at, c.sent_at, c.created_at), false, c.subject, c.preview
          FROM candidatos c, jsonb_array_elements(c.to_recipients) r
         WHERE c.owner_person_id = p_owner AND c.folder = 'sentitems' AND lower(r->>'endereco') = v_end
      ), ult AS (
        SELECT id, em, subject, preview FROM pares ORDER BY em DESC LIMIT 1
      ), agg AS (
        SELECT count(*)::int AS total, count(*) FILTER (WHERE nao_lido)::int AS unread,
               (array_agg(nome ORDER BY em DESC) FILTER (WHERE nome IS NOT NULL AND nome <> ''))[1] AS nome
          FROM pares
      )
      INSERT INTO mail_correspondents AS c (owner_person_id, address, name, last_at, last_item_id, last_subject, last_preview, unread, total)
      SELECT p_owner, v_end, agg.nome, ult.em, ult.id, ult.subject, ult.preview, agg.unread, agg.total FROM ult, agg
      ON CONFLICT (owner_person_id, address) DO UPDATE
        SET name = EXCLUDED.name, last_at = EXCLUDED.last_at, last_item_id = EXCLUDED.last_item_id, last_subject = EXCLUDED.last_subject,
            last_preview = EXCLUDED.last_preview, unread = EXCLUDED.unread, total = EXCLUDED.total;
      IF NOT FOUND THEN
        DELETE FROM mail_correspondents WHERE owner_person_id = p_owner AND address = v_end;
      END IF;
    END LOOP;
  END $$;
REVOKE ALL ON FUNCTION app.recalcular_correspondentes(uuid, text[]) FROM PUBLIC;

-- Endereços que contam para o resumo: remetente (Entrada) e destinatários (Enviados).
CREATE FUNCTION app.enderecos_do_resumo(i mail_items) RETURNS text[]
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT CASE WHEN i.folder = 'inbox' THEN ARRAY[i.from_address]
                ELSE ARRAY(SELECT DISTINCT lower(r->>'endereco') FROM jsonb_array_elements(i.to_recipients) r) END
  $$;
REVOKE ALL ON FUNCTION app.enderecos_do_resumo(mail_items) FROM PUBLIC;

CREATE FUNCTION app.mail_items_resumo() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE r record;
  BEGIN
    IF TG_OP = 'INSERT' THEN
      FOR r IN SELECT owner_person_id, array_agg(DISTINCT e) AS ends FROM novos n, unnest(app.enderecos_do_resumo(n)) e
                WHERE e IS NOT NULL GROUP BY owner_person_id LOOP
        PERFORM app.recalcular_correspondentes(r.owner_person_id, r.ends);
      END LOOP;
    ELSIF TG_OP = 'DELETE' THEN
      FOR r IN SELECT owner_person_id, array_agg(DISTINCT e) AS ends FROM antigos a, unnest(app.enderecos_do_resumo(a)) e
                WHERE e IS NOT NULL GROUP BY owner_person_id LOOP
        PERFORM app.recalcular_correspondentes(r.owner_person_id, r.ends);
      END LOOP;
    ELSE
      FOR r IN SELECT owner_person_id, array_agg(DISTINCT e) AS ends FROM (
                 SELECT n.owner_person_id, e FROM novos n, unnest(app.enderecos_do_resumo(n)) e
                 UNION ALL
                 SELECT a.owner_person_id, e FROM antigos a, unnest(app.enderecos_do_resumo(a)) e
               ) x WHERE e IS NOT NULL GROUP BY owner_person_id LOOP
        PERFORM app.recalcular_correspondentes(r.owner_person_id, r.ends);
      END LOOP;
    END IF;
    RETURN NULL;
  END $$;

CREATE TRIGGER mail_items_resumo_inserir AFTER INSERT ON mail_items REFERENCING NEW TABLE AS novos
  FOR EACH STATEMENT EXECUTE FUNCTION app.mail_items_resumo();
CREATE TRIGGER mail_items_resumo_mudar AFTER UPDATE ON mail_items REFERENCING OLD TABLE AS antigos NEW TABLE AS novos
  FOR EACH STATEMENT EXECUTE FUNCTION app.mail_items_resumo();
CREATE TRIGGER mail_items_resumo_apagar AFTER DELETE ON mail_items REFERENCING OLD TABLE AS antigos
  FOR EACH STATEMENT EXECUTE FUNCTION app.mail_items_resumo();

-- Carga do que já existe.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT owner_person_id, array_agg(DISTINCT e) AS ends
             FROM mail_items, unnest(app.enderecos_do_resumo(mail_items)) e
            WHERE e IS NOT NULL GROUP BY owner_person_id LOOP
    PERFORM app.recalcular_correspondentes(r.owner_person_id, r.ends);
  END LOOP;
END $$;
