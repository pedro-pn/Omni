# Mapa das variáveis de ambiente

Todas as variáveis que o Omni lê, quem lê e para quê. O teste
`apps/web/src/server/variaveis-doc.test.ts` falha se uma variável nova aparecer no código, nos
modelos de `.env` ou nos compose sem estar aqui, e também se uma linha daqui não existir mais.

**Onde ficam os valores**

| Ambiente | Arquivo | Modelo |
|---|---|---|
| Desenvolvimento | `.env` (raiz) | `.env.example` |
| Staging | `deploy/.env.staging` (em `~/apps/Omni-staging`) | `deploy/staging.env.example` |
| Produção | `deploy/.env.production` (em `~/apps/Omni`) | `deploy/production.env.example` |
| Agente de logs | `deploy/logs/.env` | `deploy/logs/logs.env.example` |
| Ponta a ponta no CI | `e2e/ambiente.env` (versionado, sem segredo real) | — |

**Regras**
- Segredo nunca vai para o repositório, que é público. Gere cada um com `openssl rand -hex 32`, um
  valor por ambiente.
- O web (`apps/web/src/server/env.ts`) e o worker (`apps/worker/src/env.ts`) validam com Zod na
  partida. Valor inválido derruba o processo com o **nome** da variável, nunca com o valor.
- O compose passa `""` para variável não definida, e isso vale como ausente.
- Fora da produção, os modos `real` de envio e escrita são recusados (ver `OMNI_AMBIENTE`).

Legenda da coluna **Quem**: W = web, K = worker, C = compose (Postgres, Evolution, serviço de
voz), S = scripts e testes. 🔒 = segredo.

## Ambiente e endereço

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `NODE_ENV` | W K S | `development` | `production` no build de produção (staging e produção). |
| `OMNI_AMBIENTE` | W K C | pelo `NODE_ENV` | `desenvolvimento`, `staging` ou `producao`. Fora de `producao`, envio de e-mail e WhatsApp, escrita no filtroAPP e Prisma de produção são recusados; `AUTH_DEV_LOGIN` é proibido em staging e produção. |
| `APP_ORIGIN` | W K C | worker: `https://omni.filtrovali.com.br` | Endereço público. Base dos links nos e-mails, origem aceita contra CSRF, retorno do login e dos avisos do Graph. `https` na produção. |
| `OMNI_WEB_PORT` | C | 8084 (produção) | Porta local do web para o Caddy. Staging: 8085. |
| `OMNI_AUDIO_PORT` | C | 8086 (produção) | Porta que só serve o áudio das chamadas (`/omni/audio`). Staging: 8087. |
| `OMNI_VERSAO` | W K C | `desconhecida` | Commit publicado. O `deploy/publicar.sh` passa no build; aparece em `/api/saude`, em Saúde e nos erros. |
| `TZ_EMPRESA` | K | `America/Sao_Paulo` | Fuso dos horários da empresa (janela útil da IA, lembretes). |
| `CSP_MODO` | W | `relatorio` | CSP das páginas (E12): `relatorio` só registra violações como erro do sistema; `aplicar` bloqueia. |

## Banco

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `DATABASE_URL_APP` | W | — (obrigatória) | Conexão do web com o papel `omni_app`, sujeito a RLS. |
| `DATABASE_URL_WORKER` | K | — (obrigatória) | Conexão do worker com o papel `omni_worker`, também sem BYPASSRLS. |
| `DATABASE_URL_OWNER` | S | — | Dono das tabelas: só migrations, seeds e scripts de desenvolvimento. |
| `POSTGRES_PASSWORD` 🔒 | C | — | Superusuário do Postgres do compose. |
| `OMNI_OWNER_PASSWORD` 🔒 | C | — | Senha do `omni_owner` (criada por `deploy/postgres/init/01-roles.sh`). |
| `OMNI_APP_PASSWORD` 🔒 | C | — | Senha do `omni_app`; o compose monta a `DATABASE_URL_APP`. |
| `OMNI_WORKER_PASSWORD` 🔒 | C | — | Senha do `omni_worker`; o compose monta a `DATABASE_URL_WORKER`. |
| `TEST_DATABASE_URL_OWNER` | S | `…/omni_test` | Banco dos testes (dono). |
| `TEST_DATABASE_URL_APP` | S | `…/omni_test` | Banco dos testes (`omni_app`). |
| `TEST_DATABASE_URL_WORKER` | S | `…/omni_test` | Banco dos testes (`omni_worker`). |

## Login

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `AUTH_SECRET` 🔒 | W C | — (mín. 32) | Cifra o cookie do fluxo de login, as credenciais do Prisma e assina os endereços das imagens dos e-mails. Trocar não encerra sessões (ver `incidentes.md`). |
| `AUTH_DEV_LOGIN` | W | `off` | `on` liga "Entrar sem Microsoft". Só desenvolvimento e CI; recusado em staging e produção. |
| `ENTRA_LOGIN_ENABLED` | W | `off` | Liga o login Microsoft. |
| `ENTRA_TENANT_ID` | W | — | Tenant (UUID). |
| `ENTRA_CLIENT_ID` | W K | — | App "Omni" do login. O worker lê quem está atribuído a ele (job `entra-pessoas`). |
| `ENTRA_CLIENT_SECRET` 🔒 | W | — | Segredo do app. Use este **ou** o certificado. |
| `ENTRA_PRIVATE_KEY_PATH` | W | — | Caminho da chave do certificado (dentro do contêiner). |
| `ENTRA_CERT_SHA256_THUMBPRINT` | W | — | Impressão SHA-256 do certificado. |

## Microsoft Graph e SharePoint

As quatro primeiras vão juntas, ou nenhuma. App "Omni – Integrações"
(`docs/integracoes/m365-registro.md`).

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `GRAPH_TENANT_ID` | W K | — | Tenant (UUID). |
| `GRAPH_CLIENT_ID` | W K | — | App de integrações (UUID). |
| `GRAPH_PRIVATE_KEY_PATH` | W K | — | Chave do certificado, montada de `OMNI_SECRETS_DIR`. |
| `GRAPH_CERT_SHA256_THUMBPRINT` | W K | — | Impressão SHA-256 do certificado. |
| `GRAPH_ANEXOS_DRIVE_ID` | W K | — | Biblioteca do site OmniAnexos: arquivos dos canais, anexos das tarefas e gravações. Não é segredo. |
| `OMNI_SECRETS_DIR` | C | `./secrets` (em `deploy/`) | Pasta da VPS com os certificados, montada só para leitura. |

## E-mail

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `EMAIL_ENVIO` | W K | `ensaio` | `desligado`, `ensaio` (monta e registra, não envia) ou `real` (só produção). |
| `EMAIL_AVISOS_REMETENTE` | W K | — | Caixa que envia avisos, resumos e links do login interno. Precisa estar no grupo "Omni - Caixas". |
| `EMAIL_AVISO_IMEDIATO` | K | `desligado` | `ligado`: assinaturas do Graph avisam e-mail novo na hora (precisa do `APP_ORIGIN` público). |

## filtroAPP e Prisma

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `FILTROAPP_API_URL` | W K | `https://app.filtrovali.com.br/api/integracoes/v1` | API de integrações do filtroAPP. |
| `FILTROAPP_API_TOKEN` 🔒 | W K | — | Token do Omni no filtroAPP. Escopos em `docs/integracoes/filtroapp-token.md`; um por ambiente. |
| `FILTROAPP_ESCRITA` | K | `desligada` | `desligada`, `simulada` (valida sem gravar) ou `real` (recusado fora da produção contra a produção do filtroAPP). |
| `PRISMA_BASE_URL` | W | `https://prismacrm.filtrovali.com.br` | Endereço do Prisma CRM. |
| `PRISMA_OMNI_ENVIRONMENT` | W K | `sandbox` | `sandbox` ou `production`. Fora da produção, só `sandbox`. |
| `PRISMA_OMNI_READER_TOKEN` 🔒 | W K | — | Credencial `reader` da aplicação (consulta e pastas). Escritas usam a conexão de cada pessoa. |

## IA (OpenAI)

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `OPENAI_API_KEY` 🔒 | W K | — | Chave da organização com retenção zero. |
| `OPENAI_MODEL` | W K | `gpt-6-luna` | Modelo de texto, escolhido pela avaliação (`npm run ia:avaliar`). |
| `OPENAI_TRANSCRICAO_MODEL` | K | `gpt-4o-transcribe` | Transcrição das ligações gravadas. |
| `IA_LEITURA_RDO` | K | `desligada` | Leitura diária dos RDOs pelo modelo. |
| `IA_RESUMO_REUNIAO` | K | `desligada` | Resumo das reuniões do Teams da missão. |
| `IA_RESUMO_CHAMADA` | K | `desligada` | Resumo das ligações gravadas, só quando o dono pede. |
| `IA_ASSINATURAS` | K | `desligada` | Cargo, empresa e telefone pela assinatura dos e-mails. |
| `IA_ALERTAS` | W K | `desligada` | Alertas pedidos à IA (`@IA`, `/alerta`). |
| `IA_TETO_TOKENS_DIA` | W K | 2000000 | Teto diário de tokens (E11). 0 desliga o critério. |
| `IA_TETO_CHAMADAS_DIA` | W K | 3000 | Teto diário de chamadas ao modelo. |

## WhatsApp e chamadas

As quatro `WHATSAPP_*` de conexão vão juntas, ou nenhuma (`docs/integracoes/whatsapp-evolution.md`).

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `WHATSAPP_EVOLUTION_URL` | W K | — | Evolution própria do Omni (rede interna na produção). |
| `WHATSAPP_EVOLUTION_KEY` 🔒 | W K C | — | Chave da API da Evolution (mín. 32). |
| `WHATSAPP_WEBHOOK_SECRET` 🔒 | W | — | Segredo do webhook, diferente da chave. O web o cadastra em cada número da Evolution. |
| `WHATSAPP_WEBHOOK_URL` | W | — | Para onde a Evolution manda os eventos (`http://web:3000/api/whatsapp/webhook` no compose). |
| `WHATSAPP_ENVIO` | W | `ensaio` | `desligado`, `ensaio` ou `real` (só produção). |
| `EVOLUTION_POSTGRES_PASSWORD` 🔒 | C | — | Banco próprio da Evolution. |
| `CHAMADAS_HABILITADAS` | W | `off` | Liga as chamadas pessoais do WhatsApp na tela. |
| `CHAMADAS_SERVICO_URL` | W K | — | Serviço de voz: `http://127.0.0.1:…` no desenvolvimento, `http://voz:8098` no compose. |
| `CHAMADAS_SERVICO_KEY` 🔒 | W K C | — | Chave entre o Omni e o serviço de voz. |
| `CHAMADA_PONTE_TOKEN` 🔒 | C | — | Chave entre o serviço de voz e a ponte na Evolution (diferente da anterior). |
| `CHAMADA_PONTE` | C | vazio = desligada | Liga a ponte das chamadas na Evolution. |
| `CHAMADA_MODO` | C | `producao` | `teste` (só `CHAMADA_NUMEROS_TESTE`, staging) ou `producao` (qualquer contato). |
| `CHAMADA_NUMEROS_TESTE` | C | — | Números liberados no modo `teste` (DDI+DDD+número, separados por vírgula). |
| `CHAMADA_LIMITE_SEGUNDOS` | C | 3600 | Duração máxima de uma ligação (até 14400). |
| `CHAMADA_RETENCAO_HORAS` | C | 43800 (5 anos) | Retenção das gravações no serviço de voz. |
| `CHAMADA_DIAGNOSTICO` | C | 0 | 1 registra por onde a chamada passou, sem áudio e com números mascarados. Só para investigar. |
| `GRAVACOES_CHAVE_MESTRA` 🔒 | W K | — | Chave que embrulha a chave de cada gravação (AES-256-GCM). **Perdê-la = perder as gravações**; cópia no cofre, nunca trocar sem migrar. |

## Notificações, agenda e operação

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `WEB_PUSH_PUBLIC_KEY` | W K | — | Chave VAPID pública (vai ao navegador). `npx web-push generate-vapid-keys`. |
| `WEB_PUSH_PRIVATE_KEY` 🔒 | K | — | Chave VAPID privada (só o worker envia). |
| `WEB_PUSH_SUBJECT` | K | `https://omni.filtrovali.com.br` | Contato exigido pelo Web Push (`https://` ou `mailto:`). |
| `APPLE_CALENDAR_SIGNING_KEY` 🔒 | W | — | Assina os links `.ics` da agenda. A mesma do Foco, para os links antigos valerem. |
| `OPERACAO_STATUS` | K | `desligado` | `ligado` (só produção): o worker lê o status do backup e do ensaio e avisa quem é admin. |
| `OPERACAO_STATUS_DIR` | K | `/ops-status` | Onde o status aparece dentro do contêiner. |
| `OPERACAO_STATUS_HOST_DIR` | C | `/home/omni/backups/omni-b2/status` | Pasta da VPS montada em `OPERACAO_STATUS_DIR`. |
| `RETENCAO` | K | `ensaio` | `desligada`, `ensaio` (só conta) ou `real` (apaga). `docs/producao/retencao.md`. |

As variáveis do backup e do ensaio de restauração (`B2_*`, `BACKUP_*`, `RESTORE_DRILL_*`) ficam
nos scripts `deploy/backup-prod.sh` e `deploy/restore-drill.sh` e estão em
`docs/producao/backup.md`.

## Agente de logs (`deploy/logs/.env`)

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `GRAFANA_LOGS_URL` | C | — | Endereço de envio do Loki (`…/loki/api/v1/push`). |
| `GRAFANA_LOGS_USER` | C | — | Usuário de logs do Grafana Cloud. |
| `GRAFANA_LOGS_TOKEN` 🔒 | C | — | Token só do Omni, com `logs:write`. |
| `LOGS_HOST` | C | `vps` | Rótulo `host` das linhas. |
| `OMNI_DOCKER_SOCK` | C | `/run/user/1003/docker.sock` | Socket do Docker rootless do `omni`, lido só pelo proxy. |

## Migração do Foco (só até o corte)

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `FOCO_SUPABASE_URL` | S | — | Supabase do Foco (só GET). |
| `FOCO_SUPABASE_SERVICE_ROLE_KEY` 🔒 | S | — | Chave de serviço do Foco. Apagar depois do corte. |
| `FOCO_SUPABASE_CHAVE_PUBLICA` | S | — | Sem a chave de serviço: chave publicável do front do Foco. |
| `FOCO_EXPORT_TOKEN` 🔒 | S | — | Segredo da função de exportação (`docs/integracoes/foco-exportacao.sql`). |
| `FOCO_ANEXOS_PASTA` | S | — | Pasta local do pacote de anexos exportado. |
| `FOCO_CHAVE_API_TESTE` 🔒 | S | — | Uma chave `foco_live_…` para conferir que continua valendo no Omni. |

## Testes, carga e CI

| Variável | Quem | Padrão | Para quê |
|---|---|---|---|
| `E2E_URL` | S | `http://localhost:3000` | Onde a bateria ponta a ponta roda. |
| `CARGA_PESSOAS` | S | 20 | `npm run carga`: pessoas ao mesmo tempo. |
| `CARGA_RODADAS` | S | 10 | Rodadas por pessoa. |
| `CARGA_LIMITE_P95_MS` | S | 500 | p95 máximo aceito. |
| `CARGA_MANTER` | S | — | 1 deixa os dados fictícios para `EXPLAIN`. |
| `CARGA_LIMPAR` | S | — | Apaga os dados fictícios de uma rodada (a etiqueta). |
| `CARGA_DETALHE` | S | — | Mostra as consultas acima de 1 s. |
| `CI` | S | — | Definida pelo GitHub Actions: sem banco de teste, os testes falham em vez de pular. |
