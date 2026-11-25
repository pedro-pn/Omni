-- O e-mail de cada pessoa fica conectado ao entrar no Omni (12/11/2026): no primeiro
-- login, a caixa dela entra em mail_mailboxes sem depender da Administração. O
-- Exchange continua decidindo de fato: só caixas no grupo "Omni - Caixas" (RBAC para
-- aplicativos) abrem pelo Graph; fora dele, o worker marca a caixa com o aviso.
-- Pessoa desativada: a caixa dela é desligada (deixa de ser lida) e volta se a pessoa
-- for reativada. Uma caixa que a Administração desligou não volta sozinha.

CREATE FUNCTION app.caixa_da_pessoa() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  BEGIN
    -- Contas fictícias do desenvolvimento (@omni.invalid) não têm caixa.
    IF NEW.active AND NEW.last_login_at IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.last_login_at IS NULL) AND NEW.email::text NOT LIKE '%@omni.invalid' THEN
      INSERT INTO mail_mailboxes (email, added_by) VALUES (NEW.email, NEW.id) ON CONFLICT (email) DO NOTHING;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.active AND NOT NEW.active THEN
      UPDATE mail_mailboxes SET active = false, last_error = 'Pessoa desativada no Omni.' WHERE email = NEW.email AND active;
    END IF;
    -- Reativada: volta só a caixa que foi desligada por causa da desativação.
    IF TG_OP = 'UPDATE' AND NOT OLD.active AND NEW.active THEN
      UPDATE mail_mailboxes SET active = true, last_error = NULL WHERE email = NEW.email AND NOT active AND last_error = 'Pessoa desativada no Omni.';
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER people_caixa_no_login AFTER INSERT OR UPDATE OF last_login_at, active ON people
  FOR EACH ROW EXECUTE FUNCTION app.caixa_da_pessoa();

-- Quem já entrou antes desta mudança.
INSERT INTO mail_mailboxes (email, added_by)
SELECT p.email, p.id FROM people p WHERE p.active AND p.last_login_at IS NOT NULL AND p.email::text NOT LIKE '%@omni.invalid'
ON CONFLICT (email) DO NOTHING;
