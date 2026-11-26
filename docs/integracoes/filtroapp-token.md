# Token da API de integrações do filtroAPP para o Omni

> Criado em **filtroAPP → Administração → Tokens de API** (`/admin/tokens`), por um administrador do hub.
> Nomes dos escopos conferidos em `filtroAPP-main/backend/src/lib/api-credentials/catalog.js` e `operational-resources.js` (28/10/2026).
> **Esta é a lista oficial dos escopos do Omni.** Ao marcar ou desmarcar um escopo no filtroAPP, atualize aqui.
> Quase tudo é leitura. Escritas só as listadas neste arquivo, e no token de desenvolvimento elas são sempre simuladas (`SIMULATE`, spec 035).

## Escopos para a Fase 2 (Missões)

| Escopo | Endpoint | Para quê no Omni |
|---|---|---|
| `projetos.read` | `/projetos` | Lista das missões (código, cliente, situação) |
| `efetivo.projetos.status.read` | `/efetivo/projetos/{id}/status` | Etapa, datas planejadas, prontidão, pendências e % de avanço |
| `rdo.relatorios.read` | `/rdo/relatorios` | RDOs e relatórios técnicos (RTP, RLQ, RCPU, RLM, RLF, RLI) |
| `rdo.servicos.read` | `/rdo/servicos` | Avanço de escopo por RDO (metros, litros); base do alerta "sem avanço" |
| `rdo.equipe.read` | `/rdo/equipe` | Quem estava em cada RDO |
| `rdo.assinaturas.read` | `/rdo/assinaturas` | RDOs emitidos × assinados |
| `qualidade.registros.read` | `/qualidade/registros` | Desvios, incidentes, reclamações e lições da missão |
| `qualidade.naturezas.read` | `/qualidade/naturezas` | Nomes das naturezas dos registros |
| `qualidade.excluidos.read` | `includeDeleted=true` | Saber quando um registro foi excluído, para tirar do Omni também |
| `colaboradores.operacional.read` | `/colaboradores` | Nome do líder de campo e da equipe |
| `clientes.segmentos.read` | `/clientes/segmentos` | Segmento do cliente no cabeçalho da missão |

**Não marcar:** `cargos.salarios.read`, `colaboradores.pii.read` e qualquer `*.write` ou `*.create` que não esteja listado neste arquivo.

## Escopos acrescentados depois (29/10/2026)

| Escopo | Para quê |
|---|---|
| `projetos.responsaveis.read` | Líder de projetos, gestor de contrato e líder de campo de cada missão (`/projetos/responsaveis`) |
| `eventos.read` | Feed de eventos (spec 034): o Omni reage em minutos a RDO, etapa, Qualidade e responsáveis |
| `rdo.relatorios.todos.read` | RDOs em todos os estados (pendente, devolvido, aprovado, assinado) |
| `qualidade.registros.create` | Desvios abertos pela IA (**escrita**) |

## Escopos da spec 038 (11/11/2026): PDF dos relatórios e e-mail corporativo

Rotacione o token **preservando os escopos atuais** e marque também:

| Escopo | Para quê |
|---|---|
| `rdo.relatorios.pdf.download` | "Ver PDF" e "Baixar" nas abas RDOs e Relatórios (`/rdo/relatorios/{id}/pdf`; o campo `pdf` da listagem só vem com ele) |
| `manutencao.registros.read`, `manutencao.anexos.metadata.read`, `manutencao.anexos.download` | Documento dos RDOs de manutenção (`pdf.maintenanceAttachmentIds` → `/manutencao/anexos/{id}/download`) |
| `colaboradores.contato_corporativo.read` | E-mail corporativo do colaborador em `/colaboradores`: a equipe alocada no Efetivo passa a ver a missão no Omni (0045) |

Mantenha `rdo.relatorios.read`, `rdo.relatorios.todos.read` e `colaboradores.operacional.read`. O web do Omni também usa o token (só leitura, para buscar o PDF): o mesmo `FILTROAPP_API_TOKEN` vai para o web e o worker.

**Modo de escrita da credencial (spec 035):**

| Token | `writeMode` | `FILTROAPP_ESCRITA` no Omni |
|---|---|---|
| Omni – desenvolvimento | **`SIMULATE`** (toda escrita é simulada, mesmo sem o cabeçalho) | `simulada` |
| Omni – produção | `LIVE` | `real` |
| Omni – staging (26/11/2026) | **`SIMULATE`** | `simulada` (a validação recusa `real` fora da produção) |

**Token do staging:** os mesmos escopos de leitura da produção (todos os listados neste arquivo), as duas
escritas (`qualidade.registros.create`, `logistica.descargas.create`) só porque o modo é `SIMULATE`,
projetos Todos, IP da VPS, 90 dias. Nunca reaproveitar o token da produção.

Verificado em 29/10/2026: com o token de desenvolvimento, a produção respondeu `Preference-Applied: validate-only` mesmo sem o cabeçalho, e um desvio simulado completo não criou nenhum registro de Qualidade.

## Configuração do token
- **Nome:** `Omni – desenvolvimento` (depois, um segundo token `Omni – produção`).
- **Projetos:** **Todos** (o Omni acompanha todas as missões).
- **IPs permitidos (CIDR):**
  - desenvolvimento: o IP público da rede de onde você vai rodar;
  - produção: **o IP público da VPS**.
- **Validade:** 90 dias, com rotação antes de vencer.
- **Tamanho de página:** 500.
- O segredo aparece **uma vez só**. Copie direto para o arquivo abaixo.

## Onde colocar
| Ambiente | Arquivo | Variável |
|---|---|---|
| Desenvolvimento | `.env` na raiz do Omni (`/home/relat/apps/omni/.env`) | `FILTROAPP_API_TOKEN=` |
| Produção | `deploy/.env.production` na VPS (`~/apps/Omni`) | `FILTROAPP_API_TOKEN=` |
| Staging | `deploy/.env.staging` na VPS (`~/apps/Omni-staging`) | `FILTROAPP_API_TOKEN=` |

`FILTROAPP_API_URL` já vem preenchida com `https://app.filtrovali.com.br/api/integracoes/v1`. Os dois arquivos estão no `.gitignore`.

## Entrega B (spec 034) — marcados em 29/10/2026 e em uso

Pedido em `docs/integracoes/prompt-filtroapp-entrega-b.md`; contrato em `filtroAPP-main/specs/034-api-omni-fase2/contracts/delivery-b.md`. Nomes finais iguais aos pedidos (conferido no relatório da entrega). Verificado em 29/10/2026 com o token de desenvolvimento: as cinco leituras respondem e a escrita da descarga é aceita **em simulação** (nada gravado).

| Prioridade | Escopo | Para quê no Omni | Sensibilidade |
|---|---|---|---|
| 1 | `efetivo.projetos.medicao.read` | Situação e datas da medição e se ficou saldo sem medir. A IA só pergunta "já mediu?" e "o cliente aprovou?" quando o filtroAPP não sabe | interna |
| 1 | `efetivo.projetos.medicao.valores.read` | Valores executado, medido e aprovado | **financeira** |
| 1 | `omie.notas.read` | NFs por projeto e situação do recebimento. Substitui a pergunta "a NF já foi emitida?" | **financeira** |
| 2 | `romaneios.read` | Romaneios de saída e de retorno. O retorno responde "os equipamentos voltaram?" | interna |
| 2 | `omie.pendencias.read` | Total a pagar e a receber por projeto. A pergunta final do ciclo só aparece se houver pendência | **financeira** |
| 3 | `logistica.descargas.read` | Confirmações de chegada e descarga, com o CT-e | interna |
| 3 | `logistica.descargas.create` | O líder confirma a descarga pelo Omni e o Omni grava no filtroAPP | **escrita** |

- **No token de desenvolvimento** (em `SIMULATE`): marque todos assim que saírem. A escrita fica simulada.
- **No token de produção** (em `LIVE`): marque `logistica.descargas.create` só depois de testar o fluxo com o token de desenvolvimento.

## Gestão (B6) — marcados em 03/11/2026

Pedido em `docs/integracoes/prompt-filtroapp-gestao.md`; contrato em `filtroAPP-main/specs/034-api-omni-fase2/contracts/delivery-b6.md`. Nomes finais iguais aos pedidos, mais um escopo financeiro novo (`projetos.condicoes.valores.read`). Verificado em 03/11/2026 com o token de desenvolvimento: as cinco leituras respondem; custos × avanço só com páginas de até ~10 projetos (100 por página estoura o tempo do filtroAPP). **Tamanho máximo de página da credencial:** o padrão do filtroAPP (100) basta — o Omni nunca pede mais que 100 (o feed de eventos pedia 500 e falhou com `INVALID_LIMIT` no token rotacionado em 03/11). Em uso desde 03/11/2026: `apps/worker/src/sync/filtroapp-gestao.ts` (semanas, ponto e custos) e os recursos `condicoes` e `alocacoes` de `filtroapp-entrega-b.ts`.

| Prioridade | Escopo | Para quê no Omni | Sensibilidade |
|---|---|---|---|
| 1 | `acompanhamento.progresso.read` | Avanço e meta da semana, e se a revisão semanal do filtroAPP foi feita; composição do avanço por serviço (`/acompanhamento/projetos/servicos`, desde 24/11/2026) | interna |
| 1 | `acompanhamento.custos.read` | Custos × avanço: orçamento, custo realizado e consumo do custo | **financeira** |
| 2 | `projetos.condicoes.read` | Permanência prevista dos equipamentos (alerta "equipamento em obra além do previsto") | interna |
| 2 | `projetos.condicoes.valores.read` | Diária de stand-by dos equipamentos (marcado em 03/11) | **financeira** |
| 2 | `efetivo.alocacoes.read` | Quem está alocado em cada missão (por `collaboratorId`, sem dados pessoais) | interna |
| 3 | `ponto.resumos.read` | Horas normais e extras por missão e semana, **só agregadas** | interna |

`efetivo.feriados.read` **não é necessário**: o Omni mantém o próprio calendário (nacionais calculados e municipais na Administração).
