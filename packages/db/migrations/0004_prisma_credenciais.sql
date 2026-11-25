-- 0004 · Credenciais individuais do Prisma CRM (Authorization Code + PKCE).
--
-- Cada pessoa autoriza o Omni no Prisma para escritas com a sua própria autoria
-- (feedback, contatos, participantes). O Prisma emite um token de 1 hora, sem
-- refresh (docs/prisma-omni.md do CRM). O token fica cifrado pelo web
-- (AES-256-GCM); o banco nunca vê o valor em claro. Cada pessoa só enxerga e
-- altera a própria linha.

CREATE TABLE prisma_credentials (
  person_id          uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  environment        text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  token_ciphertext   bytea NOT NULL,
  scopes             text[] NOT NULL,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER prisma_credentials_updated_at BEFORE UPDATE ON prisma_credentials
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON prisma_credentials TO omni_app;
ALTER TABLE prisma_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY prisma_credentials_own ON prisma_credentials FOR ALL TO omni_app
  USING (person_id = app.current_person_id())
  WITH CHECK (person_id = app.current_person_id());
-- Worker: sem acesso por enquanto (as escritas no Prisma partem da ação da pessoa).
