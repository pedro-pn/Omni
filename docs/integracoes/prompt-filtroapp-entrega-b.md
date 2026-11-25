# Prompt para o Claude Code no filtroAPP — Entrega B (spec 034): medição, notas, romaneios, descarga e CT-e

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 29/10/2026. A Entrega A (feed de eventos, RDOs em todos os estados, abrir Qualidade) e a spec 035 (simulação de escritas) já estão em produção e em uso pelo Omni.

---

## Contexto

O Omni (`../omni`) acompanha o ciclo da missão com uma IA que pergunta às pessoas, no canal Interno, o que ela ainda não sabe: se a medição foi feita e aprovada, se a NF saiu, se os equipamentos voltaram, se ainda há despesas. Boa parte disso **o filtroAPP já tem** e só não está na API de integrações:

| Dado | Onde está no filtroAPP |
|---|---|
| Medição: preparada, enviada, aprovada; valores executado, medido, aprovado | `ProjectWorkflowMeasurement` |
| Notas emitidas por projeto (NFS-e, NF-e, ND), recebimento | `OmieInvoice` (e `OmieReceivable`) |
| Compras/despesas por projeto | `OmiePurchase` |
| Romaneios de saída e de retorno | `Romaneio` (`OUTBOUND` / `INBOUND`), `RomaneioItem` |

Com isso na API, a IA do Omni deixa de perguntar o que o filtroAPP já sabe e só pergunta o que falta. A spec `specs/034-api-omni-fase2` já registrou a Entrega B (US5–US8). **Agora é para implementá-la**, na ordem de prioridade abaixo.

Leia `CLAUDE.md`, `docs/PADRAO_MODULO.md`, `docs/API_INTEGRACOES.md` e as specs 033, 034 e 035. Siga as mesmas convenções:
- catálogo de escopos;
- `operational-resources.js`;
- OpenAPI e playground;
- testes com `node --test`;
- `npm run architecture:check`.

**Mudanças só aditivas**, porque o Prisma CRM também consome a API. Atualize `plan.md`, `tasks.md` e `contracts/` da 034 antes de codar. Se algo for inviável, pare e me explique a alternativa.

## Regras para todos os recursos novos

- **Recorte por projeto** do token, como nos demais: projeto fora do recorte não aparece nem em contagem.
- **Projeção mínima:**
  - nada de dados pessoais sem necessidade (nome de motorista, placa, CPF);
  - valores financeiros só nos escopos marcados como financeiros.
- **Paginação e cursor:** envelope e cursor iguais aos atuais (`items`, `page.nextCursor`, `page.hasMore`, `requestId`, `schemaVersion`), com `updatedSince`, `projectId` e `projectCode` como filtros.
- **Feed `/eventos`:** cada recurso ganha seus tipos de evento no feed. O evento só sai para o token que tem o escopo do recurso (mesma regra da Entrega A).
- **Escritas:** toda escrita nova nasce com `Idempotency-Key` e com a simulação da spec 035 (`Prefer: validate-only` e credencial `SIMULATE`). O gate de arquitetura já exige isso.

## B1. Medição por projeto — prioridade 1

| Item | Decisão |
|---|---|
| Recurso | `GET /efetivo/projetos/medicoes` (coleção) e `GET /efetivo/projetos/{id}/medicao` |
| Escopo base | `efetivo.projetos.medicao.read` |
| Campos base | `projectId`, `projectCode`, `preparedAt`, `sentAt`, `approvedAt`, `situacao`, `saldoPendente`, `updatedAt` |
| `situacao` | `SEM_MEDICAO`, `PREPARADA`, `ENVIADA` ou `APROVADA` |
| `saldoPendente` | `true` quando `approvedAmount < executedAmount`; `null` se faltar valor |
| Escopo financeiro | `efetivo.projetos.medicao.valores.read` (sensibilidade financeira) acrescenta `executedAmount`, `measuredAmount`, `approvedAmount` e `currency` |
| Eventos | `medicao.alterada` (qualquer mudança de data, situação ou valor) |

O Omni usa assim:
- **"A medição já foi feita?"** só é perguntada se `situacao` não passou de `PREPARADA`.
- **"O cliente aprovou?"** só é perguntada se não houver `approvedAt`.
- **Saldo não medido:** o Omni avisa o Gerente comercial e abre um desvio quando `saldoPendente = true`.

## B2. Notas fiscais por projeto — prioridade 1

| Item | Decisão |
|---|---|
| Recurso | `GET /omie/notas` (coleção) |
| Escopo | `omie.notas.read` (sensibilidade financeira) |
| Campos | `id`, `projectId`, `projectCode`, `tipo` (`NFSE`, `NFE` ou `ND`), `numero`, `serie`, `dataEmissao`, `valor`, `situacaoRecebimento` (`RECEBIDA`, `PARCIAL`, `EM_ABERTO`, `ATRASADA` ou `DESCONHECIDA`), `updatedAt` |
| Ligação ao projeto | Documente como `OmieInvoice.codigoProjeto` é ligado ao `Project`; nota sem projeto ligado **não sai**, em vez de sair no projeto errado |
| Eventos | `nota.emitida` (primeira vez que aparece) e `nota.recebimento_alterado` |

**Uso no Omni:** a pergunta "A NF já foi emitida?" deixa de existir quando já há nota depois da aprovação da medição. Os "5 dias úteis depois da NF" passam a contar da `dataEmissao` real.

## B3. Romaneios — prioridade 2

| Item | Decisão |
|---|---|
| Recurso | `GET /romaneios` (coleção) |
| Escopo | `romaneios.read` (o `romaneios.itens.read` previsto pode ser este, ou o detalhamento por item, se preferir separar) |
| Campos | `id`, `projectId`, `projectCode`, `tipo` (`SAIDA` ou `RETORNO`), `data`, `emitidoEm`, `quantidadeItens`, `pesoCarga`, `unidadePeso`, `updatedAt` |
| Não expor | `driverName`, `vehiclePlate`, assinaturas e URLs de arquivos |
| Eventos | `romaneio.emitido`, que já está previsto na Entrega A e só passa a sair com este escopo |

**Uso no Omni:** "Os equipamentos também foram desmobilizados?" passa a ser respondida pelo romaneio de **retorno**. A pergunta só é feita se ele não existir no dia da desmobilização.

## B4. Despesas e pagamentos pendentes por projeto — prioridade 2

| Item | Decisão |
|---|---|
| Recurso | `GET /omie/projetos/pendencias` (coleção, **só agregado por projeto**) |
| Escopo | `omie.pendencias.read` (sensibilidade financeira) |
| Campos | `projectId`, `projectCode`, `aPagar` (quantidade e valor em aberto, próximo vencimento), `aReceber` (o mesmo), `atualizadoEm` |
| Sem | lançamentos individuais, fornecedores ou dados de pessoas |

**Uso no Omni:** a pergunta final "Ainda há despesas ou pagamentos pendentes no Omie?" só é feita quando há pendência. Com tudo zerado, o ciclo da missão se encerra sozinho no Omni.

## B5. Chegada, descarga e CT-e (US5) — prioridade 3, funcionalidade nova no filtroAPP

Aqui o dado **ainda não existe** no filtroAPP: é preciso criar a confirmação primeiro.

- **No filtroAPP:** registrar a chegada e a descarga dos equipamentos na obra, por romaneio de saída. Guardar:
  - data e hora;
  - se foi parcial ou total;
  - quem confirmou (o líder de projetos);
  - a transportadora;
  - o vínculo com NF e CT-e.
- **Histórico:** a descarga parcial seguida de total mantém o histórico, e confirmar duas vezes não duplica.
- **CT-e do Omie:** importar e ligar ao romaneio ou projeto, sem misturar com NFS-e, NF-e ou ND.
- **API de leitura:** `GET /logistica/descargas`, escopo `logistica.descargas.read`. Campos: `romaneioId`, `projectId`, `tipo` (`PARCIAL` ou `TOTAL`), `confirmadaEm`, `confirmadaPorEmail`, `cte` (número, emissão, transportadora). Evento `descarga.confirmada`.
- **API de escrita:** `POST /logistica/descargas`, escopo `logistica.descargas.create`, com `Idempotency-Key` e simulação (035). Corpo: `romaneioId`, `tipo`, `confirmadaEm`, `confirmadaPorEmail`. O e-mail precisa ser de um usuário do filtroAPP com acesso ao projeto, senão `422`.

**Uso no Omni:** na mobilização, a IA pergunta ao líder "Os equipamentos chegaram e foram descarregados?". A resposta grava a confirmação no filtroAPP pela API, que continua dono do dado. Até o filtroAPP liberar, o Omni grava só simulando.

## B6. Depois (pode ficar como plano nesta entrega)

- **US6:** condições mínimas da proposta (`projetos.condicoes.read`), com a permanência prevista e a diária de stand-by dos equipamentos. Serve ao alerta "equipamento em obra além do previsto".
- **US7:** escopos de Gestão para a Revisão semanal do Omni (`acompanhamento.progresso.read`, `acompanhamento.custos.read`, `efetivo.alocacoes.read`, `ponto.resumos.read` só agregado). As NFs, os recebíveis e as pendências já ficam cobertos por B2 e B4.
- **US8:** vendedor, documentação, coordenação de mobilização e data de viagem estruturados. **Baixa prioridade para o Omni:** ele já mantém as funções da empresa (Qualidade, Medição, Faturamento…) na Administração e só precisaria disso se a pessoa variar por projeto.
- **US4 (feriados):** continua dispensada para o Omni.

## Entrega

1. Spec 034 atualizada (plan, tasks e contracts) com B1 a B5 e a ordem acima. Pode entregar B1 e B2 primeiro, numa PR própria.
2. Escopos no catálogo, com sensibilidade, dependências e descrição em português.
3. OpenAPI, playground e `docs/API_INTEGRACOES.md` atualizados, com exemplos fictícios.
4. **Testes:**
   - recorte de projeto;
   - escopo ausente → `403`;
   - campos financeiros só com o escopo financeiro;
   - eventos no feed só com o escopo do recurso;
   - nota sem projeto ligado não sai;
   - escrita da descarga com idempotência e simulação;
   - `architecture:check`.
5. **Relatório final:** o que foi entregue, os nomes finais dos escopos e campos (se algum mudar, me diga para eu ajustar o Omni) e o que ficou para depois.

Depois disso, eu acrescento os escopos novos ao token "Omni – desenvolvimento" (que segue em `SIMULATE`) e aviso o Omni.
