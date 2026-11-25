# Prompt para o Claude Code no filtroAPP — lista de status responde 500 com páginas grandes

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`. Escrito em 04/11/2026.

---

## Contexto

Depois do deploy do **avanço unificado** (contrato `specs/034-api-omni-fase2/contracts/prisma-progress.md`, 04/11/2026), a coleção `GET /api/integracoes/v1/efetivo/projetos/status` passou a responder **500 `INTERNAL_ERROR`** quando a página é grande. O Omni lê essa coleção a cada 30 min com o token "Omni – desenvolvimento" (projetos ALL, `maxPageSize` 100).

Medido em produção em 04/11/2026, entre 15h05 e 15h12:

| Requisição | Resultado | Tempo |
|---|---|---|
| `?limit=100&active=true` | 500 `INTERNAL_ERROR` | ~9–13 s |
| `?limit=100` | 500 `INTERNAL_ERROR` | ~9 s |
| `?limit=25` | 200 | ~7,9 s |
| `?limit=10` | 200 | ~0,6 s |
| `?limit=1` | 200 | ~1,3 s |
| `GET /efetivo/projetos/{id}/status` | 200 | ~0,2 s |

`requestId` das falhas (para achar nos logs): `<GUID>`, `<GUID>`, `<GUID>`.

O tempo cresce muito mais do que o número de projetos (10 → 0,6 s; 25 → 7,9 s), o que sugere cálculo do avanço feito projeto a projeto (N+1) ou um tempo limite interno estourando e virando 500.

O Omni já contorna lendo em páginas de 10, mas o endpoint precisa funcionar com o `limit` que ele mesmo aceita.

## Pedido

1. **Achar a causa** pelos `requestId` acima e corrigir: o cálculo do avanço da coleção deve carregar as fontes em lote por página (como já é feito em `/acompanhamento/projetos/semanas` e `/acompanhamento/projetos/custos`), sem uma consulta por projeto.
2. **Tempo limite:** se a consulta ainda passar do limite, responder com o erro de tempo limite já usado na API (`REQUEST_TIMEOUT`, como em `/acompanhamento/projetos/custos`), nunca `500 INTERNAL_ERROR`.
3. **Paridade:** os valores de `progressPercent` e `progressMethod` da coleção continuam iguais aos do status individual e aos de `/acompanhamento/projetos/custos` (`avancoFisico`), como diz o contrato do avanço unificado.
4. **Teste de regressão:** a coleção com `limit=100` e ~90 projetos responde 200 e dentro do tempo que vocês definirem como meta (sugestão: < 5 s); teste de consultas em lote (sem N+1), como os da B6.

## Entrega

- Correção com testes e `npm run architecture:check`.
- Relatório curto: causa, o que mudou e o tempo medido com 100 por página.

Depois disso, o Omni pode voltar a pedir páginas de 100 (`packages/integrations/src/filtroapp/client.ts`, `listStatus`).

---

## Retorno — conferido no Omni em 05/11/2026 (produção)

- **Corrigido:** `limit=100` (com e sem `active=true`) responde **200**, sem mais 500. O avanço da coleção bate com o que o Omni tem nos 39 projetos ativos. O Omni voltou a ler em páginas de 100.
- **Tempo:** a coleção inteira (84 projetos) leva **~5,5 s** em uma página, contra ~16 s em páginas de 10 — ainda acima da meta de 5 s do relatório, mas não por N+1: o status individual da **missão 5719 (Itaporã)** sozinho leva **~4,4 s**, enquanto a mediana dos outros 84 é **0,11 s** (o segundo mais lento, 5775, leva 0,86 s). Os dois têm avanço por RDO.
- **Pedido opcional:** investigar por que o cálculo do avanço/gates da 5719 é tão mais caro (volume de RDOs e serviços? correções? histórico importado?) e, se possível, otimizar só esse caminho. Não bloqueia o Omni.
