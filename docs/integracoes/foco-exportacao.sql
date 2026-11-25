-- Exportação do Foco para o Omni (migração, Fase 3). Para o desenvolvedor do Foco
-- aplicar como migração no Lovable. SÓ LEITURA: a função não altera nada.
--
-- Por quê: no Lovable Cloud a chave de serviço do Supabase não fica disponível. O Omni
-- lê pela API pública do Supabase (a mesma chave publicável do front do Foco), chamando
-- esta função com um segredo no cabeçalho `x-omni-token`. Sem o segredo válido, nada sai.
--
-- Depois do corte: drop function public.omni_exportar(text); drop table public.omni_export_tokens;

create table if not exists public.omni_export_tokens (
  token_hash bytea primary key,
  expires_at timestamptz not null
);
alter table public.omni_export_tokens enable row level security;
-- Sem políticas e sem privilégios: ninguém lê esta tabela pela API.
revoke all on public.omni_export_tokens from anon, authenticated;

create or replace function public.omni_exportar(p_tabela text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := coalesce(current_setting('request.headers', true)::json ->> 'x-omni-token', '');
  v_saida jsonb;
begin
  if length(v_token) < 32 or not exists (
    select 1 from public.omni_export_tokens
     where token_hash = extensions.digest(v_token, 'sha256') and expires_at > now()
  ) then
    raise exception 'não autorizado' using errcode = '42501';
  end if;

  -- Usuários do login: só id e e-mail.
  if p_tabela = 'auth.users' then
    select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email)), '[]'::jsonb) into v_saida from auth.users u;
    return v_saida;
  end if;

  -- Tabelas sem destino no Omni: só a contagem (nada do conteúdo).
  if p_tabela in ('workspaces', 'folders', 'project_preferences', 'project_notification_preferences', 'notifications',
                  'invitations', 'access_requests', 'project_departures', 'google_calendar_connections', 'google_calendar_events') then
    if to_regclass('public.' || p_tabela) is null then return null; end if;
    execute format('select jsonb_build_object(''total'', count(*)) from public.%I', p_tabela) into v_saida;
    return v_saida;
  end if;

  -- Tabelas que migram: as linhas inteiras (como a API REST devolveria), sem as fotos de perfil.
  if p_tabela not in ('members', 'workspace_members', 'projects', 'project_members', 'pending_project_members', 'sections',
                      'tasks', 'comments', 'comment_mentions', 'comment_reactions', 'activity_log', 'attachments',
                      'saved_filters', 'api_keys', 'prisma_authorization_grants', 'apple_calendar_feeds',
                      'user_notification_settings', 'project_messages', 'project_message_mentions') then
    raise exception 'tabela não permitida' using errcode = '42501';
  end if;
  if to_regclass('public.' || p_tabela) is null then return null; end if;
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t) - ''avatar_data_url'' - ''avatar_object_key''), ''[]''::jsonb) from public.%I t',
    p_tabela
  ) into v_saida;
  return v_saida;
end $$;

revoke all on function public.omni_exportar(text) from public;
grant execute on function public.omni_exportar(text) to anon;

-- O segredo (não vai nesta migração): gere um valor aleatório (ex.: `openssl rand -hex 32`),
-- mande ao Omni por canal privado e registre SÓ o hash, com validade (rode no SQL do Lovable):
--
--   insert into public.omni_export_tokens (token_hash, expires_at)
--   values (extensions.digest('<o segredo>', 'sha256'), now() + interval '30 days');
--
-- Para cortar o acesso antes: delete from public.omni_export_tokens;
