# Entrada em produção — o que não pode ser esquecido

> **Comece pelo `guia-producao.md`** (tudo o que configurar, na ordem, com as variáveis). Este arquivo guarda os detalhes do corte do Foco.
> Ler antes de publicar o Omni e, de novo, antes do corte do Foco. **Como fazer o deploy (staging e produção, comandos):** `deploy.md`.
> Criado em 29/10/2026. Atualize este arquivo sempre que surgir um item novo.

## 1. Publicar o Omni (`omni.filtrovali.com.br`)

- [ ] DNS de `omni.filtrovali.com.br` apontando para a VPS; bloco `omni.filtrovali.com.br` de `deploy/caddy/omni.caddy` no Caddyfile do proxy compartilhado (`filtroAPP-main/deploy/infra-proxy`).
- [ ] `deploy/.env.production` (fora do Git):
  - `NODE_ENV=production`, `APP_ORIGIN=https://omni.filtrovali.com.br`, `AUTH_SECRET` novo;
  - `AUTH_DEV_LOGIN` **desligado** (a validação do ambiente recusa em produção);
  - token do filtroAPP **"Omni – produção"** (`writeMode` `LIVE`) com os mesmos escopos do token de desenvolvimento — lista oficial em `docs/integracoes/filtroapp-token.md` — e `FILTROAPP_ESCRITA=real` só depois de conferir os escopos de escrita (`qualidade.registros.create` e, quando houver, `logistica.descargas.create`);
  - Prisma em `production` (`PRISMA_OMNI_ENVIRONMENT`), depois da homologação.
- [ ] Entra (app "Omni"): URI de redirecionamento de produção `https://omni.filtrovali.com.br/auth/callback`.
- [ ] Worker rodando (sincronizações, IA, desvios e o job `tarefas-lembretes`, que roda a cada minuto).
- [ ] Definir em Administração → Funções quem ocupa Qualidade, Medição, Faturamento, Gerente comercial e Coordenação de mobilização (as pessoas fictícias `@omni.invalid` são só do desenvolvimento).

## 2. Corte do Foco: `foco.filtrovali.com.br` passa a ser servido pelo Omni

O Prisma e as automações chamam o Foco **de servidor para servidor** (o Prisma, de dentro do banco, pela extensão `http`). O Omni já atende os mesmos caminhos com o mesmo contrato (`apps/web/src/server/api-v1.ts`, `autorizacao-prisma.ts`). No dia do corte, o domínio do Foco precisa chegar ao Omni **sem mudar nada no Prisma**.

### Como configurar o Caddy (bloco pronto, comentado, em `deploy/caddy/omni.caddy`)

| Caminho | O que fazer | Por quê |
|---|---|---|
| `/api/v1/*` e `/api/prisma-authorization/*` | **proxy** (`reverse_proxy` para o Omni) | Chamadas de servidor: um redirecionamento quebra o `POST` do token (vira `GET`) e o Prisma não segue redirecionamento |
| todo o resto (`/?integracao=prisma…`, `/?task=ID`, telas) | **redirecionar 308** para `https://omni.filtrovali.com.br{uri}` | São telas no navegador. **Não usar proxy aqui:** o login guardaria o cookie do fluxo Microsoft em `foco.filtrovali.com.br`, mas a Microsoft devolve para `omni.filtrovali.com.br/auth/callback` — o cookie se perde e o login falha. Com o 308, o caminho e os parâmetros chegam inteiros ao Omni |

### Antes do corte

- [ ] **Dados migrados** (PLANEJAMENTO.md §3.3): as tarefas com **o mesmo id do Foco** (o Prisma guarda vínculo tarefa ↔ oportunidade pelo id) e as chaves de API pelo hash (mesmo SHA-256 — as chaves `foco_live_…` continuam valendo). Importar com os triggers de histórico e de avisos desligados. **Importador pronto:** `npm run foco:importar` (ensaio e carga real), passo a passo em `migracao-foco.md`.
- [ ] Ver para onde o DNS de `foco.filtrovali.com.br` aponta hoje (o Foco está no Lovable/Supabase) e **baixar o TTL** um ou dois dias antes.
- [ ] **Feeds de agenda Apple** (`/api/calendar/apple/feed/<id>.<assinatura>.ics`, assinados nos celulares): o Omni tem o mesmo endereço e a mesma assinatura (migration 0041, `apps/web/src/server/agenda.ts`). Para os links do Foco continuarem: (1) `APPLE_CALENDAR_SIGNING_KEY` = a mesma chave do Foco (a `APPLE_CALENDAR_SIGNING_KEY` dele, ou a `SUPABASE_SERVICE_ROLE_KEY` se ele não tinha a própria); (2) na migração, copiar `apple_calendar_feeds` para `calendar_feeds` com o **mesmo id**, a pessoa casada pelo e-mail, `signed_subject` = `user_id` do Foco e `signed_created` = `created_at` **exatamente como a API do Supabase devolve** (é o texto que foi assinado); (3) o bloco do Caddy de `foco.filtrovali.com.br` repassa `/api/calendar/apple/feed/*` ao Omni (sem redirecionar: nem todo app de agenda segue 308). Os eventos mantêm o UID `foco-<id>@filtrovali.com.br` (as tarefas mantêm o id): sem eventos em dobro.
- [ ] **Logo dos e-mails já enviados** (`/filtrovali-email-logo.png`): servir o arquivo no Omni (pasta `public/`) para não quebrar a imagem dos e-mails antigos.
- [ ] Google Agenda: cada pessoa conecta de novo no Omni (o Foco guardava a conexão no Supabase). Enquanto a integração com o Google não existir no Omni, dá para assinar o link da agenda (.ics) no Google Agenda por URL (atualiza mais devagar).

### No dia do corte

1. Foco em **somente leitura**; carga final do delta.
2. DNS de `foco.filtrovali.com.br` para a VPS e bloco do Caddy ativado (o Caddy emite o certificado assim que o DNS responde).
3. Conferir:
   - `curl https://foco.filtrovali.com.br/api/v1/health` → `{"service":"omni-tarefas"…}`;
   - no Prisma, "Atualizar atividades" de uma pessoa conectada;
   - abrir um link antigo `https://foco.filtrovali.com.br/?task=<id>` → abre a tarefa no Omni.
4. Desligar os agendamentos do Supabase que chamam `foco.filtrovali.com.br/api/internal/*` (lembretes, resumos semanais, guia de uso, avisos por e-mail) — no Omni isso é do worker.
5. Comunicado ao time; Foco em somente leitura por 30 dias (PLANEJAMENTO.md §3.4).

## E-mails da missão (Fase 4)

- [ ] Comunicado ao time e ROPA feitos (`docs/producao/lgpd-ropa-dpa.md`) **antes** de cadastrar as caixas de produção.
- [ ] Cadastrar as caixas em **Administração → Caixas de e-mail** e no grupo do Exchange "Omni - Caixas" (as duas coisas).
- [ ] `EMAIL_ENVIO=real` no `deploy/.env.production` (fora da produção a validação recusa). Primeiro envio real: de uma caixa liberada para um endereço interno, conferindo nos Enviados do Outlook e o registro em `mail_outbox` (status `enviado`).
- [ ] Avisos das tarefas por e-mail e resumo semanal: criar a caixa remetente (ex.: `omni@filtrovali.com.br`), pôr no grupo do Exchange "Omni - Caixas" e em `EMAIL_AVISOS_REMETENTE`. Conferir em `notification_emails` (status `enviado`) e na caixa de um colaborador. Sem a caixa, os avisos ficam em ensaio. Avisar o time antes do corte do Foco (os e-mails do Foco param).

## WhatsApp (Fase 7)

- [ ] Gerar `WHATSAPP_EVOLUTION_KEY`, `WHATSAPP_WEBHOOK_SECRET` e `EVOLUTION_POSTGRES_PASSWORD` no `.env.production` (valores diferentes, sem imprimir) e subir com `--profile whatsapp` (`docs/integracoes/whatsapp-evolution.md`).
- [ ] Conferir que nenhuma porta da Evolution do Omni está publicada e que ela é separada da do Prisma.
- [ ] Inventário dos números: cada número em um sistema só (Prisma ou Omni), responsável por aparelho, quem vê as conversas.
- [ ] `WHATSAPP_ENVIO=real` só depois do comunicado ao time (LGPD).

## Alertas da IA e notificações no celular

- [ ] `IA_ALERTAS=ligada` (web e worker) com `OPENAI_API_KEY` da organização com retenção zero, depois do comunicado ao time (LGPD).
- [ ] Gerar as chaves VAPID **de produção** (`npx web-push generate-vapid-keys`) e pôr `WEB_PUSH_PUBLIC_KEY`/`WEB_PUSH_PRIVATE_KEY` no `.env.production` (nunca reaproveitar as de desenvolvimento). Trocar as chaves depois invalida as inscrições: cada pessoa ativa de novo.
- [ ] Conferir em um Android (Chrome) e em um iPhone (Safari, Omni instalado na Tela de Início): instalar, ativar notificações, "Enviar notificação de teste".

