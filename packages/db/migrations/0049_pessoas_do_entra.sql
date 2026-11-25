-- Pessoas pelo Entra: quem está atribuído ao app "Omni" (Usuários e grupos, com
-- "Atribuição necessária") entra na lista de Pessoas antes do primeiro login, e a
-- Administração já define perfis e funções. O login (app.login) liga a conta pelo
-- e-mail ou pelo identificador da Microsoft (entra_oid).
-- Tirado do app (ou com a conta desativada no Entra): o Omni desativa a pessoa e
-- encerra as sessões; voltando, reativa. Quem a Administração desativou à mão não
-- é reativado pelo Entra. A última pessoa administradora ativa nunca é desativada
-- pelo Entra (fica o aviso para a Administração).

ALTER TABLE people
  ADD COLUMN entra_atribuido     boolean,       -- null: nunca veio do Entra
  ADD COLUMN entra_sincronizado_em timestamptz,
  ADD COLUMN inativo_por         text CHECK (inativo_por IN ('entra', 'admin'));

-- Pessoa desativada antes desta migration foi pela Administração.
UPDATE people SET inativo_por = 'admin' WHERE NOT active;

-- Uma pessoa atribuída ao app (direta ou por grupo) com a conta ativa no Entra.
-- Devolve: criada | atualizada | reativada | conflito (e-mail já ligado a outra conta Microsoft).
CREATE FUNCTION app.entra_sincronizar_pessoa(p_oid uuid, p_email text, p_nome text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v people%ROWTYPE; v_email text := lower(btrim(p_email)); v_nome text := left(btrim(coalesce(p_nome, '')), 200);
  BEGIN
    IF p_oid IS NULL OR v_email !~ '^[^@\s]+@[^@\s]+$' THEN RETURN 'invalido'; END IF;
    IF v_nome = '' THEN v_nome := split_part(v_email, '@', 1); END IF;
    SELECT * INTO v FROM people WHERE entra_oid = p_oid;
    IF v.id IS NULL THEN
      SELECT * INTO v FROM people WHERE email = v_email::citext;
      IF v.id IS NOT NULL AND v.entra_oid IS NOT NULL AND v.entra_oid <> p_oid THEN RETURN 'conflito'; END IF;
    END IF;
    IF v.id IS NULL THEN
      INSERT INTO people (entra_oid, email, display_name, entra_atribuido, entra_sincronizado_em)
      VALUES (p_oid, v_email, v_nome, true, now());
      INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
      VALUES (NULL, 'pessoa.criada_pelo_entra', 'person', (SELECT id FROM people WHERE entra_oid = p_oid)::text, '{}'::jsonb);
      RETURN 'criada';
    END IF;
    -- E-mail novo no Entra: acompanha, se nenhum outro registro já usa o endereço.
    UPDATE people
       SET entra_oid = p_oid,
           email = CASE WHEN email <> v_email::citext AND NOT EXISTS (SELECT 1 FROM people o WHERE o.email = v_email::citext AND o.id <> v.id) THEN v_email ELSE email END,
           display_name = v_nome,
           entra_atribuido = true,
           entra_sincronizado_em = now(),
           active = CASE WHEN NOT active AND inativo_por = 'entra' THEN true ELSE active END,
           inativo_por = CASE WHEN NOT active AND inativo_por = 'entra' THEN NULL ELSE inativo_por END,
           updated_at = now()
     WHERE id = v.id;
    IF NOT v.active AND v.inativo_por = 'entra' THEN
      INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
      VALUES (NULL, 'pessoa.reativada_pelo_entra', 'person', v.id::text, '{}'::jsonb);
      RETURN 'reativada';
    END IF;
    RETURN 'atualizada';
  END $$;

-- Quem veio do Entra e não está mais atribuído (ou teve a conta desativada): desativa
-- e encerra as sessões. Devolve quantas foram desativadas; a última administradora
-- ativa fica de fora.
CREATE FUNCTION app.entra_encerrar_ausentes(p_atribuidos uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_saiu uuid; n integer := 0;
  BEGIN
    IF coalesce(cardinality(p_atribuidos), 0) = 0 THEN RETURN 0; END IF; -- lista vazia: leitura falhou ou app sem ninguém; não mexe
    -- Só na passagem de atribuída para fora do app: se a Administração reativar
    -- depois, o Entra não desativa de novo a cada rodada.
    FOR v_saiu IN
      UPDATE people SET entra_atribuido = false, entra_sincronizado_em = now()
       WHERE entra_atribuido AND entra_oid IS NOT NULL AND NOT (entra_oid = ANY (p_atribuidos))
      RETURNING id
    LOOP
      CONTINUE WHEN NOT (SELECT active FROM people WHERE id = v_saiu);
      -- Nunca a última pessoa administradora ativa.
      IF EXISTS (SELECT 1 FROM person_profiles pp WHERE pp.person_id = v_saiu AND pp.profile = 'admin')
         AND NOT EXISTS (SELECT 1 FROM person_profiles pp JOIN people o ON o.id = pp.person_id
                          WHERE pp.profile = 'admin' AND o.active AND o.id <> v_saiu) THEN
        CONTINUE;
      END IF;
      UPDATE people SET active = false, inativo_por = 'entra', updated_at = now() WHERE id = v_saiu;
      DELETE FROM sessions WHERE person_id = v_saiu;
      INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
      VALUES (NULL, 'pessoa.desativada_pelo_entra', 'person', v_saiu::text, '{}'::jsonb);
      n := n + 1;
    END LOOP;
    RETURN n;
  END $$;

REVOKE ALL ON FUNCTION app.entra_sincronizar_pessoa(uuid, text, text), app.entra_encerrar_ausentes(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.entra_sincronizar_pessoa(uuid, text, text), app.entra_encerrar_ausentes(uuid[]) TO omni_worker;
