-- Cada pessoa adiciona e administra o próprio WhatsApp (decisão de 12/11/2026):
-- conecta em Conversas (0055) e cuida dele em Meu WhatsApp (histórico, reconfigurar,
-- desconectar, remover). A Administração não tem nada a ver com os números das
-- pessoas: deixa de ler, criar, alterar e remover números, membros e pedidos de
-- histórico. (A permissão de gravar ligações é da pessoa e continua com a
-- Administração, em Pessoas: whatsapp_call_permissions, 0032.)

DROP POLICY wa_numbers_admin ON whatsapp_numbers;
DROP POLICY wa_members_admin ON whatsapp_number_members;
DROP POLICY wa_imports_admin ON whatsapp_history_imports;

-- Histórico: o dono pede e acompanha a importação dos grupos do próprio número.
CREATE POLICY wa_imports_dono ON whatsapp_history_imports FOR ALL TO omni_app
  USING (EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = number_id AND n.owner_person_id = app.current_person_id()))
  WITH CHECK (requested_by = app.current_person_id()
              AND EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = number_id AND n.owner_person_id = app.current_person_id() AND n.status <> 'removido'));

-- Remover o próprio número. As conversas já recebidas ficam (só para o dono).
CREATE FUNCTION app.whatsapp_remover_numero(p_number uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_person uuid := app.current_person_id(); v_n whatsapp_numbers;
  BEGIN
    SELECT * INTO v_n FROM whatsapp_numbers WHERE id = p_number AND status <> 'removido' FOR UPDATE;
    IF v_n.id IS NULL OR v_person IS NULL OR v_n.owner_person_id IS DISTINCT FROM v_person THEN RETURN false; END IF;
    UPDATE whatsapp_numbers SET status = 'removido', status_at = now() WHERE id = p_number;
    INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
    VALUES (v_person, 'whatsapp.numero_removido', 'whatsapp_number', p_number::text, jsonb_build_object('rotulo', v_n.label));
    RETURN true;
  END $$;

-- Limpar o aviso de erro depois de reconfigurar (só o dono).
CREATE FUNCTION app.whatsapp_limpar_erro(p_number uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    UPDATE whatsapp_numbers SET last_error = NULL
     WHERE id = p_number AND owner_person_id = app.current_person_id() AND status <> 'removido'
  $$;

REVOKE ALL ON FUNCTION app.whatsapp_remover_numero(uuid), app.whatsapp_limpar_erro(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_remover_numero(uuid), app.whatsapp_limpar_erro(uuid) TO omni_app;
