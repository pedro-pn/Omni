-- 0012 · API /api/v1 de tarefas compatível com o Foco, chaves pessoais e a
-- autorização do Prisma (PKCE S256), com as mesmas regras do Foco.
--
-- * api_keys: só o hash SHA-256 da chave (igual ao Foco, para migrar as chaves
--   existentes sem trocar). Prefixo `foco_live_` mantido: o Prisma valida esse
--   formato. Escopos: read, write e tasks:read:self (concessão do Prisma: só
--   ler as próprias tarefas).
-- * A API resolve a chave por app.resolver_chave_api (sem sessão) e depois age
--   com a identidade do dono da chave (withPerson): valem as mesmas políticas
--   RLS da tela.
-- * O segredo (chave, código) é gerado no servidor; o banco só recebe hashes.

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid NOT NULL REFERENCES people(id),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 80),
  key_prefix    text NOT NULL,
  key_hash      bytea NOT NULL UNIQUE,
  scopes        text[] NOT NULL DEFAULT ARRAY['read'] CHECK (scopes <@ ARRAY['read', 'write', 'tasks:read:self'] AND cardinality(scopes) > 0),
  client        text CHECK (client IN ('prisma')),   -- criada por autorização de um app (não pela pessoa)
  last_used_at  timestamptz,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  foco_id       uuid UNIQUE
);
CREATE INDEX api_keys_person ON api_keys (person_id);

GRANT SELECT ON api_keys TO omni_app;
GRANT UPDATE (revoked_at) ON api_keys TO omni_app;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY api_keys_select ON api_keys FOR SELECT TO omni_app USING (person_id = app.current_person_id());
CREATE POLICY api_keys_revoke ON api_keys FOR UPDATE TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());

CREATE TABLE api_auth_codes (
  code_hash   bytea PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES people(id),
  email       citext NOT NULL,
  client      text NOT NULL CHECK (client IN ('prisma')),
  challenge   text NOT NULL,
  expires_at  timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
ALTER TABLE api_auth_codes ENABLE ROW LEVEL SECURITY;
-- Sem privilégios diretos: só as funções abaixo mexem nos códigos.

-- ---------------------------------------------------------------- chaves pessoais

CREATE FUNCTION app.criar_chave_api(p_nome text, p_scopes text[], p_hash bytea, p_prefixo text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_id uuid;
BEGIN
  IF app.current_person_id() IS NULL OR NOT app.has_any_profile() THEN
    RAISE EXCEPTION 'sem permissão para criar chave' USING ERRCODE = '42501';
  END IF;
  IF NOT (p_scopes <@ ARRAY['read', 'write']) THEN
    RAISE EXCEPTION 'escopo inválido' USING ERRCODE = '22023';
  END IF;
  INSERT INTO api_keys (person_id, name, key_prefix, key_hash, scopes)
    VALUES (app.current_person_id(), btrim(p_nome), p_prefixo, p_hash, p_scopes) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Quem é o dono da chave (chave ativa e pessoa ativa). Marca o último uso.
CREATE FUNCTION app.resolver_chave_api(p_hash bytea)
  RETURNS TABLE (key_id uuid, person_id uuid, email citext, scopes text[], client text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  RETURN QUERY
    UPDATE api_keys k SET last_used_at = now()
      FROM people p
     WHERE k.key_hash = p_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
       AND p.id = k.person_id AND p.active
    RETURNING k.id, k.person_id, p.email, k.scopes, k.client;
END $$;

-- ---------------------------------------------------------------- autorização do Prisma (PKCE)

-- Tela de consentimento: a pessoa logada com o mesmo e-mail do Prisma emite um código de uso único.
CREATE FUNCTION app.emitir_codigo_prisma(p_code_hash bytea, p_challenge text, p_email text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_email citext;
BEGIN
  SELECT email INTO v_email FROM people WHERE id = app.current_person_id() AND active;
  IF v_email IS NULL OR v_email IS DISTINCT FROM lower(btrim(p_email))::citext THEN
    RAISE EXCEPTION 'Entre no Omni com o mesmo e-mail da sua conta do Prisma.' USING ERRCODE = '42501';
  END IF;
  IF p_challenge IS NULL OR p_challenge !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'Pedido de autorização inválido.' USING ERRCODE = '22023';
  END IF;
  IF NOT app.has_any_profile() THEN
    RAISE EXCEPTION 'Seu acesso ao Omni ainda não foi liberado.' USING ERRCODE = '42501';
  END IF;
  DELETE FROM api_auth_codes WHERE expires_at < now() OR person_id = app.current_person_id();
  INSERT INTO api_auth_codes (code_hash, person_id, email, client, challenge)
    VALUES (p_code_hash, app.current_person_id(), v_email, 'prisma', p_challenge);
END $$;

-- Troca do código (sem sessão): confere uso único, validade, PKCE e a conta; cria a chave de leitura.
-- Devolve o e-mail da conta, ou NULL se o pedido não vale.
CREATE FUNCTION app.trocar_codigo_prisma(p_code_hash bytea, p_challenge text, p_token_hash bytea, p_prefixo text) RETURNS citext
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_codigo api_auth_codes;
BEGIN
  SELECT * INTO v_codigo FROM api_auth_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF v_codigo.person_id IS NULL OR v_codigo.expires_at <= now() OR v_codigo.challenge IS DISTINCT FROM p_challenge THEN
    RETURN NULL;
  END IF;
  DELETE FROM api_auth_codes WHERE code_hash = p_code_hash;
  IF NOT EXISTS (SELECT 1 FROM people WHERE id = v_codigo.person_id AND active AND email = v_codigo.email) THEN
    RETURN NULL;
  END IF;
  INSERT INTO api_keys (person_id, name, key_prefix, key_hash, scopes, client)
    VALUES (v_codigo.person_id, 'Prisma — atividades somente leitura', p_prefixo, p_token_hash, ARRAY['tasks:read:self'], 'prisma');
  RETURN v_codigo.email;
END $$;

-- Revogação pelo Prisma (sem sessão, com a própria chave): só chaves criadas pela autorização do Prisma.
CREATE FUNCTION app.revogar_chave_prisma(p_hash bytea) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ UPDATE api_keys SET revoked_at = coalesce(revoked_at, now()) WHERE key_hash = p_hash AND client = 'prisma' $$;

GRANT EXECUTE ON FUNCTION app.criar_chave_api(text, text[], bytea, text), app.resolver_chave_api(bytea),
  app.emitir_codigo_prisma(bytea, text, text), app.trocar_codigo_prisma(bytea, text, bytea, text),
  app.revogar_chave_prisma(bytea) TO omni_app;
