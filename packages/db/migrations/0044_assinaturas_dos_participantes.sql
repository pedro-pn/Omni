-- Nome, cargo, empresa e telefone pela assinatura do e-mail (participantes da
-- missão; autorizado em 10/11/2026). Uma linha por remetente externo; o worker
-- grava (só os campos extraídos, nunca o texto do e-mail). A tela lê pela função
-- app.assinaturas_da_missao: só quem vê os e-mails E o Interno da missão.

CREATE TABLE email_signature_extractions (
  address       text PRIMARY KEY CHECK (address = lower(address) AND address LIKE '%@%'),
  nome          text,
  cargo         text,
  empresa       text,
  telefone      text,
  message_id    uuid REFERENCES mail_messages(id) ON DELETE SET NULL,
  status        text NOT NULL CHECK (status IN ('ok', 'sem_assinatura', 'erro')),
  attempts      integer NOT NULL DEFAULT 1,
  model         text,
  extracted_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON email_signature_extractions TO omni_worker;
ALTER TABLE email_signature_extractions ENABLE ROW LEVEL SECURITY;
CREATE POLICY signatures_worker ON email_signature_extractions FOR ALL TO omni_worker USING (true) WITH CHECK (true);

CREATE FUNCTION app.assinaturas_da_missao(p_mission uuid)
  RETURNS TABLE (endereco text, nome text, cargo text, empresa text, telefone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT s.address, s.nome, s.cargo, s.empresa, s.telefone
      FROM email_signature_extractions s
     WHERE s.status = 'ok'
       AND app.ve_emails() AND app.ve_interno(p_mission, app.current_person_id())
       AND EXISTS (SELECT 1 FROM mail_messages m JOIN mail_message_missions l ON l.message_id = m.id
                    WHERE l.mission_id = p_mission AND lower(m.from_address) = s.address)
  $$;
REVOKE ALL ON FUNCTION app.assinaturas_da_missao(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assinaturas_da_missao(uuid) TO omni_app;
