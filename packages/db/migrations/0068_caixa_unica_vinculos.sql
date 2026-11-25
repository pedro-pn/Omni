-- Caixa única, fase 3 (17/11/2026): vínculo automático de e-mail e telefone.
--   * De onde veio cada e-mail/telefone do contato (manual, assinatura do e-mail,
--     Prisma, sugestão aceita) — a tela mostra "vinculado pela assinatura".
--   * O worker liga sozinho o telefone conferido na assinatura dos e-mails
--     (email_signature_extractions, 0044) ao e-mail do remetente: só insere, e só
--     quando o e-mail ou o telefone ainda não é de outro contato.
--   * "Não é a mesma pessoa": a sugestão por nome some só para quem recusou.
--   * Empresa do Prisma pelo domínio do e-mail (para enviar o contato do cliente).

ALTER TABLE contact_identities
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'assinatura', 'prisma', 'sugestao'));

CREATE POLICY contacts_worker_insere ON contacts FOR INSERT TO omni_worker WITH CHECK (created_by IS NULL);
CREATE POLICY identities_worker_insere ON contact_identities FOR INSERT TO omni_worker WITH CHECK (created_by IS NULL AND source = 'assinatura');
GRANT INSERT ON contacts, contact_identities TO omni_worker;
CREATE POLICY signatures_leitura_worker_agenda ON email_signature_extractions FOR SELECT TO omni_worker USING (true);

CREATE TABLE contact_link_dismissals (
  person_id   uuid NOT NULL DEFAULT app.current_person_id() REFERENCES people(id) ON DELETE CASCADE,
  email       text NOT NULL CHECK (email = lower(email)),
  phone       text NOT NULL CHECK (phone ~ '^\d{8,15}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, email, phone)
);
ALTER TABLE contact_link_dismissals ENABLE ROW LEVEL SECURITY;
CREATE POLICY dismissals_dono ON contact_link_dismissals FOR ALL TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
GRANT SELECT, INSERT, DELETE ON contact_link_dismissals TO omni_app;

-- Empresas do Prisma com este domínio de e-mail (só para quem vê dados comerciais).
CREATE FUNCTION app.empresas_prisma_do_dominio(p_dominio text)
  RETURNS TABLE (company_id text, company_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.name FROM prisma_companies c
     WHERE app.ve_comercial() AND c.deleted_at IS NULL
       AND lower(p_dominio) = ANY (SELECT lower(d) FROM unnest(c.email_domains) d)
  $$;
REVOKE ALL ON FUNCTION app.empresas_prisma_do_dominio(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.empresas_prisma_do_dominio(text) TO omni_app;
