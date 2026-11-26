# Desempenho: tempo por rota e consultas lentas

Entrega E19 (pilar 11.1). A regra é medir antes de otimizar: mexe-se no que a medição apontar, não no
que parece lento. Os números ficam em **Administração → Desempenho**, só para quem tem o perfil admin.

## O que é medido

**Tempo por rota e por ação**
- O web mede cada página, cada rota de `/api` e cada ação (server function, pelo nome).
- Cada rota é guardada com os identificadores trocados: uuid vira `:id`, número vira `:n`, e token,
  e-mail ou nome de arquivo vira `:x`.
- O tempo vai até a resposta começar. Downloads e arquivos em fluxo não contam o envio do corpo.
- Ficam de fora os arquivos estáticos e o fluxo de eventos `/api/eventos`, uma conexão que fica aberta.
- **Como grava:** soma em memória e grava a cada minuto em `desempenho_rotas`, por hora (migration
  0084). Guarda a quantidade, a soma, o máximo, os erros (5xx ou erro inesperado da ação) e a contagem
  por faixa de tempo: até 50, 100, 250, 500, 1000, 2500 e 5000 ms, e acima.
- **Na tela:** o p95 é aproximado pela faixa. A tela mostra 1 hora, 24 horas ou 7 dias, e os dados
  ficam guardados por 90 dias.
- **Sem dados pessoais:** nada de usuário, parâmetro ou corpo da requisição.
- **Código:** `packages/core/src/desempenho.ts`, `apps/web/src/server/desempenho.ts`, a entrada
  `apps/web/src/server.ts` e o middleware de `apps/web/src/start.ts`.

**Consultas lentas no banco**
- O `pg_stat_statements` do Postgres guarda cada consulta **normalizada**, com os valores trocados por
  `$1`, `$2`…
- A tela mostra as 15 de maior tempo médio com pelo menos 5 chamadas (`app.consultas_lentas`).
- Toda consulta acima de **500 ms** também vai para o log do Postgres, **sem os parâmetros**
  (`log_parameter_max_length=0`), porque eles podem ter dado pessoal.
- As duas configurações estão no `command` do serviço `postgres` em `deploy/docker-compose.prod.yml`.

## Ligar num banco que já existe (produção e staging, uma vez)

Banco novo já nasce pronto: o `deploy/postgres/init/01-roles.sh` cria a extensão. No banco que já
existe:

1. Publique a versão com a E19 (`deploy/publicar.sh producao`). O `up` recria o contêiner do Postgres
   para carregar a biblioteca, uma parada de poucos segundos; o web e o worker reconectam sozinhos.
2. Crie a extensão e dê ao dono a leitura das estatísticas. Precisa do superusuário do contêiner:

```bash
docker exec omni-postgres-1 psql -U postgres -d omni -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; GRANT pg_read_all_stats TO omni_owner;"
# staging: omni-staging-postgres-1
```

3. Confira em Administração → Desempenho. A seção "Consultas mais lentas" deixa de mostrar o aviso.

## Consultas do dia a dia

```bash
# Consultas que passaram de 500 ms (só o comando, sem valores)
docker logs --since 24h omni-postgres-1 2>&1 | grep 'duration:'
# Zerar a estatística depois de uma otimização, para medir de novo do zero
docker exec omni-postgres-1 psql -U postgres -d omni -c "SELECT pg_stat_statements_reset();"
```

## Como usar a medição

1. Ordene pela coluna p95 (a tela já vem assim) e olhe o **tempo total**. Uma rota de 300 ms chamada
   10 mil vezes pesa mais que uma de 3 s chamada duas vezes.
2. Na rota lenta, veja quais consultas ela faz e procure essas consultas na seção do banco.
3. Rode `EXPLAIN (ANALYZE, BUFFERS)` na consulta, num banco com volume parecido: o `npm run carga`
   (`docs/producao/carga.md`) monta esse volume. Procure varredura sequencial em tabela grande, que
   costuma pedir índice (pilar 11.3), e função chamada por linha (a regra da 0072).
4. Depois da correção, zere a estatística e compare na semana seguinte.
