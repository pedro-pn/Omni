# Teste de carga

> Fase 11 — 24/11/2026. `npm run carga` (script em `apps/web/scripts/carga.ts`).

Roda, no banco de **teste** (`omni_test`), as consultas mais pesadas da tela com o volume de
uma empresa inteira e várias pessoas ao mesmo tempo, sempre pelo papel da tela (`omni_app`,
com RLS), como o servidor faz. Cria dados fictícios (`@carga.invalid`) e apaga no fim.

```bash
npm run db:up                                   # Postgres local
npm run carga                                   # 20 pessoas × 10 rodadas, limite p95 500 ms
CARGA_PESSOAS=40 CARGA_RODADAS=20 npm run carga # mais pressão
CARGA_MANTER=1 npm run carga                    # deixa os dados (para EXPLAIN); apague com CARGA_LIMPAR=<tag>
CARGA_DETALHE=1 npm run carga                   # mostra as etapas lentas da criação dos dados
```

Volume: 50 mil cabeçalhos de e-mail (2 mil correspondentes), 2 mil conversas de WhatsApp com
200 mil mensagens, 200 missões com 40 mil mensagens nos canais. Sai com código 1 se o p95 de
alguma consulta passar do limite.

## Resultado (24/11/2026, notebook de desenvolvimento, WSL + Docker)

p95 com 20 pessoas ao mesmo tempo:

| Consulta | Antes | Depois | O que mudou |
|---|---|---|---|
| Conversas do WhatsApp (até 2.000) | 2,9 s | 0,38 s | quem vê a conversa em conjunto (`app.conversas_que_vejo`); responder/ligar uma vez por número |
| Correspondentes de e-mail (caixa única) | 21 s | 0,10 s | resumo por correspondente mantido por gatilho (`mail_correspondents`, 0073) |
| Missões com novidade | 10 s | 0,38 s | `app.novidades_dos_canais`: acesso calculado uma vez por canal |
| Lista de missões (quem não é gestão) | 2 s | 0,05 s | quem vê a missão em conjunto (`app.missoes_que_vejo`) nas políticas |
| Mensagens de uma conversa | 0,13 s | 0,04 s | (a política das mensagens também em conjunto) |
| E-mails de um contato | 0,17 s | 0,16 s | — |

A causa comum: as políticas de acesso chamavam funções **por linha** (`app.ve_missao`,
`app.ve_conversa_whatsapp`, `app.canal_desde`). A migration 0072 troca por conjuntos
calculados uma vez por consulta, com a mesma regra — `packages/db/src/desempenho-rls.test.ts`
confere que as duas formas dão o mesmo resultado para cada tipo de vínculo.

## Quando rodar

- Antes de entrar em produção com mais pessoas e depois de mexer em políticas de acesso (RLS),
  nas consultas da caixa única, das conversas ou das missões.
- Ao criar política nova: prefira `coluna IN (SELECT app.<conjunto>())` a uma função por linha.
