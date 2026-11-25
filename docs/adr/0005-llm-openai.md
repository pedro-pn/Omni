# ADR 0005 — LLM da IA v2: API da OpenAI (GPT)

- **Data:** 03/11/2026 · **Situação:** aceita (decisão do Otávio) · substitui a escolha da Claude API no PLANEJAMENTO.md §5

## Contexto
A Fase 8 (IA v2) usa um LLM só para texto livre: ler RDOs, interpretar `@IA`/`/alerta`, detectar "chegamos", extrair nome e cargo, resumir chamadas. Os fluxos por botão (Fase 5) continuam sem LLM. O filtroAPP já usa a OpenAI ("Adequar texto").

## Decisão
- Provedor: **API da OpenAI** (GPT), pela **Responses API em chamada HTTP direta** (sem SDK; `packages/integrations/src/openai`), com saída estruturada (JSON Schema estrito) e `store: false`.
- Modelo por variável de ambiente (`OPENAI_MODEL`, e um segundo para volume, se fizer sentido), escolhido na implementação e validado pelo conjunto de avaliação; nunca fixo no código.
- O cliente fica em `packages/integrations/openai`, atrás de uma interface do Omni (`Llm`), para trocar de provedor sem mexer nos fluxos.

## Consequências
- **Dados:** pela política da OpenAI, o que entra pela API não é usado para treinar modelos por padrão; vale pedir **Zero Data Retention** para a organização. Enviar só o necessário e registrar metadados em `llm_calls` (modelo, tokens, finalidade, ids), não o texto.
- **LGPD:** a OpenAI entra na ROPA como operadora (no lugar da Anthropic) e precisa de DPA.
- **Segurança:** a chave (`OPENAI_API_KEY`) só no `.env`/VPS, validada com Zod; o que o LLM sugere que **escreve fora do Omni** (desvio no filtroAPP, e-mail, WhatsApp) passa pelo mesmo modo de ensaio das outras integrações e pela confirmação de uma pessoa.

## Modelos (03/11/2026)
Preços oficiais por milhão de tokens (entrada / saída; o lote, sem pressa, custa a metade), em https://developers.openai.com/api/docs/pricing:

| Modelo | Entrada | Saída | Uso no Omni |
|---|---|---|---|
| `gpt-6.1-terra` | US$ 1,00 | US$ 5,00 | **Padrão (`OPENAI_MODEL`)**: ler RDOs, interpretar `@IA`/`/alerta` com ferramentas, resumir chamadas |
| `gpt-6-luna` | US$ 0,10 | US$ 0,50 | **Volume (`OPENAI_MODEL_VOLUME`)**: classificar e-mails e mensagens, detectar "chegamos", extrair nome e cargo |
| `gpt-6.1-sol` | US$ 2,00 | US$ 10,00 | Só se o conjunto de avaliação mostrar que o Terra erra demais |
| `gpt-6-astra` | US$ 10,00 | US$ 50,00 | Não usar (caro para tarefas curtas e estruturadas) |

- A leitura diária dos RDOs não tem pressa: vai pelo **lote** (metade do preço). Estimativa: ~40 RDOs/dia × ~2 mil tokens ≈ centavos de dólar por dia.
- A escolha final é do conjunto de avaliação (casos reais anonimizados), rodado no CI quando o prompt ou o modelo mudar; trocar de modelo é só mudar a variável.

### Resultado de 05/11/2026 (leitura dos RDOs)
- `gpt-6-luna` no conjunto de avaliação (`apps/worker/src/ia/avaliacao-rdos.json`, `npm run ia:avaliar`): **10 de 10** com as instruções `rdo-2026-11-05b` (8 pontos esperados encontrados, nenhum falso alarme). Passa a ser o padrão da leitura dos RDOs (`OPENAI_MODEL=gpt-6-luna`).
- 10 RDOs reais lidos: ~9,6 mil tokens no total (≈ US$ 0,002), ~4 s por RDO.
- `gpt-6.1-terra` não pôde ser avaliado: a OpenAI recusou com `credit_balance_exhausted` (saldo da conta). Avaliar de novo quando houver crédito; só trocar se o conjunto mostrar ganho.
