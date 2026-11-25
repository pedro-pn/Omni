# Prompt para o Claude Code no filtroAPP — meta da semana como está cadastrada (spec 034, complemento do B6/G1)

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 03/11/2026, depois do B6 em produção.

---

## Contexto

O Omni (`../omni`) lê `GET /acompanhamento/projetos/semanas` (escopo `acompanhamento.progresso.read`) para a Revisão semanal. Hoje esse recurso só entrega a meta em `metaPontos` (pontos percentuais). Mas as metas reais da Filtrovali são cadastradas em outras unidades:
- metragem (m);
- volume filtrado (L);
- unidades de sistema (un);
- colaboradores presentes por dia;
- por tipo de serviço, em lista com regra E/OU, ou em cenários, por semana ou por dia produtivo.

O realizado vem do preenchimento dos RDOs. Resultado: em 03/11, nenhum projeto tinha `metaPontos`, embora haja metas cadastradas.

**O Omni quer mostrar a meta exatamente como o filtroAPP mostra:** a mesma unidade, o mesmo planejado, o mesmo realizado e a mesma situação. Não quer em %.

Essa comparação já existe: `buildWeeklyProgressComparison` em `shared/modules/mission-weekly-progress.js`, usada pelo painel `MissionWeeklyProgressPanel.tsx`, com os rótulos de `weeklyTargetPresentation.ts`, `WEEKLY_TARGET_METRICS`, `WEEKLY_TARGET_SERVICES` e `weeklyTargetUnit`.

**Regra principal: a API devolve o resultado dessa mesma função, com as mesmas entradas que o painel usa.** Isso vale para metas, histórico de avanço, serviços dos RDOs e presença. Não crie um segundo cálculo. Se o painel monta as entradas no frontend, mova a montagem para um serviço compartilhado do backend e use-o nos dois lugares, ou documente por que não dá.

Leia `CLAUDE.md`, `docs/API_INTEGRACOES.md`, a spec 034 (contrato `delivery-b6.md`) e `lib/api-credentials/management-resources.js`. **Mudança só aditiva:** `metaPontos` e `metaDefinidaPor` continuam como estão.

## O que acrescentar em cada linha de `/acompanhamento/projetos/semanas`

Acrescente o campo `meta`: `null` quando a semana não tem meta (situação `NO_TARGET`); senão:

| Campo | Origem em `buildWeeklyProgressComparison` |
|---|---|
| `situacao` | `status` (PLANNED, NO_DATA, NO_RULE, BELOW, PARTIAL, ON_TARGET, ABOVE) |
| `rotuloSituacao` | o texto que o painel mostra para a situação |
| `emAndamento` | `inProgress` |
| `periodoInicio`, `periodoFim` | `periodStartDate`, `periodEndDate` (o período de contagem pode não ser seg–dom) |
| `regra` | `logic` (ALL = todas as linhas; ANY = basta uma) |
| `cenario` | `scenarioName` |
| `atingimentoPct` | `achievementPct` |
| `itens` | um por linha da meta (`goals`), veja abaixo |

Cada item de `itens`:

| Campo | Origem |
|---|---|
| `tipo` | `PROGRESS`, `SERVICE` ou `ATTENDANCE` (`weeklyTargetGoalKind`) |
| `servico`, `rotuloServico` | `serviceType` e o rótulo (`WEEKLY_TARGET_SERVICES`), ou `null` para "qualquer serviço" |
| `unidade`, `rotuloUnidade` | `metric` e `weeklyTargetUnit(metric)` (p.p., m, L, un, colab./dia) |
| `base` | `basis` (WEEK_TOTAL, PER_PRODUCTIVE_DAY, PER_WORKDAY) |
| `valorCadastrado` | `value`, como o usuário digitou (ex.: 50 m por dia produtivo) |
| `planejado`, `realizado`, `diferenca` | `plannedValue`, `actualValue`, `differenceValue` |
| `resultado` | `outcome` (MET, BELOW, NO_DATA, PLANNED) ou o equivalente nos cenários |
| `pendenciasBase` | `productivityIssues` (só os códigos, como MISSING_RDO_BASE) |
| `descricao` | a frase que o painel mostra para a linha (ex.: "Flushing: 50 m por dia produtivo") |

**Colaboradores por dia:** inclua, por dia do período, só `data`, `planejado` e `presentes` (quantidades), **sem nomes nem ids**.

**Sem:** autor da meta, notas, nomes de colaboradores e valores em reais.

## Sincronização

- **Situação:** o realizado muda com cada RDO, então a linha muda sem evento. O Omni relê as últimas 4 semanas a cada 30 min, e isso basta.
- **Eventos:** `acompanhamento.meta_alterada` continua cobrindo mudança de meta. Não precisa de evento novo.
- **Desempenho:** o custo da leitura não pode subir muito. Hoje, 4 semanas × 85 projetos levam cerca de 13 s em páginas de 100. Se a montagem das entradas pesar, carregue em lote por página, como no avanço.

## Entrega

1. Contrato `delivery-b6.md` e OpenAPI atualizados, com exemplos fictícios de cada forma de meta:
   - p.p.;
   - lista por serviço com regra E/OU;
   - cenário;
   - por dia produtivo, com pendência de base;
   - colaboradores por dia.
2. **Testes de paridade:** para os mesmos dados, `meta` da API = resultado de `buildWeeklyProgressComparison` que o painel mostra. Cubra cada forma acima, semana sem RDO (NO_DATA), semana futura (PLANNED), meta repetida semanalmente e período de contagem que não é seg–dom.
3. **Sem dados pessoais** nas respostas; `architecture:check` aprovado.
4. **Relatório:** os nomes finais dos campos (se algum mudar, me diga para eu ajustar o Omni) e as decisões tomadas.

Não precisa de escopo novo: é o mesmo `acompanhamento.progresso.read`.
