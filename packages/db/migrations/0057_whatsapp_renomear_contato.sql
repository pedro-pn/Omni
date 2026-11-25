-- Contato sem nome no WhatsApp (12/11/2026): quando nem a agenda sincronizada pela
-- Evolution nem o perfil da pessoa trazem um nome, o dono do número dá um nome ao
-- contato no Omni. O nome dado vale só para este número e não é sobrescrito pela
-- sincronização (que só preenche conversas sem nome). Só conversas com pessoas.
CREATE FUNCTION app.whatsapp_renomear_contato(p_chat uuid, p_nome text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  DECLARE v_nome text := left(btrim(coalesce(p_nome, '')), 120);
  BEGIN
    IF length(v_nome) < 1 THEN RETURN false; END IF;
    UPDATE whatsapp_chats c SET name = v_nome
      FROM whatsapp_numbers n
     WHERE c.id = p_chat AND n.id = c.number_id AND NOT c.is_group
       AND n.owner_person_id = app.current_person_id() AND n.status <> 'removido';
    RETURN FOUND;
  END $$;
REVOKE ALL ON FUNCTION app.whatsapp_renomear_contato(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.whatsapp_renomear_contato(uuid, text) TO omni_app;
