# Pedido ao desenvolvedor do Foco: migração para o Omni e corte

> **Respondido em 24/11/2026** (chaves por canal privado). O importador lê pela API do Supabase com a chave de serviço, então o papel só leitura e a liberação de IP deixaram de ser necessários. IP da VPS para o DNS: `<IP da VPS>`. Passo a passo: `docs/producao/migracao-foco.md`.

> Escrito em 12/11/2026. O Foco será absorvido pelo Omni (módulo Tarefas). O Omni já atende os mesmos endereços (`/api/v1`, autorização do Prisma, feeds de agenda) com o mesmo contrato; falta trazer os dados e combinar o corte. **Segredos (senhas, chaves, connection strings) só por canal privado — nunca por chat, e-mail comum ou Git.**

## O que precisamos

### 1. Leitura do banco do Foco (Supabase)
- Um **papel só leitura** no Postgres do Supabase, com `SELECT` em todas as tabelas de `public` e, em `auth.users`, só `id`, `email` e `created_at`, e a **connection string** dele (pelo pooler, se for o caso).
- Se o Supabase restringe por IP: liberar o IP da VPS da Filtrovali.
- Alternativa, se não der para abrir leitura: `pg_dump --data-only` de `public` (e `auth.users` só com aquelas colunas), gerado no dia do ensaio e de novo no dia do corte.

Tabelas que o Omni vai importar (com o **mesmo id**: o Prisma guarda o vínculo tarefa ↔ oportunidade pelo id da tarefa):
`tasks`, `projects`, `sections`, `project_members`, `pending_project_members`, `comments`, `comment_mentions`, `comment_reactions`, `activity_log`, `attachments`, `saved_filters`, `api_keys`, `apple_calendar_feeds`, `prisma_authorization_grants`, `user_notification_settings`, `project_notification_preferences`, `project_preferences`, `members`, `workspaces`, `workspace_members`, `folders`.

### 2. Anexos (Storage `foco-attachments`)
- Leitura do bucket `foco-attachments` (chave de serviço ou URLs assinadas), **ou** um pacote com os arquivos e a lista `caminho;tamanho;sha256`.
- O Omni copia para o SharePoint (site OmniAnexos) e confere cada arquivo pelo hash.

### 3. Chaves e formatos (para nada quebrar no corte)
- **Chave de assinatura dos feeds de agenda Apple**: o valor de `APPLE_CALENDAR_SIGNING_KEY` do Foco, ou confirmação de que a assinatura usava a `SUPABASE_SERVICE_ROLE_KEY`. Os links já assinados nos celulares só continuam valendo com a mesma chave.
- **Chaves de API (`foco_live_…`)**: confirmar como o hash é gravado em `api_keys` (o Omni espera SHA-256 do token inteiro, em hexadecimal). Com o mesmo hash, as chaves continuam valendo e ninguém precisa gerar outra.
- **Autorização do Prisma** (`prisma_authorization_codes` / `prisma_authorization_grants`): como os tokens entregues ao Prisma são gravados e validados (hash? qual?), para o Prisma continuar conectado depois do corte, sem reconectar ninguém.

### 4. O que roda sozinho hoje
- Lista dos **agendamentos** e funções que serão desligados no corte: `cron` `foco-due-reminders`, `foco-weekly-overdue`, `foco-weekly-upcoming`, os que chamam `foco.filtrovali.com.br/api/internal/*` (lembretes, resumos semanais, guia de uso, avisos por e-mail) e qualquer Edge Function agendada. No Omni, isso passa a ser do worker.
- Quem mais chama a API do Foco além do Prisma (automações, planilhas, scripts), para avisar os donos.

### 5. Tabelas sem destino no Omni
`project_messages`, `project_message_mentions`, `google_calendar_connections`, `google_calendar_events`, `google_calendar_oauth_states`, `notifications`, `invitations`, `access_requests`, `project_departures`, `weekly_overdue_deliveries`, `weekly_upcoming_deliveries`, `foco_runtime.*`:
- dizer quais estão **em uso de verdade** (principalmente `project_messages`: há conversas nos projetos que o time precisa manter?);
- as que não forem migradas entram só na **exportação final arquivada** (item 7). A conexão com o Google Agenda não migra: cada pessoa conecta de novo no Omni ou assina o link .ics.

### 6. Domínio e somente leitura
- **Onde está o DNS de `foco.filtrovali.com.br`** (domínio personalizado no Lovable?) e quem altera. **Baixar o TTL** para 5 min um ou dois dias antes do corte.
- Como deixar o Foco em **somente leitura** no dia do corte (sem criar nem alterar tarefas), mantendo a consulta por 30 dias.

### 7. Combinar
- **Congelamento**: nenhuma mudança de estrutura no banco do Foco do ensaio até o corte (ou avisar antes).
- **Ensaio**: uma carga completa num ambiente de teste do Omni, com conferência de contagens por tabela e por pessoa.
- **Dia e hora do corte**: Foco em somente leitura → carga final do que mudou → DNS para o Omni → desligar os agendamentos do item 4.
- **Depois de 30 dias**: exportação final completa (banco + anexos) arquivada pela Filtrovali; revogar chaves; encerrar o Supabase e o Lovable.

## O que fica do lado do Omni (já pronto ou feito por nós)
- Mesmos endereços: `/api/v1/*`, `/api/prisma-authorization/*`, `/?task=<id>`, `/?integracao=prisma…`, `/api/calendar/apple/feed/*` (o Caddy repassa ao Omni; telas redirecionam com 308).
- Importação com os gatilhos de histórico e de avisos desligados (sem "Criou a tarefa" nem avisos em massa) e o histórico do Foco preservado.
- Pessoas casadas pelo e-mail Microsoft, com relatório de quem não casou.
- Logo dos e-mails antigos (`/filtrovali-email-logo.png`) servido pelo Omni.
- Checklist do corte: `docs/producao/entrada-em-producao.md` §2.
