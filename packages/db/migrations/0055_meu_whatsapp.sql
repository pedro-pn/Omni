-- "Conectar meu WhatsApp" na página Conversas (12/11/2026): quem ainda não tem um
-- número no Omni cria o próprio, já como responsável, e lê o QR code ali mesmo,
-- sem depender da Administração. Só quem já tem perfil no Omni; um número por vez
-- (se já existir um número ativo da pessoa, devolve o mesmo). A Administração
-- continua vendo e podendo remover o número (sem ler as conversas, 0054).

CREATE FUNCTION app.criar_meu_whatsapp(p_instancia text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_person uuid := app.current_person_id(); v_id uuid; v_nome text;
  BEGIN
    IF v_person IS NULL THEN RAISE EXCEPTION 'Sem pessoa na sessão'; END IF;
    IF NOT EXISTS (SELECT 1 FROM person_profiles WHERE person_id = v_person) THEN
      RAISE EXCEPTION 'Pessoa sem perfil no Omni';
    END IF;
    -- Duas abas ao mesmo tempo não criam dois números.
    PERFORM pg_advisory_xact_lock(hashtext('meu-whatsapp:' || v_person::text));
    SELECT id INTO v_id FROM whatsapp_numbers
     WHERE owner_person_id = v_person AND status <> 'removido'
     ORDER BY (status = 'conectado') DESC, created_at DESC LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
    SELECT display_name INTO v_nome FROM people WHERE id = v_person;
    INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, created_by)
    VALUES (p_instancia, left('WhatsApp de ' || btrim(v_nome), 80), 'outro', v_person, v_person)
    RETURNING id INTO v_id;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_person, 'whatsapp.numero_criado_pela_pessoa', 'whatsapp_number', v_id::text, '{}'::jsonb);
    RETURN v_id;
  END $$;
REVOKE ALL ON FUNCTION app.criar_meu_whatsapp(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.criar_meu_whatsapp(text) TO omni_app;
