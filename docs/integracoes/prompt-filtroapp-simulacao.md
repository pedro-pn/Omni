# Prompt para o Claude Code no filtroAPP — modo de simulação para todas as escritas da API

> Cole o texto abaixo (a partir de "Contexto") numa sessão do Claude Code aberta em `filtroAPP-main`.
> Escrito em 29/10/2026. Do lado do Omni já está pronto: toda escrita passa por `FILTROAPP_ESCRITA` (`desligada` | `simulada` | `real`), e o cliente só aceita uma simulação **confirmada** pelo filtroAPP.

---

## Contexto

O Omni (`../omni`) é desenvolvido e testado contra a **produção** do filtroAPP, porque a homologação mascara e-mails, nomes e CNPJs, e o Omni depende deles para ligar pessoas e validar responsáveis. Durante os testes, **nada pode ser gravado na produção**, mas as escritas precisam ser exercitadas de verdade: autorização, recorte de projetos, regras de negócio e responsáveis.

A solução é um **modo de simulação para toda rota de escrita** da API de integrações (`/api/integracoes/v1`): o filtroAPP executa tudo como numa escrita real e **desfaz no fim**, devolvendo o que teria acontecido.

Hoje são 5 rotas de escrita; **todas** entram nesta entrega:

| Rota | Operação | Quem usa |
|---|---|---|
| `POST /qualidade/registros` | `quality.records.create` | Omni |
| `POST /acompanhamento/oportunidades` | `acompanhamento.opportunities.post` | Prisma CRM |
| `POST /efetivo/projetos` | `efetivo.projects.create` | Prisma CRM |
| `POST /efetivo/projetos/:id/fatos-comerciais` | `efetivo.projects.commercialFacts…` | Prisma CRM |
| `POST /efetivo/projetos/:id/documentos` | `efetivo.projects.document.post` | Prisma CRM |

Qualquer rota de escrita **futura** (ex.: confirmação de descarga, spec 034 US5) nasce com a simulação.

Leia `CLAUDE.md`, `docs/PADRAO_MODULO.md`, `docs/API_INTEGRACOES.md` e as specs 015, 033 e 034. Crie a spec `specs/0NN-api-simulacao-escritas/` (`spec.md`, `plan.md`, `tasks.md`, `contracts/`) antes de codar. **Mudança aditiva**: o comportamento atual das escritas reais (Prisma) não muda.

## Contrato

### Como pedir

| Item | Regra |
|---|---|
| Por requisição | Cabeçalho `Prefer: validate-only` em qualquer rota de escrita |
| Por credencial | Campo novo na credencial: `writeMode` = `LIVE` (padrão, comportamento atual) ou `SIMULATE`. Com `SIMULATE`, **toda** escrita dessa credencial é simulada, **mesmo sem o cabeçalho** (falha fechada). Editável em Administração → Tokens de API e visível na listagem |
| Escopos | A simulação exige os **mesmos escopos** da escrita real (ex.: `qualidade.registros.create`). Assim o teste também valida as permissões |

### O que acontece numa simulação

1. **Mesma execução da escrita real:** autenticação, escopos, recorte de projetos, cotas e limites, validação do corpo, regras de negócio, resolução de responsáveis (ex.: `actionOwnerEmail` → `User`), checagem de idempotência e cálculo dos campos derivados.
2. **Tudo dentro de uma transação desfeita no fim** (rollback), inclusive numeração (`QualityRecordSeq`), feed de eventos (`/eventos`), `NotificationEvent` e auditoria de domínio.
3. **Zero efeitos fora da transação.** Para cada rota, listar e garantir:
   - nenhum e-mail enviado;
   - nenhum arquivo gravado ou movido;
   - nenhum job enfileirado nem tarefa agendada;
   - nenhuma chamada externa (Omie, ComercialAPP, ZapSign, Prisma);
   - nenhum cache invalidado de forma visível;
   - nenhum efeito "pós-commit" disparado.
4. **Idempotência:**
   - a simulação **não grava** a `Idempotency-Key`. Uma escrita real depois, com a mesma chave, precisa criar o registro de verdade, e não devolver a resposta simulada;
   - a simulação **checa** conflito com chaves reais já existentes: mesma chave com corpo diferente → `409`, como na real.
5. **Rastreabilidade:** a requisição fica no log da API (`ApiRequestLog`) com a marca `simulated = true`. Esse registro fica **fora** da transação desfeita.

### Resposta

| Situação | Resposta |
|---|---|
| Simulação aceita | **HTTP 200** (nunca 201), cabeçalho `Preference-Applied: validate-only` e corpo `{ "simulated": true, "operation": "…", "would": { … }, "warnings": [], "requestId": "…" }` |
| Erros | Os mesmos códigos e corpos da escrita real (400, 403, 404, 409, 422, 429), também com `Preference-Applied: validate-only` |
| Escrita real | Exatamente como hoje, **sem** `Preference-Applied` e sem `simulated` |

`would` traz os campos que seriam gravados, por exemplo para a Qualidade: `type`, `status: "EM_TRIAGEM"`, `projectCode`, `actionOwnerUserId`, `eventDate`. Não traz IDs nem números definitivos; quando der para calcular sem consumir, use `previewNumber`.

O Omni trata como **erro grave** uma resposta sem a confirmação dupla (cabeçalho + `simulated: true`) quando pediu simulação. Então nunca responda a uma simulação sem ela.

## Garantia estrutural (para não depender de lembrar)

- O registro de operações da API passa a declarar, para cada rota de escrita, o suporte à simulação.
- `npm run architecture:check` **falha** se existir rota de escrita em `/integracoes/v1` sem simulação declarada e sem teste.
- **Teste genérico**, rodando para cada rota de escrita:
  - contar as linhas de todas as tabelas que a rota pode afetar (inclusive feed de eventos, `NotificationEvent`, sequências e chaves de idempotência) antes e depois de uma simulação aceita: devem ser **iguais**;
  - a mesma chamada sem simulação continua gravando como hoje;
  - credencial `SIMULATE` sem o cabeçalho também simula.
- Testes específicos da Qualidade:
  - simulação com e-mail de responsável inexistente → `422`;
  - simulação seguida de escrita real com a **mesma chave** → a real cria o registro;
  - nenhum número `D-xxx/aa` é consumido.

## Documentação e painel

- `docs/API_INTEGRACOES.md`: seção "Simulação de escritas", com exemplos `curl` fictícios.
- OpenAPI: cabeçalho `Prefer`, resposta 200 simulada e `Preference-Applied` em todas as operações de escrita.
- Playground: escritas **simuladas por padrão**, com aviso claro para trocar para real.
- Tokens de API: mostrar `writeMode` e permitir trocar; a troca vai para a auditoria da credencial.

## Entrega

- Spec, plano e tarefas; contratos atualizados.
- `writeMode` disponível. O token "Omni – desenvolvimento" deve poder ficar `SIMULATE` **e** receber `qualidade.registros.create`.
- Relatório final com:
  - a lista de efeitos colaterais verificados por rota;
  - os testes adicionados;
  - exemplos de resposta simulada fictícios;
  - qualquer rota em que a simulação não pôde ser completa, com o motivo. Nesse caso, ela **recusa** a simulação com `501 SIMULATION_NOT_SUPPORTED` em vez de gravar.
