-- Login interno (25/11/2026): quem não tem conta Microsoft da empresa entra com usuário e
-- senha. A conta é criada pela Administração (só admin), com uma senha provisória que a
-- pessoa troca no primeiro acesso; até trocar, o servidor não abre nada além da troca
-- (como o termo de uso). Sem conta Microsoft, não há caixa de e-mail: o módulo E-mail
-- fica fechado para essas contas; o resto vale como para qualquer pessoa (perfis,
-- funções, módulos).
--
-- * A senha é conferida no próprio banco (pgcrypto, bcrypt): o hash nunca sai daqui.
-- * 5 erros seguidos bloqueiam a conta por 15 minutos; usuário inexistente gasta o mesmo
--   tempo (não revela quem existe).
-- * O e-mail da pessoa (obrigatório e único em `people`) fica `<usuário>@interno.omni.invalid`:
--   um endereço que não existe, que nenhum login Microsoft tem e que não casa com
--   filtroAPP, Prisma ou e-mails.

ALTER TABLE people ADD COLUMN acesso text NOT NULL DEFAULT 'microsoft' CHECK (acesso IN ('microsoft', 'interno'));

CREATE TABLE internal_credentials (
  person_id            uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  login                text NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  password_hash        text NOT NULL,
  must_change          boolean NOT NULL DEFAULT true,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  password_changed_at  timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES people(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE internal_credentials ENABLE ROW LEVEL SECURITY;
-- Sem privilégios diretos para omni_app/omni_worker: só as funções abaixo leem ou mudam.

CREATE FUNCTION app.senha_aceitavel(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT p IS NOT NULL AND char_length(p) BETWEEN 10 AND 200 AND p ~ '[^0-9]' AND p ~ '[0-9]' $$;
GRANT EXECUTE ON FUNCTION app.senha_aceitavel(text) TO omni_app;

-- ---------------------------------------------------------------- entrar

CREATE FUNCTION app.login_interno(p_login text, p_senha text, p_token_hash bytea, p_ttl interval, p_user_agent text, p_ip inet)
  RETURNS TABLE (person_id uuid, resultado text)   -- ok | trocar_senha | invalido | bloqueado | desativada
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_cred internal_credentials%ROWTYPE;
    v_ativa boolean;
  BEGIN
    IF p_ttl <= interval '0' OR p_ttl > interval '30 days' THEN
      RAISE EXCEPTION 'Validade de sessão inválida';
    END IF;
    SELECT c.* INTO v_cred FROM internal_credentials c JOIN people p ON p.id = c.person_id
     WHERE c.login = lower(trim(coalesce(p_login, ''))) AND p.acesso = 'interno'
     FOR UPDATE OF c;
    IF v_cred.person_id IS NULL THEN
      PERFORM crypt(coalesce(p_senha, ''), gen_salt('bf', 10)); -- mesmo tempo de quem existe
      RETURN QUERY SELECT NULL::uuid, 'invalido'::text;
      RETURN;
    END IF;
    IF v_cred.locked_until > now() THEN
      RETURN QUERY SELECT NULL::uuid, 'bloqueado'::text;
      RETURN;
    END IF;
    IF crypt(coalesce(p_senha, ''), v_cred.password_hash) <> v_cred.password_hash THEN
      UPDATE internal_credentials
         SET failed_attempts = CASE WHEN failed_attempts + 1 >= 5 THEN 0 ELSE failed_attempts + 1 END,
             locked_until = CASE WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
       WHERE internal_credentials.person_id = v_cred.person_id;
      INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
      VALUES (NULL, 'login.interno_recusado', 'person', v_cred.person_id::text, jsonb_build_object('ip', host(p_ip)));
      RETURN QUERY SELECT NULL::uuid, CASE WHEN v_cred.failed_attempts + 1 >= 5 THEN 'bloqueado' ELSE 'invalido' END;
      RETURN;
    END IF;
    SELECT active INTO v_ativa FROM people WHERE id = v_cred.person_id;
    IF NOT v_ativa THEN
      RETURN QUERY SELECT NULL::uuid, 'desativada'::text;
      RETURN;
    END IF;
    UPDATE internal_credentials SET failed_attempts = 0, locked_until = NULL WHERE internal_credentials.person_id = v_cred.person_id;
    UPDATE people SET last_login_at = now() WHERE id = v_cred.person_id;
    -- Com senha provisória, a sessão é curta: só para trocar a senha.
    INSERT INTO sessions (token_hash, person_id, expires_at, user_agent, ip)
    VALUES (p_token_hash, v_cred.person_id, now() + CASE WHEN v_cred.must_change THEN least(p_ttl, interval '30 minutes') ELSE p_ttl END, left(p_user_agent, 400), p_ip);
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_cred.person_id, 'login', 'person', v_cred.person_id::text, jsonb_build_object('via', 'interno'));
    RETURN QUERY SELECT v_cred.person_id, CASE WHEN v_cred.must_change THEN 'trocar_senha' ELSE 'ok' END;
  END $$;

-- ---------------------------------------------------------------- Administração (só admin)

CREATE FUNCTION app.criar_acesso_interno(p_nome text, p_login text, p_senha text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_login text := lower(trim(coalesce(p_login, ''))); v_id uuid;
  BEGIN
    IF NOT app.has_profile('admin') THEN RAISE EXCEPTION 'sem permissão' USING ERRCODE = '42501'; END IF;
    IF v_login !~ '^[a-z0-9][a-z0-9._-]{2,39}$' THEN RAISE EXCEPTION 'usuário inválido' USING ERRCODE = '22023'; END IF;
    IF char_length(trim(coalesce(p_nome, ''))) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'nome inválido' USING ERRCODE = '22023'; END IF;
    IF NOT app.senha_aceitavel(p_senha) THEN RAISE EXCEPTION 'senha fraca' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM internal_credentials WHERE login = v_login) OR EXISTS (SELECT 1 FROM people WHERE email = (v_login || '@interno.omni.invalid')::citext) THEN
      RAISE EXCEPTION 'usuário já existe' USING ERRCODE = '23505';
    END IF;
    INSERT INTO people (email, display_name, acesso) VALUES (v_login || '@interno.omni.invalid', trim(p_nome), 'interno') RETURNING id INTO v_id;
    INSERT INTO internal_credentials (person_id, login, password_hash, must_change, created_by)
    VALUES (v_id, v_login, crypt(p_senha, gen_salt('bf', 11)), true, app.current_person_id());
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (app.current_person_id(), 'pessoa.acesso_interno_criado', 'person', v_id::text, jsonb_build_object('login', v_login));
    RETURN v_id;
  END $$;

CREATE FUNCTION app.redefinir_senha_interna(p_person uuid, p_senha text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NOT app.has_profile('admin') THEN RAISE EXCEPTION 'sem permissão' USING ERRCODE = '42501'; END IF;
    IF NOT app.senha_aceitavel(p_senha) THEN RAISE EXCEPTION 'senha fraca' USING ERRCODE = '22023'; END IF;
    UPDATE internal_credentials
       SET password_hash = crypt(p_senha, gen_salt('bf', 11)), must_change = true, failed_attempts = 0, locked_until = NULL, password_changed_at = now()
     WHERE person_id = p_person;
    IF NOT FOUND THEN RAISE EXCEPTION 'não é uma conta interna' USING ERRCODE = '22023'; END IF;
    UPDATE sessions SET revoked_at = now() WHERE person_id = p_person AND revoked_at IS NULL;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (app.current_person_id(), 'pessoa.senha_interna_redefinida', 'person', p_person::text, '{}'::jsonb);
  END $$;

-- Login das contas internas, para a lista de Pessoas (só admin; nunca o hash).
CREATE FUNCTION app.logins_internos() RETURNS TABLE (person_id uuid, login text, must_change boolean, locked_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT c.person_id, c.login, c.must_change, c.locked_until FROM internal_credentials c WHERE app.has_profile('admin') $$;

-- ---------------------------------------------------------------- a própria pessoa

CREATE FUNCTION app.trocar_minha_senha(p_atual text, p_nova text, p_token_hash bytea, p_ttl interval) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_me uuid := app.current_person_id(); v_hash text;
  BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'sem sessão' USING ERRCODE = '42501'; END IF;
    IF p_ttl <= interval '0' OR p_ttl > interval '30 days' THEN RAISE EXCEPTION 'Validade de sessão inválida'; END IF;
    SELECT password_hash INTO v_hash FROM internal_credentials WHERE person_id = v_me FOR UPDATE;
    IF v_hash IS NULL THEN RAISE EXCEPTION 'não é uma conta interna' USING ERRCODE = '22023'; END IF;
    IF crypt(coalesce(p_atual, ''), v_hash) <> v_hash THEN RAISE EXCEPTION 'senha atual não confere' USING ERRCODE = '28P01'; END IF;
    IF NOT app.senha_aceitavel(p_nova) THEN RAISE EXCEPTION 'senha fraca' USING ERRCODE = '22023'; END IF;
    IF p_nova = p_atual THEN RAISE EXCEPTION 'senha igual à atual' USING ERRCODE = '22023'; END IF;
    UPDATE internal_credentials SET password_hash = crypt(p_nova, gen_salt('bf', 11)), must_change = false, password_changed_at = now() WHERE person_id = v_me;
    -- As outras sessões saem; esta passa a valer o prazo normal.
    UPDATE sessions SET revoked_at = now() WHERE person_id = v_me AND token_hash <> p_token_hash AND revoked_at IS NULL;
    UPDATE sessions SET expires_at = now() + p_ttl WHERE person_id = v_me AND token_hash = p_token_hash AND revoked_at IS NULL;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_me, 'pessoa.senha_interna_trocada', 'person', v_me::text, '{}'::jsonb);
  END $$;

-- Sessão: além do termo, se falta trocar a senha provisória (o servidor não abre nada até trocar).
DROP FUNCTION app.sessao_com_termos(bytea, text);
CREATE FUNCTION app.sessao_com_termos(p_token_hash bytea, p_versao text)
  RETURNS TABLE (person_id uuid, termos_pendentes boolean, senha_pendente boolean, acesso text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_person uuid := app.resolve_session(p_token_hash);
  BEGIN
    IF v_person IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT v_person,
      NOT EXISTS (SELECT 1 FROM terms_acceptances t WHERE t.person_id = v_person AND t.versao = p_versao),
      coalesce((SELECT c.must_change FROM internal_credentials c WHERE c.person_id = v_person), false),
      (SELECT p.acesso FROM people p WHERE p.id = v_person);
  END $$;

REVOKE ALL ON FUNCTION app.login_interno(text, text, bytea, interval, text, inet), app.criar_acesso_interno(text, text, text),
  app.redefinir_senha_interna(uuid, text), app.logins_internos(), app.trocar_minha_senha(text, text, bytea, interval),
  app.sessao_com_termos(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.login_interno(text, text, bytea, interval, text, inet), app.criar_acesso_interno(text, text, text),
  app.redefinir_senha_interna(uuid, text), app.logins_internos(), app.trocar_minha_senha(text, text, bytea, interval),
  app.sessao_com_termos(bytea, text) TO omni_app;

-- ---------------------------------------------------------------- sem caixa de e-mail

-- Conta interna não tem caixa no Exchange: não cadastra caixa no primeiro login.
CREATE OR REPLACE FUNCTION app.caixa_da_pessoa() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    -- Contas fictícias do desenvolvimento (@omni.invalid) e contas internas não têm caixa.
    IF NEW.active AND NEW.last_login_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.last_login_at IS NULL)
       AND NEW.email::text NOT LIKE '%@omni.invalid' AND NEW.acesso <> 'interno' THEN
      INSERT INTO mail_mailboxes (email, added_by) VALUES (NEW.email, NEW.id) ON CONFLICT (email) DO NOTHING;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active THEN
      UPDATE mail_mailboxes SET active = false, last_error = 'Pessoa desativada no Omni.' WHERE email = NEW.email AND active;
    END IF;
    IF TG_OP = 'UPDATE' AND NOT OLD.active AND NEW.active THEN
      UPDATE mail_mailboxes SET active = true, last_error = NULL WHERE email = NEW.email AND NOT active AND last_error = 'Pessoa desativada no Omni.';
    END IF;
    RETURN NEW;
  END $$;

-- Módulo E-mail fechado para conta interna (mesmo com perfil de administração).
CREATE OR REPLACE FUNCTION app.modulo_liberado_para(p_person uuid, p_modulo text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT CASE
      WHEN p_person IS NULL THEN false
      WHEN p_modulo = 'emails' AND EXISTS (SELECT 1 FROM people WHERE id = p_person AND acesso = 'interno') THEN false
      WHEN EXISTS (SELECT 1 FROM person_profiles WHERE person_id = p_person AND profile = 'admin') THEN true
      ELSE coalesce((
        SELECT CASE m.mode
                 WHEN 'todos' THEN true
                 WHEN 'ninguem' THEN false
                 ELSE p_person = ANY (m.people)
                   OR EXISTS (SELECT 1 FROM person_profiles pp WHERE pp.person_id = p_person AND pp.profile = ANY (m.profiles))
               END
          FROM module_access m WHERE m.module = p_modulo), true)
    END
  $$;
