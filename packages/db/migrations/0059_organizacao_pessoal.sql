-- Organização pessoal das listas de Missões e Conversas (12/11/2026): cada pessoa
-- cria as próprias pastas, põe itens nelas e arquiva o que não quer ver. Vale só
-- para ela (não muda a lista de ninguém nem o acesso aos itens).

CREATE TABLE pastas_pessoais (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tipo       text NOT NULL CHECK (tipo IN ('missao', 'conversa')),
  nome       text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 60),
  ordem      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (person_id, tipo, nome),
  UNIQUE (id, person_id, tipo)
);

CREATE TABLE organizacao_pessoal (
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  tipo         text NOT NULL CHECK (tipo IN ('missao', 'conversa')),
  item_id      uuid NOT NULL,
  pasta_id     uuid,
  arquivado_em timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, tipo, item_id),
  -- A pasta é da mesma pessoa e do mesmo tipo; apagada a pasta, o item fica sem pasta.
  FOREIGN KEY (pasta_id, person_id, tipo) REFERENCES pastas_pessoais (id, person_id, tipo) ON DELETE SET NULL (pasta_id)
);

ALTER TABLE pastas_pessoais ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizacao_pessoal ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON pastas_pessoais, organizacao_pessoal TO omni_app;
CREATE POLICY pastas_proprias ON pastas_pessoais FOR ALL TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
CREATE POLICY organizacao_propria ON organizacao_pessoal FOR ALL TO omni_app
  USING (person_id = app.current_person_id()) WITH CHECK (person_id = app.current_person_id());
