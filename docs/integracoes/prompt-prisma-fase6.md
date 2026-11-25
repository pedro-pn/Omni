# Prompt para o Claude Code no Prisma CRM — produção da API do Omni e ajustes da Fase 6

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `crm-filtrovali`.
> Escrito em 10/11/2026, sobre o contrato `docs/prisma-omni.md` 1.66.1 (produto 1.82.4).

---

## Contexto

O Omni (`../omni`) já consome a API do Omni no **sandbox**:
- a credencial `reader` lê empresas, oportunidades, missões, eventos e pastas do SharePoint;
- a autorização individual por PKCE (cliente `omni`) funciona com os callbacks cadastrados.

Agora o Omni vai usar a **Fase 6**:
1. **Participantes da missão:** o Omni detecta quem do cliente aparece nos e-mails e no WhatsApp da missão, com nome, e-mail, telefone e cargo. Esses contatos devem ir para o Prisma, ligados à empresa e marcados como participantes da missão. Terceiros (hotel, transportadora, fornecedores) ficam só no Omni.
2. **Feedback com um clique:** uma ligação (com o resumo da IA), um e-mail ou uma reunião vira feedback no Prisma, individual ou em lote, em nome de quem clicou.
3. **Bloco "No Prisma" no contato:** ao abrir uma conversa ou um participante, o Omni mostra o contato no Prisma, a empresa, as oportunidades abertas e os últimos feedbacks.

**Boa parte já existe no contrato:**
- `POST …/contacts/upsert`;
- `POST …/missions/{id}/participants`;
- `POST …/feedback`;
- `POST …/batch`.

Este pedido é para **ligar a produção** e fechar as lacunas abaixo.

**Regras:**
- Siga o `AGENTS.md`:
  - branch curta a partir de `main` e PR, sem force-push;
  - migrations aplicadas uma a uma com `infra/database/apply-migration.py`;
  - teto de uso do banco: `SET LOCAL statement_timeout`, nada de função por linha em varredura de coleção e `EXPLAIN` antes de varrer coleção inteira;
  - nota em `demo/releases/pending/`.
- **Mudanças só aditivas no contrato.** Suba a versão em `docs/prisma-omni.md` (sugestão: 1.67.0) e atualize o OpenAPI (`server/omni-api-docs.mjs`) e os testes (`tests/omni-*.test.mjs`).
- Se algo for inviável ou exigir decisão de produto, pare e me explique a alternativa.

## Pedido

### 1. Desempenho antes de ligar a produção

A pesquisa no código encontrou varreduras que não cabem no teto de uso do banco com o volume real:
- `omni_rows` monta a projeção de **todos** os contatos chamando `contact_canonical` por linha (`supabase/migrations/20261028140000_omni_integration.sql`, ~175-178).
- Os filtros `email`, `phone` e `companyId` são aplicados **depois** da projeção, com um LATERAL por linha em `omni_events` (`20261028141000_omni_api.sql`, ~77-93).
- `contacts/upsert` varre todos os contatos e faz um laço por telefone (`20261028142000_omni_writes.sql`, ~113-124).

Corrija para filtrar antes de projetar, com índices onde precisar (e-mail e telefone normalizados, `companyId`, `updated_at`). Meça com `EXPLAIN` e com uma cópia de volume real, como pede a precondição do contrato ("medir paginação/captura sob volume real").

### 2. Ligar o ambiente `production` (depois do item 1)

- **Script de habilitação de produção,** com revisão. Hoje só existe `work/omni-release/enable-sandbox.sql`, e ele aborta de propósito se a produção já estiver ligada. O script deve:
  - fazer `UPDATE drax_app.omni_environments SET enabled = true WHERE tenant_id = 'filtrovali' AND environment = 'production'`;
  - gravar a linha de auditoria com `executed_by = 'system'`.
- **Credencial `reader` de produção:**
  - gere com `node scripts/prepare-omni-credentials.mjs --environment production` (o segredo fica em `~/.secrets`; só o hash vai ao banco);
  - me diga como recebo o segredo por canal privado, porque ele vai no `.env.production` do Omni e nunca em chat.
- **Callback de produção:** confirme `https://omni.filtrovali.com.br/integracoes/prisma/retorno`, sem mudar os do sandbox.
- **Feed de eventos:** documente que ele começa no momento da habilitação. O Omni faz a carga completa paginada e depois segue pelo `highWatermark`, como no sandbox.
- **Não habilite sozinho.** Prepare tudo, rode no sandbox e me diga os comandos e a ordem para eu executar ou autorizar na VPS.

### 3. "Quem é este e-mail ou telefone" numa chamada só

Para o bloco "No Prisma", hoje o Omni precisaria de quatro ou mais leituras, cada uma varrendo uma coleção. Peço:

- **Busca de identidade para a credencial `reader`:** `GET …/contacts/lookup?email=` ou `?phone=` (E.164), devolvendo:
  - o contato (`id`, `canonicalId`, `name`, `title`, `emails`, `phones`, `ownerId`);
  - a empresa (`id`, `name`);
  - as oportunidades abertas (`id`, `title`, `stageId`, `ownerId`, `missionId`);
  - os **últimos N feedbacks** desse contato e das oportunidades dele, do mais novo para o mais antigo, com data real, canal e autor.
  - Vários candidatos: devolva todos, com um indicador de ambiguidade, sem escolher um.
- **`GET …/feedback`:** aceitar ordem por data (`sort=-occurredAt`) e `limit`. Hoje a ordem é pelo ID (`native:<uuid>`).
- **Telefones sem código do país:** os telefones gravados sem DDI hoje somem de `phones` e não são achados por `?phone=+55…`. Normalize para E.164 na projeção quando der (Brasil por padrão) e documente a regra.

### 4. Participantes da missão

- **Tirar um participante:** hoje não há como desfazer o vínculo feito pelo Omni. Crie uma operação para isso (por exemplo `POST …/missions/{id}/participants/{contactId}/remove`, também no `batch`), com auditoria e o evento `missions.participant_unlinked`.
- **Participantes no próprio Prisma:** o que o Omni vincula vai para `drax_app.omni_mission_participants`, que **não aparece em nenhuma tela do Prisma**. Mostre esses participantes na missão e nas pessoas da oportunidade, com a origem "Omni".
- **Origem dos contatos criados pelo Omni:** hoje `contacts/upsert` cria contato com `origin='Manual'`. Marque a origem como "Omni" (ou uma tag), para o comercial saber de onde veio.
- **Correção na projeção das oportunidades:** os `stakeholders` são projetados como `s->'role'` no singular (`20261028140000_omni_integration.sql`, ~138-140), mas o campo nativo é `roles[]`, então `role` volta sempre `null`. Projete `roles`.
- **Pergunta, sem implementar:** um contato do cliente que já está ligado a outra empresa recebe hoje `409 company_conflict`. Qual seria o caminho certo para o Omni nesse caso (ligar à empresa adicional em `companyIds`? pedir revisão no Prisma?)?

### 5. Feedback

- **Endereço de staging aceito no sandbox:** `sourceUrl` só aceita `https://omni.filtrovali.com.br/…`, inclusive no sandbox, e com isso o staging (`https://omnistaging.filtrovali.com.br/…`) é recusado. Aceite o staging **só no sandbox**.
- **Contato positivo com canal e data reais:** com `positiveContact`, o registro em `commercial_contacts` sai com `channel='other'` e `occurred_at=now()`. Use o canal do `source` (`whatsapp`, `email`, `call` virando `phone`, `meeting`) e o `occurredAt` enviados pelo Omni.
- **Sem mudança nisto:** a autoria continua sendo a da pessoa do token PKCE (regra do `AGENTS.md` para feedback feito por pessoas).

## Ao terminar

Responda com:
1. o que mudou, com a versão nova do contrato e os arquivos principais;
2. os resultados de `node --test tests/omni-api.test.mjs tests/omni-integration-sql.test.mjs`, `pnpm typecheck:demo`, `pnpm test:demo` e `VITE_PRISMA_HOSTING=vps pnpm build`;
3. as medições do item 1 (`EXPLAIN` e tempos antes e depois);
4. o passo a passo para ligar a produção, item 2: o que eu executo, em que ordem, e como recebo o segredo;
5. a resposta da pergunta do item 4.
