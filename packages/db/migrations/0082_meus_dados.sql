-- Direito de acesso do titular (LGPD art. 18, II; E15): quem usa o Omni baixa os próprios dados em
-- Meu perfil → Meus dados (/api/meus-dados). Só a pessoa da sessão (app.current_person_id); nada de
-- outra pessoa. Ficam de fora segredos (hash de token e de chave, chave das gravações, endereço do
-- aparelho para notificações, token do Prisma) e o que é de terceiros ou mora em outro sistema:
-- conversas do WhatsApp (o histórico está no próprio aparelho e no Omni para o dono), e-mails
-- (Microsoft 365) e mensagens dos canais escritas por outras pessoas. O pedido fica na auditoria.
-- Clientes e outros titulares de fora pedem ao encarregado (docs/producao/titular.md).

CREATE FUNCTION app.meus_dados() RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  eu uuid := app.current_person_id();
  r jsonb;
BEGIN
  IF eu IS NULL THEN
    RAISE EXCEPTION 'Entre no Omni para baixar os seus dados.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id) VALUES (eu, 'dados.exportados', 'pessoa', eu::text);

  SELECT jsonb_build_object(
    'gerado_em', now(),
    'sobre', 'Dados que o Omni guarda sobre você (LGPD, art. 18). Dúvidas, correções ou outros pedidos: privacidade@filtrovali.com.br.',
    'pessoa', (SELECT to_jsonb(p) - 'id' FROM people p WHERE p.id = eu),
    'perfis', (SELECT coalesce(jsonb_agg(jsonb_build_object('perfil', profile, 'desde', granted_at) ORDER BY profile), '[]') FROM person_profiles WHERE person_id = eu),
    'funcoes', (SELECT coalesce(jsonb_agg(to_jsonb(f) - 'id' - 'person_id' - 'created_by' ORDER BY f.starts_on), '[]') FROM function_assignments f WHERE f.person_id = eu),
    'termos_aceitos', (SELECT coalesce(jsonb_agg(to_jsonb(t) - 'person_id' ORDER BY t.aceito_em), '[]') FROM terms_acceptances t WHERE t.person_id = eu),
    'sessoes', (SELECT coalesce(jsonb_agg(to_jsonb(s) - 'token_hash' - 'person_id' ORDER BY s.created_at DESC), '[]') FROM sessions s WHERE s.person_id = eu),
    'aparelhos_com_notificacao', (SELECT coalesce(jsonb_agg(jsonb_build_object('navegador', user_agent, 'desde', created_at, 'ultimo_envio', last_ok_at) ORDER BY created_at), '[]') FROM push_subscriptions WHERE person_id = eu),
    'preferencias', jsonb_build_object(
      'notificacoes', (SELECT to_jsonb(x) - 'person_id' FROM push_preferences x WHERE x.person_id = eu),
      'emails', (SELECT to_jsonb(x) - 'person_id' FROM email_preferences x WHERE x.person_id = eu),
      'assinatura_de_email', (SELECT signature FROM email_signatures WHERE person_id = eu)
    ),
    'chaves_de_api', (SELECT coalesce(jsonb_agg(to_jsonb(k) - 'key_hash' - 'person_id' - 'foco_id' ORDER BY k.created_at), '[]') FROM api_keys k WHERE k.person_id = eu),
    'conexao_prisma', (SELECT jsonb_build_object('ambiente', environment, 'escopos', scopes, 'expira_em', expires_at, 'desde', created_at) FROM prisma_credentials WHERE person_id = eu),
    'tarefas', (SELECT coalesce(jsonb_agg(to_jsonb(t) - 'foco_id' ORDER BY t.created_at), '[]') FROM tasks t
                 WHERE eu IN (t.owner_person_id, t.assignee_person_id, t.created_by)),
    'comentarios_em_tarefas', (SELECT coalesce(jsonb_agg(jsonb_build_object('tarefa', task_id, 'texto', body, 'em', created_at, 'editado_em', edited_at) ORDER BY created_at), '[]') FROM task_comments WHERE author_person_id = eu),
    'mensagens_nos_canais', (SELECT coalesce(jsonb_agg(jsonb_build_object('missao', m.code, 'canal', mm.channel, 'texto', mm.body, 'em', mm.created_at) ORDER BY mm.created_at), '[]')
                              FROM mission_messages mm JOIN missions m ON m.id = mm.mission_id WHERE mm.author_person_id = eu),
    'avisos', (SELECT coalesce(jsonb_agg(jsonb_build_object('tipo', kind, 'titulo', title, 'texto', body, 'em', created_at, 'lido_em', read_at) ORDER BY created_at DESC), '[]') FROM notifications WHERE person_id = eu),
    'emails_enviados_pelo_omni', (SELECT coalesce(jsonb_agg(to_jsonb(o) - 'person_id' ORDER BY o.created_at), '[]') FROM mail_outbox o WHERE o.person_id = eu),
    'emails_abertos_no_omni', (SELECT coalesce(jsonb_agg(jsonb_build_object('assunto', mm.subject, 'de', mm.from_address, 'aberto_em', v.viewed_at) ORDER BY v.viewed_at), '[]')
                                FROM mail_message_views v JOIN mail_messages mm ON mm.id = v.message_id WHERE v.person_id = eu),
    'whatsapp_numeros', (SELECT coalesce(jsonb_agg(jsonb_build_object('nome', label, 'telefone', phone, 'perfil', profile_name, 'situacao', status, 'desde', created_at) ORDER BY created_at), '[]') FROM whatsapp_numbers WHERE owner_person_id = eu),
    'whatsapp_enviados_pelo_omni', (SELECT coalesce(jsonb_agg(to_jsonb(o) - 'person_id' - 'chat_id' ORDER BY o.created_at), '[]') FROM whatsapp_outbox o WHERE o.person_id = eu),
    'ligacoes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'contato', peer, 'direcao', direction, 'inicio', started_at, 'fim', ended_at, 'gravada', recording,
                    'resumo', summary, 'transcricao', transcript, 'excluida_em', deleted_at, 'vence_em', expires_at) ORDER BY created_at), '[]')
                  FROM whatsapp_calls WHERE owner_person_id = eu),
    'pastas_pessoais', (SELECT coalesce(jsonb_agg(jsonb_build_object('tipo', tipo, 'nome', nome) ORDER BY ordem), '[]') FROM pastas_pessoais WHERE person_id = eu),
    'alertas_de_risco', (SELECT coalesce(jsonb_agg(jsonb_build_object('tipo', kind, 'motivo', reason, 'em', created_at, 'visto_em', reviewed_at) ORDER BY created_at), '[]') FROM risk_alerts WHERE person_id = eu),
    'auditoria', (SELECT coalesce(jsonb_agg(jsonb_build_object('acao', action, 'tipo', entity_type, 'em', at) ORDER BY at), '[]') FROM audit_log WHERE actor_person_id = eu)
  ) INTO r;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.meus_dados() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.meus_dados() TO omni_app;
