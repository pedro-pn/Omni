# Prompt para o Claude Code no filtroAPP — Gestão (spec 034, B6): avanço e meta da semana, custos × avanço, condições, alocações e ponto

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 03/11/2026. A Entrega B (medição, notas, romaneios, pendências, descargas) já está em produção e em uso pelo Omni.

---

## Contexto

O Omni (`../omni`) tem uma **Revisão semanal** para gerentes e diretoria: uma linha por missão ativa com avanço, RDOs, Qualidade, medição, NFs e pendências no Omie, mais alertas. Faltam as duas perguntas que mais importam na reunião semanal, e **os dados delas já estão no filtroAPP**:

1. **A missão cumpriu a meta da semana?**
   - meta: `MissionWeeklyProgressTarget.plannedPctPoints`;
   - avanço: `ProjectManualProgressHistory` e o avanço do workflow;
   - revisão semanal do próprio filtroAPP: `ProjectExecutionWeeklyReview`, montada em `lib/efetivo/project-workflow/weekly-review.js`.
2. **O custo está andando junto com o avanço?**
   - orçamento: `ProjectBudget` selecionado (`plannedTotalCost`, `salePrice`, `expectedMargin`, `plannedDays`);
   - custo realizado: o mesmo cálculo do painel de Acompanhamento (`lib/acompanhamento/project-cards.js`, `project-detail.js`, `cost-engine.js`, `manual-costs.js`), que soma mão de obra (ponto × perfis de custo), compras do Omie e custos manuais.

Esta entrega é o **B6 da spec 034**: US6 (condições), US7 (Gestão) e a leitura da meta e da revisão semanal.

**Regra principal: a API devolve os números que o Acompanhamento já mostra.** Reaproveite os serviços existentes; não crie um segundo cálculo de custo ou de avanço. Se dois números puderem divergir (por exemplo, o card e o detalhe), use o do detalhe e documente.

Leia `CLAUDE.md`, `docs/PADRAO_MODULO.md`, `docs/API_INTEGRACOES.md`, as specs 033, 034 e 035 e o relatório da Entrega B. Siga as mesmas convenções:
- catálogo de escopos com sensibilidade e dependências;
- `operational-resources.js`;
- OpenAPI e playground;
- testes com `node --test`;
- `npm run architecture:check`.

**Mudanças só aditivas**, porque o Prisma CRM também consome a API. Atualize `plan.md`, `tasks.md` e `contracts/` da 034 antes de codar. Se algo for inviável, pare e me explique a alternativa.

## Regras para todos os recursos

- **Recorte por projeto** do token, aplicado antes da paginação; sem totais globais.
- **Envelope, paginação e filtros:** os de sempre (`items`, `page`, `requestId`, `schemaVersion`), com `updatedSince`, `projectId` ou `projectCode` e, quando fizer sentido, `weekStart`.
- **Valores em reais:** strings decimais com moeda `BRL`, como na Entrega B, e só nos escopos marcados como financeiros.
- **Dados pessoais:** nada de nome, CPF ou salário de colaborador. Onde precisar identificar alguém, use o `collaboratorId`; o Omni cruza com `colaboradores.operacional.read`, que já tem.
- **Semana:** segunda a domingo, `weekStart` em `YYYY-MM-DD` no fuso de São Paulo. Documente se o filtroAPP usar outra convenção.

## G1. Avanço, meta da semana e revisão semanal — prioridade 1

| Item | Decisão |
|---|---|
| Recurso | `GET /acompanhamento/projetos/semanas` (coleção: uma linha por projeto **e** semana) |
| Escopo | `acompanhamento.progresso.read` (INTERNAL) |
| Filtros | `weekStart` (padrão: semana atual) ou `from`/`to` (no máximo 12 semanas), além dos de sempre |
| Campos | `projectId`, `projectCode`, `weekStart`, `avancoInicio` e `avancoFim` (% no começo e no fim da semana, ou o último registro até ali), `metaPontos` (`plannedPctPoints` da semana, ou `null`), `metaDefinidaPor` (`PROJETO` ou `GRUPO`), `revisao` (veja abaixo), `updatedAt` |
| `revisao` | `null` se não houver; senão `{ concluidaEm, pendencias, itens: [{ codigo, rotulo, ok }] }`, com os itens de `checks` como o filtroAPP os mostra. A nota livre fica **fora** |
| Eventos | `acompanhamento.meta_alterada` e `acompanhamento.revisao_concluida` |

**Uso no Omni:** colunas "meta × realizado na semana" e "revisão do filtroAPP feita / pendente". Alerta quando o realizado fica abaixo da meta. A revisão concluída no filtroAPP não é cobrada de novo no Omni.

## G2. Custos × avanço — prioridade 1

| Item | Decisão |
|---|---|
| Recurso | `GET /acompanhamento/projetos/custos` (coleção: uma linha por projeto) |
| Escopo | `acompanhamento.custos.read` (FINANCIAL) |
| Campos | `projectId`, `projectCode`, `orcamento` (`precoVenda`, `custoPrevisto`, `margemPrevista` em %, `diasPrevistos`, do `ProjectBudget` selecionado, ou `null`), `custoRealizado` (`total`, `porCategoria: [{ codigo, rotulo, valor }]` com as categorias do painel, `ate` = data de corte), `avancoFisico` (%), `consumoDoCusto` (`total / custoPrevisto` em %, ou `null`), `currency`, `atualizadoEm` |
| Coerência | Os números batem com o painel de Acompanhamento do projeto, inclusive nas categorias excluídas (`cost-categories.js`) |
| Sem | lançamentos individuais, custo por pessoa e salário |
| Eventos | Não precisa: o Omni lê uma vez por dia |

**Uso no Omni:** a coluna "custo consumido × avanço" (por exemplo, 62% do custo previsto com 45% de avanço). Alerta quando o consumo do custo passa o avanço físico além de uma margem que vamos calibrar.

## G3. Condições da proposta (US6) — prioridade 2

| Item | Decisão |
|---|---|
| Recurso | `GET /projetos/condicoes` |
| Escopo | `projetos.condicoes.read` (INTERNAL; sem depender de `comercial.*`) |
| Campos | `projectId`, `projectCode`, `permanenciaPrevistaDias` (`CommercialProposal.plannedDays` ou `ProjectBudget.plannedDays`, e diga qual), `diariaStandByEquipamento` (`components.diariaEquipamento`, decimal BRL ou `null`), `updatedAt` |

**Uso no Omni:** junto com os romaneios da Entrega B, alerta "equipamento em obra além do previsto" e mostra a diária de stand-by que começa a correr.

## G4. Alocações — prioridade 2

| Item | Decisão |
|---|---|
| Recurso | `GET /efetivo/alocacoes` |
| Escopo | `efetivo.alocacoes.read` (INTERNAL) |
| Campos | `id`, `projectId`, `projectCode`, `collaboratorId`, `funcao` (`jobRoleNameSnapshot`), `mobilizacao`, `desmobilizacao`, `updatedAt`, `deletedAt` (exclusão lógica) |
| Sem | nome, CPF, salário ou dados de contato (o nome vem por `colaboradores.operacional.read`) |
| Eventos | `alocacao.alterada` |

**Uso no Omni:** quem está em cada missão na semana, e a equipe prevista × a equipe nos RDOs.

## G5. Ponto agregado — prioridade 3

| Item | Decisão |
|---|---|
| Recurso | `GET /ponto/projetos/semanas` |
| Escopo | `ponto.resumos.read` (INTERNAL, **só agregado**) |
| Campos | `projectId`, `projectCode`, `weekStart`, `minutosNormais`, `minutosExtra70`, `minutosExtra100`, `minutosNoturnos`, `pessoas` (quantidade, sem identificar), `atualizadoEm` |
| Atribuição ao projeto | A mesma do filtroAPP (aliases de tag e ajustes por dia: `PontoProjectTagAlias`, `PontoDayProjectOverride`) |
| Privacidade | Semanas com uma pessoa só ficam agregadas no mês, ou omitidas. Documente a regra |

**Uso no Omni:** horas extras por missão na Revisão semanal, e o cruzamento com os RDOs.

## Entrega

1. Spec 034 atualizada com o B6 e a ordem acima. **Pode entregar G1 e G2 primeiro, numa PR própria.**
2. Escopos no catálogo, com sensibilidade, dependências e descrição em português.
3. OpenAPI, playground e `docs/API_INTEGRACOES.md` atualizados, com exemplos fictícios.
4. **Testes:**
   - recorte de projeto;
   - escopo ausente → `403`;
   - valores só com o escopo financeiro;
   - **os números de custo e avanço batem com os do painel de Acompanhamento** para os mesmos projetos;
   - nenhum dado pessoal nas respostas de G4 e G5;
   - semanas com uma pessoa só agregadas ou omitidas;
   - eventos no feed só com o escopo do recurso;
   - `architecture:check`.
5. **Relatório final:** o que foi entregue, os nomes finais dos escopos e campos (se algum mudar, me diga para eu ajustar o Omni), as decisões de convenção (semana, origem dos dias previstos, categorias de custo) e o que ficou para depois.

Depois disso, eu acrescento os escopos novos ao token "Omni – desenvolvimento" e aviso o Omni.
