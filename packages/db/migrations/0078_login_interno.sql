-- Login interno (25/11/2026): quem não tem conta Microsoft da empresa entra com usuário e
-- senha. A conta é criada pela Administração (só admin), sem senha: a Administração passa
-- à pessoa um LINK DE USO ÚNICO (vale 7 dias) em que ela cria a própria senha. Sem conta
-- Microsoft, não há caixa de e-mail: o módulo E-mail fica fechado para essas contas; o
-- resto vale como para qualquer pessoa (perfis, funções, módulos).
--
-- * A senha é conferida no próprio banco (pgcrypto, bcrypt): o hash nunca sai daqui.
-- * 5 erros seguidos bloqueiam a conta por 15 minutos; usuário inexistente ou ainda sem
--   senha gasta o mesmo tempo (não revela quem existe).
-- * Links: só o SHA-256 fica no banco; uso único; o de criar a senha vale 7 dias.
-- * "Esqueci a senha" só funciona com um e-mail pessoal cadastrado E confirmado pela
--   pessoa (link de confirmação, 24 h); o link de recuperação vale 1 hora, no máximo 3
--   pedidos por hora. Sem e-mail pessoal, só a Administração gera um link novo.
-- * O e-mail da pessoa em `people` (obrigatório e único) fica `<usuário>@interno.omni.invalid`:
--   um endereço que não existe, que nenhum login Microsoft tem e que não casa com
--   filtroAPP, Prisma ou e-mails. O e-mail pessoal de recuperação fica só aqui.

ALTER TABLE people ADD COLUMN acesso text NOT NULL DEFAULT 'microsoft' CHECK (acesso IN ('microsoft', 'interno'));

CREATE TABLE internal_credentials (
  person_id             uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  login                 text NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  password_hash         text,                 -- null até a pessoa criar pelo link
  recovery_email        citext,               -- e-mail pessoal confirmado (recuperar a senha)
  recovery_verified_at  timestamptz,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  password_changed_at   timestamptz,
  created_by            uuid REFERENCES people(id),
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE internal_credentials ENABLE ROW LEVEL SECURITY;

CREATE TABLE internal_links (
  token_hash  bytea PRIMARY KEY,
  person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('senha', 'recuperar', 'confirmar_email')),
  email       citext,                         -- só no confirmar_email
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_by  uuid REFERENCES people(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'confirmar_email') = (email IS NOT NULL))
);
CREATE INDEX internal_links_pessoa ON internal_links (person_id, kind, created_at);
ALTER TABLE internal_links ENABLE ROW LEVEL SECURITY;
-- As duas tabelas sem privilégios para omni_app/omni_worker: só as funções abaixo leem ou mudam.

CREATE FUNCTION app.senha_aceitavel(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT p IS NOT NULL AND char_length(p) BETWEEN 10 AND 200 AND p ~ '[^0-9]' AND p ~ '[0-9]' $$;
GRANT EXECUTE ON FUNCTION app.senha_aceitavel(text) TO omni_app;

-- ---------------------------------------------------------------- entrar

CREATE FUNCTION app.login_interno(p_login text, p_senha text, p_token_hash bytea, p_ttl interval, p_user_agent text, p_ip inet)
  RETURNS TABLE (person_id uuid, resultado text)   -- ok | invalido | bloqueado | desativada
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
    IF v_cred.person_id IS NULL OR v_cred.password_hash IS NULL THEN
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
    INSERT INTO sessions (token_hash, person_id, expires_at, user_agent, ip)
    VALUES (p_token_hash, v_cred.person_id, now() + p_ttl, left(p_user_agent, 400), p_ip);
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_cred.person_id, 'login', 'person', v_cred.person_id::text, jsonb_build_object('via', 'interno'));
    RETURN QUERY SELECT v_cred.person_id, 'ok'::text;
  END $$;

-- ---------------------------------------------------------------- Administração (só admin)

CREATE FUNCTION app.criar_acesso_interno(p_nome text, p_login text, p_link_hash bytea) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_login text := lower(trim(coalesce(p_login, ''))); v_id uuid;
  BEGIN
    IF NOT app.has_profile('admin') THEN RAISE EXCEPTION 'sem permissão' USING ERRCODE = '42501'; END IF;
    IF v_login !~ '^[a-z0-9][a-z0-9._-]{2,39}$' THEN RAISE EXCEPTION 'usuário inválido' USING ERRCODE = '22023'; END IF;
    IF char_length(trim(coalesce(p_nome, ''))) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'nome inválido' USING ERRCODE = '22023'; END IF;
    IF EXISTS (SELECT 1 FROM internal_credentials WHERE login = v_login) OR EXISTS (SELECT 1 FROM people WHERE email = (v_login || '@interno.omni.invalid')::citext) THEN
      RAISE EXCEPTION 'usuário já existe' USING ERRCODE = '23505';
    END IF;
    INSERT INTO people (email, display_name, acesso) VALUES (v_login || '@interno.omni.invalid', trim(p_nome), 'interno') RETURNING id INTO v_id;
    INSERT INTO internal_credentials (person_id, login, created_by) VALUES (v_id, v_login, app.current_person_id());
    INSERT INTO internal_links (token_hash, person_id, kind, expires_at, created_by)
    VALUES (p_link_hash, v_id, 'senha', now() + interval '7 days', app.current_person_id());
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (app.current_person_id(), 'pessoa.acesso_interno_criado', 'person', v_id::text, jsonb_build_object('login', v_login));
    RETURN v_id;
  END $$;

-- Link novo para criar a senha (esqueceu, link venceu): a senha atual deixa de valer e as sessões saem.
CREATE FUNCTION app.novo_link_de_senha(p_person uuid, p_link_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF NOT app.has_profile('admin') THEN RAISE EXCEPTION 'sem permissão' USING ERRCODE = '42501'; END IF;
    UPDATE internal_credentials SET password_hash = NULL, failed_attempts = 0, locked_until = NULL WHERE person_id = p_person;
    IF NOT FOUND THEN RAISE EXCEPTION 'não é uma conta interna' USING ERRCODE = '22023'; END IF;
    DELETE FROM internal_links WHERE person_id = p_person AND kind IN ('senha', 'recuperar') AND used_at IS NULL;
    INSERT INTO internal_links (token_hash, person_id, kind, expires_at, created_by)
    VALUES (p_link_hash, p_person, 'senha', now() + interval '7 days', app.current_person_id());
    UPDATE sessions SET revoked_at = now() WHERE person_id = p_person AND revoked_at IS NULL;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (app.current_person_id(), 'pessoa.link_de_senha_gerado', 'person', p_person::text, '{}'::jsonb);
  END $$;

-- Contas internas para a lista de Pessoas (só admin; nunca o hash nem o e-mail pessoal).
CREATE FUNCTION app.logins_internos()
  RETURNS TABLE (person_id uuid, login text, tem_senha boolean, link_vale_ate timestamptz, locked_until timestamptz, tem_email_recuperacao boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.person_id, c.login, c.password_hash IS NOT NULL,
           (SELECT max(l.expires_at) FROM internal_links l WHERE l.person_id = c.person_id AND l.kind = 'senha' AND l.used_at IS NULL AND l.expires_at > now()),
           c.locked_until, c.recovery_email IS NOT NULL
      FROM internal_credentials c WHERE app.has_profile('admin')
  $$;

-- ---------------------------------------------------------------- links (sem sessão)

-- O que o link é, para a página mostrar (nome e usuário só se o link ainda vale).
CREATE FUNCTION app.link_interno(p_hash bytea) RETURNS TABLE (tipo text, nome text, login text, valido boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT l.kind,
           CASE WHEN ok THEN p.display_name END,
           CASE WHEN ok THEN c.login END,
           ok
      FROM internal_links l
      JOIN people p ON p.id = l.person_id
      JOIN internal_credentials c ON c.person_id = l.person_id
      CROSS JOIN LATERAL (SELECT l.used_at IS NULL AND l.expires_at > now() AND p.active AS ok) v
     WHERE l.token_hash = p_hash
  $$;

-- Criar (ou recuperar) a senha pelo link: uso único; devolve o usuário para a tela de entrar.
CREATE FUNCTION app.usar_link_de_senha(p_hash bytea, p_senha text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_link internal_links%ROWTYPE; v_login text;
  BEGIN
    SELECT * INTO v_link FROM internal_links WHERE token_hash = p_hash AND kind IN ('senha', 'recuperar') FOR UPDATE;
    IF v_link.person_id IS NULL OR v_link.used_at IS NOT NULL OR v_link.expires_at <= now()
       OR NOT (SELECT active FROM people WHERE id = v_link.person_id) THEN
      RAISE EXCEPTION 'link inválido' USING ERRCODE = '22023';
    END IF;
    IF NOT app.senha_aceitavel(p_senha) THEN RAISE EXCEPTION 'senha fraca' USING ERRCODE = '22023'; END IF;
    UPDATE internal_credentials SET password_hash = crypt(p_senha, gen_salt('bf', 11)), failed_attempts = 0, locked_until = NULL, password_changed_at = now()
     WHERE person_id = v_link.person_id RETURNING login INTO v_login;
    -- Este e qualquer outro link de senha em aberto deixam de valer; as sessões antigas saem.
    UPDATE internal_links SET used_at = now() WHERE person_id = v_link.person_id AND kind IN ('senha', 'recuperar') AND used_at IS NULL;
    UPDATE sessions SET revoked_at = now() WHERE person_id = v_link.person_id AND revoked_at IS NULL;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_link.person_id, 'pessoa.senha_interna_criada', 'person', v_link.person_id::text, jsonb_build_object('via', v_link.kind));
    RETURN v_login;
  END $$;

-- Confirmar o e-mail pessoal pelo link que chegou nele: passa a valer para recuperar a senha.
CREATE FUNCTION app.confirmar_email_pelo_link(p_hash bytea) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_link internal_links%ROWTYPE; v_login text;
  BEGIN
    SELECT * INTO v_link FROM internal_links WHERE token_hash = p_hash AND kind = 'confirmar_email' FOR UPDATE;
    IF v_link.person_id IS NULL OR v_link.used_at IS NOT NULL OR v_link.expires_at <= now() THEN
      RAISE EXCEPTION 'link inválido' USING ERRCODE = '22023';
    END IF;
    UPDATE internal_credentials SET recovery_email = v_link.email, recovery_verified_at = now() WHERE person_id = v_link.person_id RETURNING login INTO v_login;
    UPDATE internal_links SET used_at = now() WHERE person_id = v_link.person_id AND kind = 'confirmar_email' AND used_at IS NULL;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_link.person_id, 'pessoa.email_recuperacao_confirmado', 'person', v_link.person_id::text, '{}'::jsonb);
    RETURN v_login;
  END $$;

-- "Esqueci a senha": só com e-mail pessoal confirmado; devolve o e-mail para onde mandar o
-- link (null em qualquer outro caso: a tela responde igual, sem revelar quem tem e-mail).
CREATE FUNCTION app.pedir_recuperacao(p_login text, p_link_hash bytea) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_cred internal_credentials%ROWTYPE;
  BEGIN
    SELECT c.* INTO v_cred FROM internal_credentials c JOIN people p ON p.id = c.person_id
     WHERE c.login = lower(trim(coalesce(p_login, ''))) AND p.acesso = 'interno' AND p.active;
    IF v_cred.person_id IS NULL OR v_cred.recovery_email IS NULL THEN RETURN NULL; END IF;
    IF (SELECT count(*) FROM internal_links WHERE person_id = v_cred.person_id AND kind = 'recuperar' AND created_at > now() - interval '1 hour') >= 3 THEN
      RETURN NULL;
    END IF;
    INSERT INTO internal_links (token_hash, person_id, kind, expires_at) VALUES (p_link_hash, v_cred.person_id, 'recuperar', now() + interval '1 hour');
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (NULL, 'pessoa.recuperacao_pedida', 'person', v_cred.person_id::text, '{}'::jsonb);
    RETURN v_cred.recovery_email::text;
  END $$;

-- ---------------------------------------------------------------- a própria pessoa (com sessão)

CREATE FUNCTION app.trocar_minha_senha(p_atual text, p_nova text, p_token_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_me uuid := app.current_person_id(); v_hash text;
  BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'sem sessão' USING ERRCODE = '42501'; END IF;
    SELECT password_hash INTO v_hash FROM internal_credentials WHERE person_id = v_me FOR UPDATE;
    IF v_hash IS NULL THEN RAISE EXCEPTION 'não é uma conta interna' USING ERRCODE = '22023'; END IF;
    IF crypt(coalesce(p_atual, ''), v_hash) <> v_hash THEN RAISE EXCEPTION 'senha atual não confere' USING ERRCODE = '28P01'; END IF;
    IF NOT app.senha_aceitavel(p_nova) THEN RAISE EXCEPTION 'senha fraca' USING ERRCODE = '22023'; END IF;
    IF p_nova = p_atual THEN RAISE EXCEPTION 'senha igual à atual' USING ERRCODE = '22023'; END IF;
    UPDATE internal_credentials SET password_hash = crypt(p_nova, gen_salt('bf', 11)), password_changed_at = now() WHERE person_id = v_me;
    UPDATE sessions SET revoked_at = now() WHERE person_id = v_me AND token_hash <> p_token_hash AND revoked_at IS NULL;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_me, 'pessoa.senha_interna_trocada', 'person', v_me::text, '{}'::jsonb);
  END $$;

-- Cadastrar (ou trocar) o e-mail pessoal: pede a senha atual e só vale depois de confirmado
-- pelo link que chega nele (24 h; no máximo 3 por hora).
CREATE FUNCTION app.pedir_confirmacao_de_email(p_senha text, p_email text, p_link_hash bytea) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_me uuid := app.current_person_id(); v_hash text; v_email text := lower(trim(coalesce(p_email, '')));
  BEGIN
    IF v_me IS NULL THEN RAISE EXCEPTION 'sem sessão' USING ERRCODE = '42501'; END IF;
    SELECT password_hash INTO v_hash FROM internal_credentials WHERE person_id = v_me;
    IF v_hash IS NULL THEN RAISE EXCEPTION 'não é uma conta interna' USING ERRCODE = '22023'; END IF;
    IF crypt(coalesce(p_senha, ''), v_hash) <> v_hash THEN RAISE EXCEPTION 'senha atual não confere' USING ERRCODE = '28P01'; END IF;
    IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 200 OR v_email LIKE '%.invalid' THEN
      RAISE EXCEPTION 'e-mail inválido' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM internal_links WHERE person_id = v_me AND kind = 'confirmar_email' AND created_at > now() - interval '1 hour') >= 3 THEN
      RAISE EXCEPTION 'muitos pedidos' USING ERRCODE = '22023';
    END IF;
    INSERT INTO internal_links (token_hash, person_id, kind, email, expires_at) VALUES (p_link_hash, v_me, 'confirmar_email', v_email, now() + interval '24 hours');
  END $$;

CREATE FUNCTION app.tirar_email_de_recuperacao(p_senha text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_me uuid := app.current_person_id(); v_hash text;
  BEGIN
    SELECT password_hash INTO v_hash FROM internal_credentials WHERE person_id = v_me;
    IF v_me IS NULL OR v_hash IS NULL THEN RAISE EXCEPTION 'não é uma conta interna' USING ERRCODE = '22023'; END IF;
    IF crypt(coalesce(p_senha, ''), v_hash) <> v_hash THEN RAISE EXCEPTION 'senha atual não confere' USING ERRCODE = '28P01'; END IF;
    UPDATE internal_credentials SET recovery_email = NULL, recovery_verified_at = NULL WHERE person_id = v_me;
    DELETE FROM internal_links WHERE person_id = v_me AND kind IN ('confirmar_email', 'recuperar') AND used_at IS NULL;
  END $$;

CREATE FUNCTION app.minha_conta_interna() RETURNS TABLE (login text, email_recuperacao text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT c.login, c.recovery_email::text FROM internal_credentials c WHERE c.person_id = app.current_person_id() $$;

-- Sessão: além do termo, como a pessoa entra (conta interna não tem e-mail).
DROP FUNCTION app.sessao_com_termos(bytea, text);
CREATE FUNCTION app.sessao_com_termos(p_token_hash bytea, p_versao text)
  RETURNS TABLE (person_id uuid, termos_pendentes boolean, acesso text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_person uuid := app.resolve_session(p_token_hash);
  BEGIN
    IF v_person IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT v_person,
      NOT EXISTS (SELECT 1 FROM terms_acceptances t WHERE t.person_id = v_person AND t.versao = p_versao),
      (SELECT p.acesso FROM people p WHERE p.id = v_person);
  END $$;

REVOKE ALL ON FUNCTION app.login_interno(text, text, bytea, interval, text, inet), app.criar_acesso_interno(text, text, bytea),
  app.novo_link_de_senha(uuid, bytea), app.logins_internos(), app.link_interno(bytea), app.usar_link_de_senha(bytea, text),
  app.confirmar_email_pelo_link(bytea), app.pedir_recuperacao(text, bytea), app.trocar_minha_senha(text, text, bytea),
  app.pedir_confirmacao_de_email(text, text, bytea), app.tirar_email_de_recuperacao(text), app.minha_conta_interna(),
  app.sessao_com_termos(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.login_interno(text, text, bytea, interval, text, inet), app.criar_acesso_interno(text, text, bytea),
  app.novo_link_de_senha(uuid, bytea), app.logins_internos(), app.link_interno(bytea), app.usar_link_de_senha(bytea, text),
  app.confirmar_email_pelo_link(bytea), app.pedir_recuperacao(text, bytea), app.trocar_minha_senha(text, text, bytea),
  app.pedir_confirmacao_de_email(text, text, bytea), app.tirar_email_de_recuperacao(text), app.minha_conta_interna(),
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
