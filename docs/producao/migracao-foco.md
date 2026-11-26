# Migração do Foco para o Omni (Fase 3) — passo a passo

> Escrito em 24/11/2026, com as respostas do desenvolvedor do Foco ao `docs/integracoes/prompt-foco-migracao.md`.
> O corte do domínio está em `entrada-em-producao.md` §2; aqui ficam a carga dos dados e a conferência.

## Como funciona

`npm run foco:importar` (código em `apps/worker/src/foco/`):

- **Lê o Foco pela API do Supabase** com a `SUPABASE_SERVICE_ROLE_KEY`, **só com GET**: nada é escrito no Foco. Não precisa do papel só leitura nem de liberar IP. A API REST é também a fonte certa para os links de agenda, porque o Foco assina o `created_at` no formato que ela devolve.
- **Grava no Omni numa transação só**, com o **mesmo id** de cada linha (o Prisma liga tarefa ↔ oportunidade pelo id) e `foco_id`. Pode rodar quantas vezes quiser: a segunda carga atualiza; o que **sumiu do Foco** desde a anterior sai do Omni (só o que veio do Foco; o que foi criado no Omni fica).
- **Ensaio por padrão**: faz tudo, confere as contagens e desfaz. `--real` grava.
- Gatilhos de histórico e de avisos desligados durante a carga: ninguém recebe aviso em massa e o histórico é o do Foco. As tarefas ficam travadas para a tela por alguns segundos, enquanto a transação roda.
- **Anexos** (8): baixados do Storage, conferidos pelo tamanho e enviados ao SharePoint do Omni (`Tarefas/<tarefa>/<id>.<ext>`, site OmniAnexos) com o SHA-256 guardado. No ensaio, só baixa e confere.

| Foco | No Omni |
|---|---|
| projetos, membros (e convites pendentes de quem já tem conta), seções | projetos de tarefas; o grupo geral ganha todos como membros; número de missão no nome (4 dígitos) liga à missão |
| tarefas | mesmas tarefas; subtarefa de subtarefa fica sob a principal (o Omni tem um nível); sem data → data da criação; responsável vira membro do projeto |
| comentários, menções, reações | iguais (emoji que o Omni não tem fica de fora) |
| `activity_log` | histórico da tarefa |
| `attachments` | anexos da tarefa (migration 0077) |
| filtros salvos, preferências de e-mail | iguais (preferência já mudada no Omni vale mais) |
| `api_keys` ativas | mesmas chaves, pelo hash; a do Prisma (concessão) continua sendo a do Prisma |
| `apple_calendar_feeds` | mesmo link de agenda (mesmo id e mesmo texto assinado) |
| `project_messages` | só as conversas pedidas com `--conversa`: viram a tarefa "Conversa do projeto (Foco)" no projeto, com cada mensagem como comentário |
| pastas e subprojetos, avisos, convites, Google Agenda, metas e preferências de tela | não migram (o relatório conta); ficam na exportação final arquivada |

Pessoas: pelo e-mail do login do Foco. Quem não tem conta no Omni aparece no relatório; o que é só dela (caixa pessoal, comentários, filtros, chaves) não migra. Para entrar, a pessoa precisa estar em "Usuários e grupos" do app "Omni" no Entra (o job `entra-pessoas` cria a conta) e a carga é refeita.

## 1a. Sem a chave de serviço (Foco no Lovable Cloud) — o caminho atual

No Lovable Cloud a `SUPABASE_SERVICE_ROLE_KEY` não fica disponível. Em vez dela:

1. O desenvolvedor aplica `docs/integracoes/foco-exportacao.sql` como migração no Foco: a função `omni_exportar`, só leitura, protegida por um segredo com validade (só o hash fica no banco do Foco).
2. Ele gera o segredo (`openssl rand -hex 32`), registra o hash com validade de 30 dias (comando no fim do arquivo) e manda o segredo por canal privado.
3. Ele manda o pacote dos 8 anexos: os arquivos no caminho `object_key` de cada um e a lista `caminho;tamanho;sha256`.
4. No `deploy/.env.production`:
   ```
   FOCO_SUPABASE_URL=https://<projeto do Foco>.supabase.co
   FOCO_SUPABASE_CHAVE_PUBLICA=<a SUPABASE_PUBLISHABLE_KEY do Foco (a mesma do front; não é segredo)>
   FOCO_EXPORT_TOKEN=<o segredo da exportação>
   FOCO_ANEXOS_PASTA=/tmp/foco-anexos
   ```
   e tirar a `FOCO_SUPABASE_SERVICE_ROLE_KEY`. O pacote vai para a VPS e é copiado para o worker: `docker cp foco-anexos omni-worker-1:/tmp/foco-anexos`.
5. Seguir no passo 2 (ensaio). Os comandos são os mesmos; o relatório diz "leitura pela função de exportação".

Links de agenda: só continuam se o Foco tiver a `APPLE_CALENDAR_SIGNING_KEY` própria nos segredos do Lovable (confira com `--conferir-link`). Se ele assinava com a chave de serviço, os 2 links antigos não continuam e quem usa assina o link novo do Omni.

## 1. Com a chave de serviço

No `deploy/.env.production` da VPS (e no `.env` local, se for rodar o ensaio daqui). **Nunca no Git nem no chat:**

```
FOCO_SUPABASE_URL=https://<projeto do Foco>.supabase.co
FOCO_SUPABASE_SERVICE_ROLE_KEY=<a chave de serviço que o desenvolvedor passou>
FOCO_CHAVE_API_TESTE=<a chave foco_live_… que ele passou (opcional: o relatório confere se ela continua valendo)>
APPLE_CALENDAR_SIGNING_KEY=<a chave dos feeds que ele passou>
```

Depois: `docker compose … up -d worker web` (o web usa a `APPLE_CALENDAR_SIGNING_KEY`; o worker roda o importador).

**Qual chave assina os links de agenda?** Com um link de agenda real do Foco (Foco → Agenda → copiar o link):

```bash
docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec worker \
  node_modules/.bin/tsx apps/worker/src/foco/cli.ts --conferir-link 'https://foco.filtrovali.com.br/api/calendar/apple/feed/<id>.<assinatura>.ics'
```

Ele diz se é a `APPLE_CALENDAR_SIGNING_KEY` configurada ou a de serviço do Supabase (aí, use esse valor como `APPLE_CALENDAR_SIGNING_KEY`).

## 2. Ensaio (quantas vezes precisar)

```bash
docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec worker \
  node_modules/.bin/tsx apps/worker/src/foco/cli.ts --pular-chave "Chave codex" \
  --conversa "OKR - Bimestral" --conversa "Alinhamento trimestral" \
  --relatorio /tmp/foco-ensaio.md
docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec worker cat /tmp/foco-ensaio.md
```

O relatório tem e-mails: leia na VPS e não versione. Conferir:
- **Conferência no Omni**: cada linha "N de N" (sem ⚠️).
- **Pessoas sem conta no Omni**: liberar no Entra quem deve usar o Omni e rodar de novo.
- **Responsáveis sem conta**: tarefas que ficariam sem responsável.
- **Chaves que continuam valendo**: a "Automação Filtrovali" deve estar lá; a "Chave codex", não.
- **Avisos**: olhar os exemplos (ids do Foco) dos que parecerem estranhos.
- Volume esperado (12/11): 1.009 tarefas, 36 projetos, 8 anexos, 2 links de agenda, 1 concessão do Prisma.

## 3. Piloto (opcional)

Uma carga `--real` antes do corte deixa os dados no Omni para um grupo conferir (o Foco continua sendo a verdade). A carga do corte sobrescreve com o Foco e remove o que sumiu dele. O que for criado no Omni nesse meio-tempo fica, mas a edição feita no Omni numa tarefa que veio do Foco volta ao que está no Foco.

## 4. Dia do corte

1. Desenvolvedor do Foco: Foco em somente leitura e os **4 agendamentos do pg_cron desligados** (`foco-due-reminders`, `foco-usage-guide-email`, `foco-weekly-overdue`, `foco-weekly-upcoming`), senão sai e-mail em dobro. Revogar a "Chave codex" no Foco.
2. Carga final:
   ```bash
   docker compose … exec worker node_modules/.bin/tsx apps/worker/src/foco/cli.ts --real --pular-chave "Chave codex" \
     --conversa "OKR - Bimestral" --conversa "Alinhamento trimestral" --relatorio /tmp/foco-corte.md
   ```
   Saída 0 = conferência ok; 2 = alguma contagem ou anexo diferente (ver o relatório antes de seguir).
3. DNS (desenvolvedor, no Cloudflare): `foco` registro A de `<IP atual>` para **`<IP da VPS>`** (a VPS do Omni; TTL baixado para 5 min 1 a 2 dias antes). O plano de volta é o valor antigo.
4. Caddy e conferências: `entrada-em-producao.md` §2 (health, chave de API pelo domínio antigo, `/?task=<id>`, link de agenda).
5. Comunicado ao time; Foco em consulta por 30 dias.

## 5. Depois

- Tirar `FOCO_SUPABASE_URL`, `FOCO_SUPABASE_SERVICE_ROLE_KEY` e `FOCO_CHAVE_API_TESTE` do `.env.production` (a `APPLE_CALENDAR_SIGNING_KEY` fica).
- Quem tinha Google Agenda conectado no Foco (1 pessoa) assina o link .ics do Omni.
- "Automação Filtrovali": descobrir o que ela alimenta e acompanhar os pedidos dela em `/api/v1` no log do web nos primeiros dias.
- Depois de 30 dias: exportação final arquivada (banco + anexos), revogar as chaves do Supabase, encerrar Supabase e Lovable.
