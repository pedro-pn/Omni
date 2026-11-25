# Prompt para o Claude Code no filtroAPP — implementar a spec 034 (Omni fase 2)

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 28/10/2026. A spec `specs/034-api-omni-fase2/spec.md` já existe; este prompt fecha os contratos que ela deixou em aberto (FR-002 e "Dependencies and Assumptions") do ponto de vista do consumidor (Omni) e define a ordem.

---

## Contexto

O Omni (`../omni`) já consome a API de integrações: `/projetos`, `/projetos/responsaveis`, `/efetivo/projetos/status` (coleção), RDOs aprovados e Qualidade. A spec `specs/034-api-omni-fase2/spec.md` registrou a fase 2 como backlog. **Agora é para implementar a Entrega A.** A Entrega B fica para depois, como spec/plan, a menos que eu peça.

Antes de codar, leia `CLAUDE.md`, `docs/PADRAO_MODULO.md`, `docs/API_INTEGRACOES.md`, a spec 033 (entregue) e a 034. Siga as mesmas convenções da 033: catálogo de escopos, `operational-resources.js`, OpenAPI, playground, `docs/API_INTEGRACOES.md`, testes com `node --test`, `npm run architecture:check`. **Mudanças só aditivas**: o Prisma CRM também consome a API.

Atualize `plan.md`, `tasks.md` e `contracts/` da 034 com as decisões abaixo antes de implementar. Se alguma for inviável no filtroAPP, pare e me explique a alternativa antes de seguir.

## Entrega A — implementar agora (US1, US2, US3)

### A1. Feed de eventos — `GET /api/integracoes/v1/eventos` (US1, FR-001/FR-002)

**Formato decidido pelo consumidor:**

| Item | Decisão |
|---|---|
| Mecanismo | Feed com cursor (sem webhook nesta entrega) |
| Escopo | `eventos.read` **e** o escopo do recurso de cada evento: o token só recebe eventos de recursos que já pode ler |
| Origem | Gravado **na mesma transação** da mudança (tabela própria de eventos de integração; pode reaproveitar os triggers da `NotificationEvent`, mas não depender da leitura/dispensa de usuários) |
| Ordem | Sequência numérica crescente por banco; entrega "pelo menos uma vez"; o consumidor descarta duplicatas pelo `id` |
| Cursor | Opaco e assinado, como os demais cursores; sem `cursor` = início da janela de retenção |
| Retenção | Mínimo de **30 dias**. Cursor mais antigo que a retenção → `410` com `code: CURSOR_EXPIRED` (o Omni faz reconciliação completa e recomeça) |
| Página | `limit` 1–500, padrão 100; resposta no envelope atual (`items`, `page.nextCursor`, `page.hasMore`, `requestId`, `schemaVersion`) |
| Recorte | Respeitar o recorte de projetos do token; projeto fora do recorte não aparece nem em contagem |

**Item do feed** (só identificadores, nunca conteúdo):

```json
{
  "id": "evt_…",
  "type": "rdo.aprovado",
  "occurredAt": "2026-10-28T12:00:00.000Z",
  "projectId": "…",
  "projectCode": "5850",
  "resource": "rdo",
  "resourceId": "…"
}
```

**Tipos** (todos obrigatórios nesta entrega):

| `type` | Quando | Escopo do recurso exigido |
|---|---|---|
| `rdo.criado` | Relatório enviado (não rascunho) | `rdo.relatorios.todos.read` |
| `rdo.aprovado` | Status → APPROVED | `rdo.relatorios.read` ou `.todos.read` |
| `rdo.devolvido` | Status → RETURNED | `rdo.relatorios.todos.read` |
| `rdo.assinado` | Status → SIGNED | `rdo.relatorios.todos.read` |
| `workflow.etapa_alterada` | Mudança de `ProjectWorkflow.stage` | `efetivo.projetos.status.read` |
| `qualidade.criado` / `qualidade.alterado` | Registro de Qualidade criado/alterado (inclui exclusão lógica) | `qualidade.registros.read` |
| `romaneio.emitido` | Romaneio de saída emitido | `romaneios.itens.read` (se ainda bloqueado, o evento existe mas só sai quando o escopo for liberado) |
| `projeto.responsaveis_alterados` | Mudança de `leaderUserId`, `plannerUserId` ou `operatorId` | `projetos.responsaveis.read` |

Testes mínimos: cada tipo é emitido uma vez por mudança; retomada pelo cursor não perde nem inventa eventos; projeto fora do recorte não vaza; escopo do recurso ausente filtra o evento; cursor expirado → 410.

### A2. RDOs em todos os estados — escopo `rdo.relatorios.todos.read` (US2, FR-003)

- Mesmo endpoint `GET /rdo/relatorios`: com o escopo novo, inclui `PENDING`, `RETURNED`, `APPROVED` e `SIGNED` (nunca rascunhos), com filtro `status=` (um ou vários, separados por vírgula).
- Campos adicionais só com o escopo novo: `submittedAt`, `returnedAt`, `approvedAt`, `signedAt`, `clientReleasedAt`.
- **Sem** o escopo novo, o contrato atual (só aprovados) fica idêntico, sem campos novos.
- `updatedSince` precisa refletir as mudanças de status.

### A3. Abrir registro de Qualidade — `POST /qualidade/registros`, escopo `qualidade.registros.create` (US3, FR-004)

**Corpo:**

```json
{
  "type": "DESVIO",
  "projectCode": "5850",
  "eventDate": "2026-10-28",
  "description": "Mobilização adiada: equipe não chegou na data. Motivo informado: …",
  "impact": "MEDIO",
  "actionOwnerEmail": "qualidade@filtrovali.com.br",
  "externalRef": { "system": "omni", "url": "https://omni.filtrovali.com.br/…", "reference": "pergunta-ia-…" }
}
```

**Regras:**

| Item | Regra |
|---|---|
| Cabeçalho | `Idempotency-Key` (UUID) obrigatório. Mesma chave e mesmo corpo → mesma resposta, sem duplicar. Mesma chave com corpo diferente → `409` |
| `type` | `DESVIO`, `INCIDENTE` ou `RECLAMACAO_CLIENTE` |
| Projeto | `projectCode` ou `projectId`, dentro do recorte do token |
| Origem | `origin = OMNI` fixo; o filtroAPP não aceita outro valor vindo da API |
| Responsável | `actionOwnerEmail` resolve para um `User` ativo. Se não resolver → `422`. Gravar a FK nova e manter `actionOwner` (texto) preenchido para compatibilidade |
| Natureza | Se a validação atual exige natureza, criar em estado "a classificar" (ex.: `EM_TRIAGEM`) sem natureza, para a Qualidade classificar depois; documentar a escolha |
| Resposta | `201` com `id`, `number` (ex.: `D-012/26`), `status`, `createdAt` |
| Auditoria | Mesma trilha dos registros criados pela interface, com ator = credencial da API e origem OMNI |

Testes: idempotência (mesma chave), conflito (chave igual com corpo diferente), escopo ausente → 403, projeto fora do recorte → 404/403 sem efeito, e-mail sem usuário → 422, evento `qualidade.criado` emitido.

### Entrega A — saída esperada

- Escopos novos como `AVAILABLE`: `eventos.read`, `rdo.relatorios.todos.read`, `qualidade.registros.create`.
- Relatório final com: endpoints, exemplos de resposta fictícios, `schemaVersion`, decisões tomadas (natureza, retenção) e testes adicionados.

## Entrega B — depois (só atualizar a spec/plan agora)

- **US5** chegada/descarga + CT-e do Omie. O Omni vai usar nos fluxos de mobilização da IA (Fase 5 do Omni), logo depois da Entrega A.
- **US6** `projetos.condicoes.read` e **US7** escopos de Gestão. O Omni usa na Fase 9.
- **US8** vendedor, documentação, coordenação de mobilização e data de viagem.
- **US4 (feriados): não é necessária para o Omni.** O Omni já mantém o próprio calendário (nacionais calculados + municipais cadastrados na Administração). Implemente só se o filtroAPP quiser para uso próprio.
