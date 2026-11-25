-- E-mail como no Outlook (24/11/2026).
--   1. Lido/não lido: a pessoa marca na própria caixa (Graph, função "Application
--      Mail.ReadWrite" do Exchange) e o Omni atualiza o cabeçalho guardado (mail_items,
--      0067) — só a coluna is_read e só dos e-mails dela.
--   2. Aviso imediato de e-mail novo: o Graph avisa o Omni (assinatura por caixa, na
--      Entrada) e o worker lê a caixa na hora, em vez de esperar a leitura de 5 min.
--      O segredo de cada assinatura (clientState) fica só como SHA-256; o webhook
--      público confere por app.graph_aviso_email e só acorda o worker.

GRANT UPDATE (is_read) ON mail_items TO omni_app;
CREATE POLICY mail_items_dono_lido ON mail_items FOR UPDATE TO omni_app
  USING (owner_person_id = app.current_person_id()) WITH CHECK (owner_person_id = app.current_person_id());

CREATE TABLE graph_subscriptions (
  id               text PRIMARY KEY CHECK (id ~ '^[0-9a-f-]{36}$'),
  mailbox_id       uuid NOT NULL UNIQUE REFERENCES mail_mailboxes(id) ON DELETE CASCADE,
  secret_sha256    bytea NOT NULL CHECK (length(secret_sha256) = 32),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_notified_at timestamptz
);
ALTER TABLE graph_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY graph_subscriptions_worker ON graph_subscriptions FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON graph_subscriptions TO omni_worker;

-- Chamado pelo webhook (sem pessoa): confere a assinatura e o segredo e acorda o worker.
CREATE FUNCTION app.graph_aviso_email(p_assinatura text, p_segredo text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_caixa uuid;
  BEGIN
    IF p_assinatura IS NULL OR p_segredo IS NULL OR length(p_segredo) > 200 THEN RETURN false; END IF;
    UPDATE graph_subscriptions SET last_notified_at = now()
     WHERE id = p_assinatura AND secret_sha256 = sha256(convert_to(p_segredo, 'UTF8')) AND expires_at > now() - interval '1 hour'
    RETURNING mailbox_id INTO v_caixa;
    IF v_caixa IS NULL THEN RETURN false; END IF;
    PERFORM pg_notify('omni_graph_email', v_caixa::text);
    RETURN true;
  END $$;
REVOKE ALL ON FUNCTION app.graph_aviso_email(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.graph_aviso_email(text, text) TO omni_app;
