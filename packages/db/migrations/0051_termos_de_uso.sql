-- Termo de uso e privacidade (LGPD), aceito no primeiro acesso. O texto e a versão
-- ficam no código (packages/core/src/termos.ts); aqui fica a prova do aceite: quem,
-- qual versão, o SHA-256 do texto daquela versão, quando, de onde.
-- Enquanto a versão atual não for aceita, a sessão vale só para a página do termo
-- e para sair (app.sessao_com_termos): o resto do Omni não abre.

CREATE TABLE terms_acceptances (
  person_id    uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  versao       text NOT NULL CHECK (versao ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]+)?$'),
  texto_sha256 text NOT NULL CHECK (texto_sha256 ~ '^[0-9a-f]{64}$'),
  aceito_em    timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text CHECK (length(user_agent) <= 400),
  PRIMARY KEY (person_id, versao)
);
ALTER TABLE terms_acceptances ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON terms_acceptances TO omni_app;
-- Cada um vê os próprios aceites; a Administração e a diretoria veem todos (evidência da LGPD).
CREATE POLICY termos_ver ON terms_acceptances FOR SELECT TO omni_app
  USING (person_id = app.current_person_id() OR app.has_profile('admin') OR app.has_profile('diretoria'));
-- Ninguém grava direto: só por app.aceitar_termos, em nome da própria sessão.

CREATE FUNCTION app.aceitar_termos(p_versao text, p_sha256 text, p_ip inet, p_user_agent text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_person uuid := app.current_person_id(); v_nova boolean;
  BEGIN
    IF v_person IS NULL THEN RETURN false; END IF;
    INSERT INTO terms_acceptances (person_id, versao, texto_sha256, ip, user_agent)
    VALUES (v_person, p_versao, p_sha256, p_ip, left(p_user_agent, 400))
    ON CONFLICT (person_id, versao) DO NOTHING;
    GET DIAGNOSTICS v_nova = ROW_COUNT;
    IF v_nova THEN
      INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
      VALUES (v_person, 'termos.aceitos', 'person', v_person::text, jsonb_build_object('versao', p_versao, 'sha256', p_sha256));
    END IF;
    RETURN true;
  END $$;

-- Sessão + se falta aceitar a versão atual do termo (uma consulta por pedido).
CREATE FUNCTION app.sessao_com_termos(p_token_hash bytea, p_versao text)
  RETURNS TABLE (person_id uuid, termos_pendentes boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_person uuid := app.resolve_session(p_token_hash);
  BEGIN
    IF v_person IS NULL THEN RETURN; END IF;
    RETURN QUERY SELECT v_person, NOT EXISTS (SELECT 1 FROM terms_acceptances t WHERE t.person_id = v_person AND t.versao = p_versao);
  END $$;

REVOKE ALL ON FUNCTION app.aceitar_termos(text, text, inet, text), app.sessao_com_termos(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.aceitar_termos(text, text, inet, text), app.sessao_com_termos(bytea, text) TO omni_app;
