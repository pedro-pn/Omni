# Omni

Conversas, missões e tarefas da Filtrovali numa tela só: WhatsApp, Outlook, SharePoint, Teams,
Prisma CRM e tarefas, com Missões que têm os canais Interno e Gerencial e uma IA que acompanha o
ciclo de cada missão.

O Omni é a camada de comunicação e IA. A verdade de cada assunto fica no sistema dono dele:
missões, RDOs, qualidade e custos no **filtroAPP**; oportunidades, contatos e o número da missão no
**Prisma CRM**. O Omni lê e escreve pelas APIs deles, sem duplicar.

## Onde está cada coisa

| Quero… | Leia |
|---|---|
| Entender o produto e as regras de negócio | [INSTRUCOES.md](INSTRUCOES.md) e o protótipo (`npm run abrir`) |
| O plano, a stack e as fases | [PLANEJAMENTO.md](PLANEJAMENTO.md) |
| Mexer no código (estado atual, regras, onde fica cada função) | [CLAUDE.md](CLAUDE.md) |
| Entender um termo (RDO, Interno, RLS, `@lid`…) | [docs/glossario.md](docs/glossario.md) |
| Saber o que cada variável de ambiente faz | [docs/variaveis.md](docs/variaveis.md) |
| Ver as decisões de arquitetura | [docs/adr/](docs/adr/) |
| Configurar uma integração (Microsoft, filtroAPP, Prisma, WhatsApp) | [docs/integracoes/](docs/integracoes/) |
| Publicar, operar ou recuperar a produção | [docs/producao/](docs/producao/) (abaixo) |
| Ver o plano de maturidade (E01 a E23) | [docs/entregas.md](docs/entregas.md) |
| Relatar uma falha de segurança | [SECURITY.md](SECURITY.md) |

## Como funciona

```
 navegador (PWA) ──HTTPS──▶ Caddy ──▶ web (TanStack Start)  ──┐
                                       telas, server functions │
                                       /api, /auth, SSE        │  RLS por pessoa
                                                               ▼
 filtroAPP · Prisma · Microsoft Graph ◀── worker (pg-boss) ──▶ Postgres 16
 OpenAI · Evolution (WhatsApp)            jobs agendados         migrations SQL
                                          avisos e Web Push      papéis sem BYPASSRLS
```

- **Permissão no banco.** O web e o worker usam papéis sem BYPASSRLS; cada consulta da tela roda com
  a pessoa da sessão (`withPerson`), e o Postgres decide o que ela vê.
- **Nada sai por engano.** Toda integração que escreve para fora tem modo de ensaio, e o modo real é
  recusado fora da produção.
- **Dados pessoais:** retenção por tipo, exportação pelo titular, máscara nos logs e o registro de
  incidentes (`docs/producao/`).

## Estrutura

```
apps/web               telas, server functions, rotas /api e /auth (TanStack Start; o nitro gera .output/)
apps/worker            jobs do pg-boss: sincronizações, IA, e-mails, avisos, retenção, saúde
packages/core          regras puras e testadas (calendário útil, etapas, IA, limites, incidentes…)
packages/integrations  clientes do filtroAPP, Prisma, Graph, OpenAI, WhatsApp e da cifra das gravações
packages/db            migrations SQL (fonte da verdade, com RLS), schema Drizzle, testes no Postgres real
deploy/                compose da produção e do staging, Caddy, papéis do Postgres, backup, logs, publicar.sh
e2e/                   bateria ponta a ponta (Playwright), roda no CI
experiments/           serviço de voz das chamadas do WhatsApp
prototipo/             especificação visual e funcional (HTML puro, dados fictícios)
docs/                  ADRs, integrações, produção, glossário, variáveis e entregas
```

## Rodar localmente

Pré-requisitos: Node 24 e Docker.

```bash
cp .env.example .env            # troque AUTH_SECRET por um valor aleatório (openssl rand -hex 32)
npm install
npm run db:up && npm run db:migrate
npm run db:seed-dev -- seu.email@filtrovali.com.br "Seu Nome"   # dá admin e diretoria (só dev)
npm run dev                     # http://localhost:3000 → "Entrar sem Microsoft"
npm run dev:worker              # em outro terminal, para os jobs
```

Sem nenhuma integração configurada, o Omni abre e funciona com o que está no banco. Cada
integração liga com as variáveis dela ([docs/variaveis.md](docs/variaveis.md)) e o passo a passo em
[docs/integracoes/](docs/integracoes/).

### Comandos

| Comando | Faz |
|---|---|
| `npm run dev` / `npm run dev:worker` | Web e worker em desenvolvimento. |
| `npm test` | Vitest: regras, banco (RLS no Postgres real) e worker. |
| `npm run build` e `npm run typecheck` | Build de produção; o typecheck do web precisa do build (gera as rotas). |
| `npm run e2e` | Ponta a ponta com `npm run dev` no ar. |
| `npm run db:up` / `db:down` / `db:migrate` | Postgres de desenvolvimento (porta 5433) e migrations. |
| `npm run db:ficticios` | Pessoas fictícias para as funções vagas (só dev). |
| `npm run whatsapp:up` | Evolution local para testar o WhatsApp. |
| `npm run carga` | Teste de carga das consultas pesadas (`docs/producao/carga.md`). |
| `npm run ia:avaliar` | Avalia as instruções da IA no modelo (obrigatório ao mudar um prompt). |
| `npm run abrir` / `npm run testar` | Protótipo em http://localhost:4321 e os testes dele. |
| `npm run chamada:poc` | Prova local das chamadas do WhatsApp ([instruções](experiments/whatsapp-chamada/README.md)). |
| `npm run foco:importar` | Migração dos dados do Foco (`docs/producao/migracao-foco.md`). |

## Contribuir

- Uma mudança por PR a partir da `master`; só squash; o CI (testes, typecheck, build, auditoria de
  dependências e ponta a ponta) precisa estar verde.
- Tabela nova: RLS, políticas explícitas e teste. Função nova no esquema `app`: `GRANT EXECUTE`
  explícito. Migration aplicada não se edita: crie a próxima.
- Interface em português do Brasil, frases curtas, verbos de ação nos botões.
- **O repositório é público:** nenhum dado real (nomes, e-mails, telefones, clientes, IDs do
  tenant) e nenhum segredo. Use dados fictícios (`@omni.invalid`).
- Tela nova importante ganha passo em `e2e/omni.e2e.ts`; variável nova entra em
  `docs/variaveis.md` (o teste confere).

## Produção

Uma VPS com Docker rootless, atrás do Caddy compartilhado. Produção em `omni.filtrovali.com.br` e
staging em `omnistaging.filtrovali.com.br`, cada um com pasta, banco e `.env` próprios.

| Assunto | Documento |
|---|---|
| Tudo o que configurar, na ordem | [guia-producao.md](docs/producao/guia-producao.md) |
| Publicar e voltar versão (`deploy/publicar.sh`), staging | [deploy.md](docs/producao/deploy.md) |
| Backup no B2 e ensaio de restauração | [backup.md](docs/producao/backup.md) |
| Logs no Grafana e painel de saúde | [logs.md](docs/producao/logs.md) |
| Desempenho e consultas lentas | [desempenho.md](docs/producao/desempenho.md) |
| Incidentes: conter, comunicar, registrar | [incidentes.md](docs/producao/incidentes.md) |
| Rotas públicas e o que fica fechado | [rotas-publicas.md](docs/producao/rotas-publicas.md) |
| LGPD: retenção, titular, RIPD, registro de operações | [retencao.md](docs/producao/retencao.md), [titular.md](docs/producao/titular.md), [ripd.md](docs/producao/ripd.md), [lgpd-ropa-dpa.md](docs/producao/lgpd-ropa-dpa.md) |
| Entrada em produção e corte do Foco | [entrada-em-producao.md](docs/producao/entrada-em-producao.md), [migracao-foco.md](docs/producao/migracao-foco.md) |
