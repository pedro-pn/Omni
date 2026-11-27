-- E-mail na conversa entre duas pessoas (27/11/2026): um e-mail só entra na conversa com X (linha
-- do tempo da caixa única, "marcar como lido" ao abrir, resumo por correspondente: hora, prévia e
-- não lidos) quando um mandou e o outro está no Para. Antes valia qualquer endereço do e-mail
-- (de, para e cc): um e-mail de terceiro com os dois em cópia aparecia na conversa entre eles.

-- Algum destes endereços está nesta lista de destinatários (to_recipients/cc_recipients)?
CREATE FUNCTION app.destinatario_em(p_lista jsonb, p_enderecos text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p_lista, '[]'::jsonb)) r WHERE lower(r->>'endereco') = ANY (p_enderecos))
  $$;
REVOKE ALL ON FUNCTION app.destinatario_em(jsonb, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.destinatario_em(jsonb, text[]) TO omni_app, omni_worker;

-- O e-mail é da conversa do dono (p_eu) com quem tem estes endereços: recebido DELE com o dono no
-- Para, ou enviado pelo dono com ele no Para.
CREATE FUNCTION app.email_da_conversa(p_pasta text, p_de text, p_para jsonb, p_enderecos text[], p_eu text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  AS $$
    SELECT CASE p_pasta
             WHEN 'inbox' THEN lower(p_de) = ANY (p_enderecos) AND app.destinatario_em(p_para, ARRAY[lower(p_eu)])
             WHEN 'sentitems' THEN app.destinatario_em(p_para, p_enderecos)
             ELSE false
           END
  $$;
REVOKE ALL ON FUNCTION app.email_da_conversa(text, text, jsonb, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.email_da_conversa(text, text, jsonb, text[], text) TO omni_app, omni_worker;

CREATE OR REPLACE FUNCTION app.recalcular_correspondentes(p_owner uuid, p_enderecos text[]) RETURNS void
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
           -- 0092: só o que a pessoa mandou PARA o dono (cópia não conta).
           AND app.destinatario_em(c.to_recipients, ARRAY[v_eu])
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

-- Refaz o resumo de todos (quem só aparecia por e-mails em cópia sai; o resto fica igual nos Enviados).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT owner_person_id, array_agg(DISTINCT address) AS ends FROM mail_correspondents GROUP BY owner_person_id LOOP
    PERFORM app.recalcular_correspondentes(r.owner_person_id, r.ends);
  END LOOP;
END $$;
