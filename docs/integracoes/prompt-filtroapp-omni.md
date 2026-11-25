# Prompt para o Claude Code no filtroAPP — dados que o Omni precisa

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 28/10/2026 a partir do código do filtroAPP (`backend/src/lib/api-credentials/*`, `backend/prisma/schema.prisma`) e do teste real do token do Omni.

---

## Contexto

O **Omni** é um novo app da Filtrovali (repositório `../omni`). Ele junta conversas (WhatsApp, Outlook, Teams), tarefas e Missões, e tem uma IA que acompanha o ciclo de cada missão. O filtroAPP continua sendo a **fonte da verdade** da missão: workflow, RDO, qualidade, romaneio, efetivo e custos. O Omni só lê pela **API de integrações** (`/api/integracoes/v1`), com um token Bearer próprio.

O Omni já consome hoje: `projetos.read`, `efetivo.projetos.status.read`, `rdo.relatorios.read`, `rdo.servicos.read`, `rdo.equipe.read`, `rdo.assinaturas.read`, `qualidade.registros.read`, `qualidade.naturezas.read`, `qualidade.excluidos.read`, `colaboradores.operacional.read` e `clientes.segmentos.read`. Ele sincroniza a cada 30 minutos.

Faltam dados para o Omni montar os canais de cada missão e endereçar as pessoas certas. Implemente a **Parte 1** abaixo. A **Parte 2** é só para registrar como spec no backlog, sem implementar agora.

## Regras do projeto (siga as convenções existentes)

- Leia `CLAUDE.md`, `docs/PADRAO_MODULO.md` e `docs/API_INTEGRACOES.md` antes de começar.
- Crie uma spec no padrão spec-kit em `specs/0NN-api-omni-projetos/` (`spec.md`, `plan.md`, `tasks.md`, contratos).
- Siga o modelo dos recursos atuais:
  - `backend/src/lib/api-credentials/operational-resources.js` e `operational-resource-definition.js` (`resource(...)`);
  - `catalog.js` e `data-catalog.js` (escopos, sensibilidade, `status: 'AVAILABLE'`, `exposedFields`/`excludedFields`);
  - `efetivo-project-status.js` (projeção sob medida).
- **Mudanças só aditivas:** não remova nem renomeie campos existentes, porque o Prisma CRM também consome `/projetos` e o status. Se o envelope mudar, ajuste `schemaVersion` conforme a regra já usada.
- Respeite o recorte de projetos do token (`projectPolicy`), a paginação por cursor assinado, o `updatedSince` e os limites de cota.
- Atualize o contrato OpenAPI (`specs/015-api-token-playground/contracts/openapi.yaml` ou o contrato da spec nova), `docs/API_INTEGRACOES.md` e o playground (parâmetros e exemplos).
- Testes com `node --test` em `backend/test/`, no padrão dos testes da API de integrações. Cubra:
  - escopo ausente → 403;
  - recorte de projetos respeitado;
  - campos excluídos não aparecem;
  - paginação e `updatedSince`.
- Rode `npm run architecture:check`, os testes do backend e o lint antes de concluir.
- Não exponha senha, hash, tokens, PII além do pedido, nem textos livres de pendências.

## Parte 1 — implementar agora

### 1.1 `/projetos` (escopo `projetos.read`) — campos novos, aditivos

| Campo | Origem | Observação |
|---|---|---|
| `clientName` | `Project.clientName` | razão social do cliente (o `name` atual é o nome curto do projeto) |
| `clientCnpj` | `Project.clientCnpj` | 14 dígitos, só números |
| `commercialProposalCode` | `Project.commercialProposalCode` | número da proposta |
| `endDate` | `Project.endDate` | data |
| `includesSaturday` | `Project.includesSaturday` | regime de trabalho |
| `includesSunday` | `Project.includesSunday` | regime de trabalho |
| `workdayHours` | `Project.workdayHours` | jornada (texto "HH:MM") |
| `weekendWorkdayHours` | `Project.weekendWorkdayHours` | jornada de fim de semana |
| `executedAtHeadquarters` | `ProjectWorkflow.executedAtHeadquarters` | `null` sem workflow |

O Omni usa o regime para saber quando um RDO de sábado ou domingo está **fora do contratado**.

### 1.2 Novo recurso `GET /projetos/responsaveis` — escopo novo `projetos.responsaveis.read`

- **Sensibilidade:** `PERSONAL`.
- **`projectPolicy`:** o recorte do token.
- **Formato:** uma linha por projeto e papel, só para projetos não excluídos.

| Campo | Tipo | Origem |
|---|---|---|
| `projectId`, `projectCode` | string | `Project` |
| `role` | `LEADER` \| `PLANNER` \| `FIELD_OPERATOR` | ver abaixo |
| `userId` | string? | `User.id` (LEADER/PLANNER) ou o usuário ligado ao colaborador (FIELD_OPERATOR) |
| `collaboratorId` | string? | `Project.operatorId` (FIELD_OPERATOR) |
| `name` | string | `User.name` ou `Collaborator.name` |
| `email` | string? | `User.email` (**só** e-mail corporativo; `null` se não houver) |
| `updatedAt` | datetime | o maior entre `Project.updatedAt` e `ProjectWorkflow.updatedAt` |

**Mapeamento dos papéis:**
- `LEADER` = `ProjectWorkflow.leaderUserId`: Líder de Projetos. É o "planejador" que acompanha o projeto e confirma a descarga de equipamentos.
- `PLANNER` = `ProjectWorkflow.plannerUserId`: Gestor de Contrato.
- `FIELD_OPERATOR` = `Project.operatorId`: líder/operador de campo.

**Regras:**
- Aceitar `updatedSince`, `projectCode`/`projectId`, `limit`, `cursor` e `snapshotAt`.
- Projeto sem workflow devolve só `FIELD_OPERATOR`, se houver.
- **Não** expor telefone, CPF, `username`, papéis do hub nem dados de cliente.
- O Omni casa as pessoas pelo e-mail do Microsoft Entra. Por isso o `email` é o campo essencial.

### 1.3 Novo `GET /efetivo/projetos/status` (coleção) — mesmo escopo `efetivo.projetos.status.read`

Mesma projeção do `GET /efetivo/projetos/{id}/status` (`efetivo-project-status.js`), mas como **coleção paginada** (`items`, `page`, cursor). Mais estes campos:

| Campo novo | Origem |
|---|---|
| `commercialExpectedMobilizationDate` | `ProjectWorkflow` |
| `commercialExpectedStartDate` | `ProjectWorkflow` |
| `commercialExpectedDurationDays` | `ProjectWorkflow` |
| `actualMobilizationDate` | `ProjectWorkflow` |

**Por quê:** hoje o Omni faz uma chamada por projeto (42 ativos), o que consome quase todo o limite de 60 req/min a cada sincronização. A coleção resolve com 1 chamada.

**Regras:**
- Filtros `active`, `projectCode`/`projectId` e `stage`.
- Aceitar `updatedSince` só se houver um carimbo confiável que mude também quando o **avanço** muda. O `workflowVersion` não muda com o avanço dos RDOs; se não houver esse carimbo, não ofereça `updatedSince` e documente que a leitura é completa.
- O endpoint por id continua igual. **Não** expor pessoas, textos de pendências, documentos nem valores.

### 1.4 Correção de documentação

No `README.md`, na tabela "Tipos de Relatório", corrija as siglas (confirmadas pela diretoria em 26/10/2026):

| Sigla | Nome |
|---|---|
| RTP | Relatório de Teste de Pressão |
| RLQ | Relatório de Limpeza Química |
| RCPU | Relatório de Contagem de Partículas e Umidade |
| RLM | Relatório de Limpeza Mecânica |
| RLF | Relatório de Flushing |
| RLI | Relatório de Inibição |

Procure as mesmas siglas em rótulos de interface e documentos gerados. Se estiverem diferentes, liste no relatório final **sem alterar** templates DOCX de clientes.

### Entrega da Parte 1

- Os escopos novos aparecem como `AVAILABLE` em **Administração → Tokens de API**, para eu acrescentá-los ao token do Omni:
  - `projetos.responsaveis.read`;
  - os campos novos de `/projetos` e a coleção de status saem com os escopos atuais.
- Relatório final com:
  - os endpoints e campos exatos;
  - um exemplo de resposta de cada um, com dados fictícios;
  - o `schemaVersion`;
  - os testes adicionados.

## Parte 2 — registrar como spec no backlog (não implementar agora)

Crie `specs/0NN-api-omni-fase2/spec.md` só com requisitos e critérios de aceite, para priorizarmos depois:

1. **Eventos de saída** para o Omni reagir sem polling: feed `GET /eventos?cursor=` (preferível) ou webhook com HMAC, a partir da `NotificationEvent`. Eventos:
   - RDO criado, aprovado, devolvido ou assinado;
   - mudança de etapa do workflow;
   - registro de Qualidade criado ou alterado;
   - romaneio emitido;
   - responsáveis do projeto alterados.
2. **RDOs além de `APPROVED`:** expor `PENDING`, `RETURNED` e `SIGNED` com um escopo próprio (ex.: `rdo.relatorios.todos.read`). A IA do Omni cobra RDO atrasado ou devolvido.
3. **Escrita de Qualidade:** `POST /qualidade/registros` com escopo `qualidade.registros.create`.
   - Idempotente (`Idempotency-Key`), com `origin = OMNI`.
   - Responsável por usuário (hoje `actionOwner` é texto livre).
   - Tipos: DESVIO, INCIDENTE, RECLAMACAO_CLIENTE.
   - O Omni abre um desvio automático sempre que alguém responde "não" a uma checagem da IA.
4. **Feriados:** liberar `efetivo.feriados.read` e permitir feriados **municipais com cidade** (Itajaí: 15/06 e 08/12).
5. **Descarga de equipamentos:** registrar no romaneio de saída:
   - confirmação de chegada e descarga na obra (data, parcial × total);
   - quem confirmou (Líder de Projetos);
   - transportadora;
   - vínculo com a NF e o CT-e do Omie.

   Isso inclui trazer o **CT-e** na sincronização do Omie (hoje só NFS-e, NF-e e ND).
6. **Condições da proposta para a Gestão do Omni:** expor por projeto a **permanência prevista em obra** (`CommercialProposal.plannedDays`) e a **diária de stand-by de equipamentos** (`components.diariaEquipamento`), num escopo mínimo próprio (ex.: `projetos.condicoes.read`), sem o restante de `comercial.*`.
7. **Liberar para leitura**, com recorte por projeto, os escopos hoje bloqueados que a aba Gestão do Omni vai usar:
   - `acompanhamento.progresso.read` e `acompanhamento.custos.read`;
   - `omie.recebiveis.read` e `omie.compras.read`;
   - `romaneios.itens.read`;
   - `efetivo.alocacoes.read`;
   - `ponto.resumos.read` (agregado por projeto, sem dados individuais).
8. **Campos que ainda não existem:**
   - vendedor da carteira como FK (hoje é texto em `CommercialProposal.vendedor`);
   - responsável pela documentação por projeto;
   - coordenador de mobilização por projeto;
   - data de viagem da equipe, separada da mobilização.
