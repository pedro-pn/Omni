-- WhatsApp: as conversas de um número são só do responsável (decisão de 12/11/2026).
-- Antes: o responsável, as pessoas que a Administração incluísse e a diretoria.
-- Agora ninguém mais vê as conversas de outra pessoa: nem a Administração (que só
-- cadastra e pareia), nem a diretoria, nem pessoas incluídas. Os grupos ligados a
-- uma missão continuam visíveis na aba WhatsApp da missão para quem vê o Interno
-- (regra própria, 0028–0029).

CREATE OR REPLACE FUNCTION app.ve_numero_whatsapp(p_number uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM whatsapp_numbers n WHERE n.id = p_number AND n.owner_person_id = app.current_person_id())
  $$;

-- Avisos no celular das mensagens recebidas: só o responsável.
CREATE OR REPLACE FUNCTION app.destinatarios_whatsapp(p_chat uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT n.owner_person_id FROM whatsapp_chats c JOIN whatsapp_numbers n ON n.id = c.number_id
     WHERE c.id = p_chat AND n.owner_person_id IS NOT NULL AND n.status <> 'removido'
  $$;

-- A lista de pessoas incluídas deixa de existir na prática: apaga as inclusões e
-- tira da tela a permissão de incluir (a tabela fica, vazia, para o histórico do schema).
INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id, metadata)
SELECT NULL, 'whatsapp.membros_removidos', 'whatsapp_number', number_id::text, jsonb_build_object('pessoas', count(*), 'motivo', 'só o responsável vê as conversas')
  FROM whatsapp_number_members GROUP BY number_id;
DELETE FROM whatsapp_number_members;
REVOKE INSERT ON whatsapp_number_members FROM omni_app;
