-- 0033 · Chamadas: aviso de chamada perdida (sino e celular).
-- O endpoint de eventos do motor de voz chama app.avisar_chamada_perdida quando
-- uma chamada recebida termina sem ter sido atendida; o aviso vai só para o dono
-- da linha, com o nome do contato quando a conversa existe.

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('tarefa_atribuida', 'tarefa_concluida', 'tarefa_comentario', 'tarefa_lembrete', 'tarefa_mencao',
                  'ia_alerta', 'ia_pergunta', 'teste_push', 'chamada_perdida'));

CREATE FUNCTION app.avisar_chamada_perdida(p_number uuid, p_owner uuid, p_record text) RETURNS boolean
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH c AS (
      SELECT c.id, c.peer, c.owner_person_id,
             (SELECT ch.name FROM whatsapp_chats ch
               WHERE ch.number_id = c.number_id AND NOT ch.is_group
                 AND (ch.phone = c.peer OR ch.jid = c.peer || '@s.whatsapp.net') AND ch.name IS NOT NULL
               LIMIT 1) AS nome
        FROM whatsapp_calls c
       WHERE c.number_id = p_number AND c.owner_person_id = p_owner AND c.recording_id = p_record
         AND c.direction = 'entrada' AND c.ended_at IS NOT NULL AND c.started_at IS NULL
    ), ins AS (
      INSERT INTO notifications (person_id, kind, title, body, dedupe_key)
      SELECT owner_person_id, 'chamada_perdida', 'Chamada perdida',
             coalesce(nome, '+' || peer), 'chamada_perdida:' || id
        FROM c
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM ins)
  $$;
GRANT EXECUTE ON FUNCTION app.avisar_chamada_perdida(uuid, uuid, text) TO omni_app;
