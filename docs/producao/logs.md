# Logs centralizados e painel de saúde

Entrega E20 (pilares 12.2 e 12.3). Os logs do Omni ficam num lugar só, pesquisáveis e sem dado
sensível. Os números vitais ficam numa tela.

## 1. Logs no Grafana Cloud (o mesmo do filtroAPP)

```
contêineres omni-* e omni-staging-*  ──stdout──▶  Docker rootless do omni (json-file, 5 × 20 MB)
                                                     │ só leitura
                                           docker-socket-proxy (rede interna, sem POST)
                                                     │
                                            Grafana Alloy (máscara)  ──HTTPS──▶  Grafana Cloud (Loki)
```

**Arquivos (`deploy/logs/`)**
- `docker-compose.yml` é o projeto `omni-logs`, separado do app: publicar e voltar versão não recriam
  o agente.
- `config.alloy` descobre os contêineres, coloca os rótulos e mascara os dados.
- `logs.env.example` é o modelo do `deploy/logs/.env`, que fica só na VPS.
- Ele é um projeto à parte do filtroAPP porque o Omni roda no Docker **rootless** do usuário `omni`,
  que o agente do filtroAPP (Docker do root) não enxerga.

**O que vai e o que não vai**
- Vão `web`, `worker`, `postgres`, `migrate` e o próprio agente, da produção e do staging.
- **Não vão** a Evolution (WhatsApp), o Redis dela e o serviço de voz: os logs deles podem trazer
  conteúdo de mensagens e telefones.
  - Eles saem **na descoberta** (`discovery.relabel "so_omni"`). Um `drop` nas `relabel_rules` do
    `loki.source.docker` não descarta a linha: só tira os rótulos, e ela seguiria para o envio.
  - Isso aconteceu na primeira ativação, em 26/11/2026, por cerca de 1 minuto: logs desses
    contêineres chegaram ao Grafana só com `app="omni"` e `host`, já mascarados. A segunda trava, no
    `loki.process`, descarta toda linha sem o rótulo `service`.
- Antes de enviar, o Alloy mascara:

  | Dado | Vira |
  |---|---|
  | E-mail, inclusive o identificador do WhatsApp (`numero@s.whatsapp.net`) | `<email>` |
  | Telefone com DDI 55 | `<telefone>` |
  | CPF formatado | `<cpf>` |
  | Senha em URL de conexão | `<redacted>` |
  | `Bearer …` | `<token>` |
  | Chave da API de tarefas (`foco_live_…`) | `<api-token>` |
  | `token=`, `key=`, `code=`, `state=`, `validationToken=` e outros segredos em URL | `<redacted>` |
  | Linha `DETAIL: parameters:` do Postgres | descartada |

- O teste `apps/web/src/server/logs-mascara.test.ts` lê o `config.alloy` e confere cada máscara com
  linhas de exemplo. Mudou a configuração, o CI confere de novo.

**Rótulos:** `app="omni"`, `env` (`omni-production`, `omni-staging`, `omni-logs`), `service`
(nome no compose), `container`, `stream` e `host`. O `env` é próprio do Omni para que as buscas do
filtroAPP (`env="production"`) não misturem linhas.

### Ativação (na VPS, como `omni`, uma vez)

No Grafana Cloud, crie um token **só do Omni** com o escopo `logs:write`, em **Administration →
Users and access → Cloud access policies**. Use a mesma URL e o mesmo usuário de logs do filtroAPP.

```bash
cd ~/apps/Omni && git pull --ff-only
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock

install -m 600 deploy/logs/logs.env.example deploy/logs/.env
nano deploy/logs/.env        # GRAFANA_LOGS_URL, GRAFANA_LOGS_USER e o token novo do Omni

docker compose -f deploy/logs/docker-compose.yml up -d
docker compose -f deploy/logs/docker-compose.yml ps
docker logs --since 2m omni-logs-alloy-1 2>&1 | grep -E 'level=(error|warn)' || echo "sem erros"
```

**Conferir:** no Grafana, abra **Explore** e escolha a fonte de logs. A busca
`{app="omni", env="omni-production"}` traz as linhas do web, do worker e do Postgres em até um
minuto.

**Rotação local:** o `deploy/docker-compose.prod.yml` limita o log de cada contêiner a 5 arquivos de
20 MB. Ela vale para um contêiner quando ele é recriado, o que acontece na próxima publicação.

### Buscas úteis (LogQL)

| Pergunta | Busca |
|---|---|
| Erros inesperados do web | `{app="omni", env="omni-production", service="web"} \|= "erro inesperado"` |
| Jobs do worker que falharam | `{app="omni", env="omni-production", service="worker"} \|~ "(?i)erro\|error\|falh"` |
| Um job específico | `{app="omni", env="omni-production", service="worker"} \|= "\"job\":\"filtroapp-missoes\""` |
| Consultas lentas do banco | `{app="omni", env="omni-production", service="postgres"} \|= "duration:"` |
| Limite de requisições atingido | `{app="omni", env="omni-production", service="web"} \|= "LimiteExcedido"` |
| Staging | troque `env="omni-production"` por `env="omni-staging"` |

### Segurança e problemas comuns

- Só quem cuida da operação tem acesso ao Grafana Cloud, com 2FA. O agente não acessa o socket do
  Docker: quem acessa é o proxy, só para leitura, numa rede sem saída para a internet.
- **Token vazou:** revogue em Cloud access policies, gere outro, troque no `deploy/logs/.env` e rode
  `docker compose -f deploy/logs/docker-compose.yml up -d --force-recreate alloy`.
- **Problemas comuns:**
  - `401` no log do agente: usuário ou token errado, ou token sem `logs:write`;
  - `404`: a URL não termina em `/loki/api/v1/push`;
  - `connection refused` em `docker-proxy`: o socket do rootless não é o de
    `/run/user/1003/docker.sock`. Defina `OMNI_DOCKER_SOCK` no `.env`.
- **Desligar:** `docker compose -f deploy/logs/docker-compose.yml down`. Os logs locais continuam.

## 2. Painel de saúde: Administração → Saúde

Só para quem tem o perfil admin. Atualiza a cada minuto, com sinal verde, atenção ou problema em cada
bloco (regras em `niveis`, `apps/web/src/components/admin/Saude.tsx`):

| Bloco | De onde vem | Atenção | Problema |
|---|---|---|---|
| Web | medição da E19 (`desempenho_rotas`) e o próprio processo | erros > 1% ou p95 > 1 s em 24 h | erros > 5% ou p95 > 2,5 s |
| Worker | job `saude` (5 min) em `estado_operacao` | — | mais de 15 min sem sinal |
| Backup | job `saude`, dos arquivos de status (`OPERACAO_STATUS=ligado`) | ensaio com mais de 35 dias | execução que falhou ou B2 com mais de 26 h |
| Banco | `app.saude_banco()`: tamanho, conexões, maiores tabelas | conexões > 60% do máximo | > 80% |
| Erros do sistema | `system_errors` sem revisão | algum aberto | — |
| filtroAPP | última leitura das missões | mais de 2 h | — |
| Tarefas automáticas | filas do pg-boss: última com sucesso, falhas em 24 h, fila | falha ou fila > 50 | — |

Os alertas que chegam a alguém continuam sendo os da E09 (sino e celular de quem é admin). O painel
serve para ver tudo de uma vez, e o Grafana para investigar.
