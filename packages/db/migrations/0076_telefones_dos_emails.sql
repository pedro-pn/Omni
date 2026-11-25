-- Telefones encontrados nos e-mails (24/11/2026; LGPD: termo 2026-11-24).
--   * A leitura das assinaturas (0044) passa a cobrir também os remetentes externos das
--     caixas pessoais, não só os dos e-mails das missões (mesmas travas: só o final do
--     e-mail mais recente, cada campo conferido no texto, nada do texto guardado).
--   * Telefones CITADOS no corpo do e-mail (sem a conversa citada) são achados no próprio
--     Omni, sem IA, e ficam aqui como sugestão — nunca vinculados sozinhos.
--   * A tela lê, por app.telefones_do_correspondente, o telefone da assinatura (inclusive
--     fixo, que não é vinculado sozinho), os citados e cargo/empresa — só de quem troca
--     e-mails com a pessoa (ou, para a gestão, remetentes dos e-mails das missões).

CREATE TABLE contact_phone_hints (
  address   text NOT NULL CHECK (address = lower(address)),
  phone     text NOT NULL CHECK (phone ~ '^\d{11,15}$'),
  origem    text NOT NULL DEFAULT 'corpo' CHECK (origem IN ('corpo')),
  found_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (address, phone)
);
ALTER TABLE contact_phone_hints ENABLE ROW LEVEL SECURITY;
CREATE POLICY contact_phone_hints_worker ON contact_phone_hints FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_phone_hints TO omni_worker;

CREATE FUNCTION app.telefones_do_correspondente(p_enderecos text[])
  RETURNS TABLE (endereco text, telefone text, origem text, nome text, cargo text, empresa text, quando timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH alvo AS (
      SELECT DISTINCT lower(e) AS endereco FROM unnest(p_enderecos) e
       WHERE EXISTS (SELECT 1 FROM mail_correspondents c WHERE c.owner_person_id = app.current_person_id() AND c.address = lower(e))
          OR (app.ve_emails() AND EXISTS (SELECT 1 FROM mail_messages m JOIN mail_message_missions l ON l.message_id = m.id WHERE lower(m.from_address) = lower(e)))
    )
    SELECT a.endereco, s.telefone, 'assinatura', s.nome, s.cargo, s.empresa, s.extracted_at
      FROM alvo a JOIN email_signature_extractions s ON s.address = a.endereco AND s.status = 'ok'
    UNION ALL
    SELECT a.endereco, h.phone, 'corpo', NULL, NULL, NULL, h.found_at
      FROM alvo a JOIN contact_phone_hints h ON h.address = a.endereco
  $$;
REVOKE ALL ON FUNCTION app.telefones_do_correspondente(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.telefones_do_correspondente(text[]) TO omni_app;
