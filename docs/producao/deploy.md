# Deploy do Omni na VPS: staging e produção

> Escrito em 05/11/2026 e ensaiado localmente com o mesmo compose e as mesmas imagens: banco, 32 migrations, web saudável, worker rodando os jobs, primeiro administrador e backup. O staging é `omnistaging.filtrovali.com.br`; a produção, `omni.filtrovali.com.br`.
> Checklist do que **não** pode faltar antes da produção (Foco, e-mails, WhatsApp, LGPD): `entrada-em-producao.md`.

## 1. Como fica na VPS

```
Internet ──443──► infra-proxy-caddy (filtroAPP-main/deploy/infra-proxy, TLS automático)
                     │  omnistaging.filtrovali.com.br → host.docker.internal:8085
                     │  omni.filtrovali.com.br        → host.docker.internal:8084 (depois)
                     ▼
              172.17.0.1:8085 ── web (Omni) ── rede interna ── postgres (só interno)
                                   worker ────┘           └── migrate (roda e sai)
                                   [perfil whatsapp] evolution ── evolution-postgres / evolution-redis (rede isolada)
```

- **Um compose para os dois ambientes:** `deploy/docker-compose.prod.yml`. Cada ambiente é um *projeto* do compose (`-p omni-staging` e `-p omni`), com volumes, rede e banco próprios, e um arquivo de variáveis próprio (`deploy/.env.staging`, `deploy/.env.production`).
- **Nada do Omni fica exposto na internet** além do que o Caddy encaminha: o web publica só em `172.17.0.1:<porta>`; o banco e a Evolution não publicam porta.
- **Portas na VPS:** 8081 filtroboard, 8082 Evolution do Prisma, 8083 ComercialAPP, **8084 Omni produção**, **8085 Omni staging**, **8086 áudio das chamadas (produção)**, **8087 áudio das chamadas (staging)**.

### Staging x produção: o que muda

`OMNI_AMBIENTE=staging` roda o mesmo build de produção, mas **com as travas de fora da produção** (recusadas na validação do ambiente, com testes): nada real sai para o filtroAPP (só `simulada`), o Prisma fica no sandbox, e-mail e WhatsApp em ensaio, sem login de desenvolvimento. A tela mostra a marca **STAGING** no trilho.

| | Staging | Produção |
|---|---|---|
| Domínio / porta | `omnistaging.filtrovali.com.br` / 8085 | `omni.filtrovali.com.br` / 8084 |
| Projeto do compose / arquivo | `omni-staging` / `deploy/.env.staging` | `omni` / `deploy/.env.production` |
| filtroAPP | lê produção; escrita `simulada` | `real` (depois de conferir os escopos) |
| Prisma | `sandbox` | `production` (depois da homologação) |
| E-mail / WhatsApp | ensaio | `real` (depois do comunicado ao time) |
| Segredos, VAPID, Evolution | **próprios do staging** | **próprios da produção** (nunca reaproveitar) |

## 2. O que o staging destrava

| Pendência | Por que depende do servidor | Como testar no staging |
|---|---|---|
| Login Microsoft no domínio real | URI de retorno HTTPS registrada no Entra | §3.2 e §5 |
| App instalável e notificações no **celular** | Celular só aceita push e instalação com HTTPS | Android (Chrome) e iPhone (Safari, Omni na Tela de Início): menu do perfil → Notificações e app → teste |
| WhatsApp na Evolution do servidor | Evolution precisa ficar no ar 24 h, junto do Omni | Perfil `whatsapp` (§6); parear o **chip de teste** e importar o histórico dos grupos |
| E-mails, SharePoint e Teams | Funcionam com o mesmo app do Entra; o certificado precisa estar no servidor | Aba E-mails/Arquivos/Reuniões de uma missão |
| IA (leitura dos RDOs, alertas, resumo de reuniões) | Worker rodando sempre, no horário útil | `@IA` num Interno; perguntas às 07:00 |
| Migração dos dados do Foco | Ensaio da carga antes do corte | Quando o script da migração existir (Fase 3, pendente) |
| Prisma: conexão individual (PKCE) | O Prisma precisa aceitar a URI de retorno do staging | Pedir ao Prisma para liberar `https://omnistaging.filtrovali.com.br/integracoes/prisma/retorno` no sandbox |

Só na produção: envio real de e-mail e WhatsApp, escrita real no filtroAPP, Prisma de produção e o corte do Foco.

## 3. Antes de subir (uma vez)

### 3.1 VPS

```bash
# Recursos: o staging usa até ~2,5 GB de RAM (web 768 MB, worker 768 MB, Postgres 1 GB) e mais ~1,5 GB com o WhatsApp.
free -h && df -h / /home /var/lib/docker
docker version && docker compose version
docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E '8084|8085' || echo "portas 8084/8085 livres"
ip -4 addr show docker0 | grep 172.17.0.1    # a ponte que o Caddy alcança
```

**Qual Docker usar.** Siga o padrão dos outros apps de setores diferentes (Prisma, ComercialAPP): um usuário Linux próprio (ex.: `omni`) com **Docker rootless**, publicando em `172.17.0.1`. Isso isola o Omni do filtroAPP (o daemon rootless não enxerga os containers do root). Com o Docker root, também funciona igual: o compose não muda.

```bash
# Como root (uma vez): usuário do Omni com linger, para os containers seguirem no ar sem sessão aberta
adduser --disabled-password omni && loginctl enable-linger omni
# Como omni: instalar o Docker rootless (https://docs.docker.com/engine/security/rootless/) e
export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock    # ponha no ~/.profile
```

### 3.2 DNS e Entra

1. **DNS:** registro `A` de `omnistaging` na zona `filtrovali.com.br` apontando para o IP da VPS (o mesmo dos outros apps), **só DNS** (sem proxy da Cloudflare, se houver). Confira com `dig +short omnistaging.filtrovali.com.br` **antes** de mexer no Caddy (§4): domínio sem DNS faz o Caddy queimar tentativas no Let's Encrypt.
2. **Entra (app "Omni", o do login):** Autenticação → Web → adicionar a URI `https://omnistaging.filtrovali.com.br/auth/callback`. O app de integrações ("Omni – Integrações") não muda.

### 3.3 Código e segredos

```bash
# Como omni, na VPS. O repositório é privado: use uma chave de implantação só de leitura no GitHub.
git clone git@github.com:pedro-pn/Omni.git ~/omni && cd ~/omni

# Variáveis do staging a partir do modelo (preencha cada linha; nada disso vai para o Git)
cp deploy/staging.env.example deploy/.env.staging && chmod 600 deploy/.env.staging
# Segredos novos, um por linha (não reaproveite os de desenvolvimento):
for v in POSTGRES_PASSWORD OMNI_OWNER_PASSWORD OMNI_APP_PASSWORD OMNI_WORKER_PASSWORD AUTH_SECRET \
         WHATSAPP_EVOLUTION_KEY WHATSAPP_WEBHOOK_SECRET EVOLUTION_POSTGRES_PASSWORD; do
  sed -i "s|^$v=.*|$v=$(openssl rand -hex 32)|" deploy/.env.staging
done
# Chaves VAPID do staging (notificações): copie as duas para o arquivo
docker run --rm node:24-alpine npx -y web-push@3.6.7 generate-vapid-keys
```

Preencha à mão no `deploy/.env.staging`:

| Variável | De onde vem |
|---|---|
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | App "Omni" do Entra (os mesmos do desenvolvimento, com a URI nova) |
| `FILTROAPP_API_TOKEN` | filtroAPP → Integrações: um token **"Omni – staging"** com os escopos de `docs/integracoes/filtroapp-token.md`. Se o token for restrito por IP, libere o IP da VPS |
| `PRISMA_OMNI_READER_TOKEN` | Credencial `reader` do **sandbox** do Prisma |
| `GRAPH_*` | App "Omni – Integrações" (IDs e a impressão digital SHA-256 do certificado, como no `.env` de desenvolvimento) |
| `OPENAI_API_KEY` | Organização da OpenAI com retenção zero (ADR 0005) |

**Certificados (Graph e, se usar certificado no login, Entra):** copie as chaves privadas para `deploy/secrets/` (fora do Git; `secrets/` está no `.gitignore`). A pasta aparece dentro dos contêineres como `/run/secrets/omni`, e o web e o worker rodam como o usuário 1000 do contêiner. Por isso:

- nas variáveis, use sempre o caminho **de dentro do contêiner**: `GRAPH_PRIVATE_KEY_PATH=/run/secrets/omni/omni-graph.key` e `ENTRA_PRIVATE_KEY_PATH=/run/secrets/omni/omni-entra.key` (nunca `./secrets/…`);
- o usuário 1000 do contêiner precisa **atravessar a pasta** e **ler os arquivos**.

```bash
mkdir -p deploy/secrets
scp ~/.secrets/omni-graph.key vps:~/omni/deploy/secrets/      # da sua máquina

# Docker rootless (padrão desta VPS): o usuário 1000 do contêiner vira um subuid do host, sem
# relação com o usuário omni. A pasta precisa de 711 (atravessar, sem listar) e as chaves de 644.
# Continua fechado para as outras pessoas da VPS porque o home do omni é 750.
chmod 711 deploy/secrets
chmod 644 deploy/secrets/*.key
# NÃO use 700 na pasta: o web falha com EACCES em /run/secrets/omni/… e o login Microsoft dá erro 500.

# Docker root: a pasta pode ficar 700 se for do usuário 1000.
# chown -R 1000:1000 deploy/secrets && chmod 700 deploy/secrets && chmod 400 deploy/secrets/*.key
```

Conferir depois de subir (deve listar as chaves e dizer `legivel`):

```bash
docker compose -p omni -f deploy/docker-compose.prod.yml --env-file deploy/.env.production exec -T web \
  sh -c 'for f in /run/secrets/omni/*.key; do test -r "$f" && echo "$f legivel" || echo "$f NAO legivel"; done'
```

## 4. Subir o staging

```bash
cd ~/omni
alias omni-stg='docker compose -p omni-staging -f deploy/docker-compose.prod.yml --env-file deploy/.env.staging'

omni-stg config -q                         # valida o compose e as variáveis obrigatórias
omni-stg up -d --build --wait              # banco → migrations → web e worker
omni-stg ps
omni-stg logs migrate | tail -2            # "NN aplicada(s)"
omni-stg logs worker | grep '\[worker\]'   # o que está ligado ou desligado
curl -s http://172.17.0.1:8085/api/saude   # {"status":"ok","banco":"ok"}

# Primeiro administrador (o resto pela Administração do Omni)
omni-stg run --rm migrate node_modules/.bin/tsx packages/db/src/cli/primeiro-admin.ts voce@filtrovali.com.br "Seu Nome"
```

### 4.1 Caddy (proxy compartilhado; como root)

O bloco pronto está em `deploy/caddy/omni.caddy`. Siga o RUNBOOK do `infra-proxy`: edite o **Caddyfile persistente**, preserve todas as rotas existentes e valide antes de recarregar.

```bash
cd /caminho/do/filtroAPP-main/deploy/infra-proxy
cp Caddyfile Caddyfile.antes-omnistaging
# Acrescente ao final o bloco "omnistaging.filtrovali.com.br { … }" de ~omni/deploy/caddy/omni.caddy
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.8-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec infra-proxy-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
docker logs --since 2m infra-proxy-caddy 2>&1 | grep -i omnistaging    # "certificate obtained successfully"
```

**Firewall (ufw):** o Caddy roda na rede Docker do proxy (`172.20.0.0/16`, ponte `br-c2f4434f4e13` em 11/11/2026) e chega ao Omni por `172.17.0.1`. Cada porta do Omni precisa de uma regra só para essa rede, no mesmo formato das outras apps (como root):

```bash
# Confira o nome da ponte e a faixa do proxy nas regras existentes: sudo ufw status | grep 172.17.0.1
sudo ufw allow in on br-c2f4434f4e13 from 172.20.0.0/16 to 172.17.0.1 port 8085 proto tcp comment 'Caddy -> Omni staging'
sudo ufw allow in on br-c2f4434f4e13 from 172.20.0.0/16 to 172.17.0.1 port 8087 proto tcp comment 'Caddy -> Omni staging audio'   # com as chamadas
# Produção:
sudo ufw allow in on br-c2f4434f4e13 from 172.20.0.0/16 to 172.17.0.1 port 8084 proto tcp comment 'Caddy -> Omni web'
sudo ufw allow in on br-c2f4434f4e13 from 172.20.0.0/16 to 172.17.0.1 port 8086 proto tcp comment 'Caddy -> Omni audio'           # com as chamadas
# O Caddy alcança o Omni? (deve dar HTTP/1.1 200)
docker exec infra-proxy-caddy wget -qO- -S http://host.docker.internal:8084/entrar 2>&1 | head -1
```

Nenhuma dessas portas é aberta para a internet: só a rede do proxy chega a elas.

Depois, **versione a mudança no repositório do filtroAPP** (`deploy/infra-proxy/Caddyfile`): uma rota só na configuração em memória some quando o proxy reinicia (RUNBOOK, "Verificação").

## 5. Conferir

```bash
curl -sSI https://omnistaging.filtrovali.com.br/entrar | head -1          # HTTP/2 200
curl -s https://omnistaging.filtrovali.com.br/api/saude                    # {"status":"ok","banco":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://omnistaging.filtrovali.com.br/auth/dev   # 404 (sem login de desenvolvimento)
```

No navegador: entrar pela Microsoft (aparece a marca **STAGING**), abrir uma missão, mandar uma mensagem no Interno, Administração → Caixas de e-mail. No celular: abrir o endereço, instalar o app, ativar as notificações e "Enviar notificação de teste".

## 6. WhatsApp no staging (perfil `whatsapp`)

```bash
omni-stg --profile whatsapp up -d --build --wait     # Evolution do Omni: imagem com o patch, banco e Redis próprios
omni-stg --profile whatsapp ps
docker ps --format '{{.Names}}\t{{.Ports}}' | grep evolution   # nenhuma porta publicada
```

Depois: entre com a conta dona do número de teste, abra **Conversas** e leia o QR code (nunca um número que esteja no Prisma). Detalhes: `docs/integracoes/whatsapp-evolution.md`.

**Chamadas no staging** (perfil `chamadas`, junto do `whatsapp`; variáveis no fim de `deploy/staging.env.example`, com `CHAMADA_MODO=teste` e a lista dos números da equipe):

```bash
omni-stg --profile whatsapp --profile chamadas up -d --build --wait
curl -s -o /dev/null -w '%{http_code}\n' http://172.17.0.1:8087/internal/control   # 404: a API interna não sai pela porta do áudio
```

## 7. Operação

```bash
# Atualizar para a versão nova: backup, build com a versão, migrations, conferência de /api/saude
# e volta automática se a versão nova não responder (registro em ~/omni-publicacoes.log)
deploy/publicar.sh staging            # ou: deploy/publicar.sh producao
# Antes de publicar, o script faz uma cópia local do banco em ~/backups/<projeto> (deploy/backup.sh).

# Logs, reiniciar, parar
omni-stg logs -f --tail 100 web worker
omni-stg restart worker
omni-stg stop                     # para sem apagar nada;  "down -v" APAGA o banco — só para descartar o ambiente

# Cópia local do banco na hora (a mesma que o publicar.sh faz), em ~/backups/omni-staging
deploy/backup.sh omni-staging deploy/.env.staging
# Backup para fora da VPS (B2, horário/diário/mensal) e ensaio de restauração: docs/producao/backup.md

# Restaurar um backup (com o web e o worker parados)
omni-stg stop web worker
omni-stg exec -T postgres pg_restore -U postgres -d omni --clean --if-exists < ~/backups/omni-staging/omni-AAAAMMDD-HHMM.dump
omni-stg up -d --wait
```

**Voltar uma versão:** `deploy/publicar.sh <ambiente> <commit anterior>` (mesma conferência). Se a conferência de uma publicação falha, o script já volta sozinho o código e as imagens anteriores. As migrations só avançam: se a versão nova aplicou migration, o registro avisa e o banco precisa ser restaurado do backup feito no início da publicação. O repositório da VPS fica no commit publicado (HEAD destacado); não use `git pull` nele.

**Conferir a versão no ar:** `curl -s https://<domínio>/api/saude` → `{"status":"ok","banco":"ok","versao":"<commit>"}`.

## 8. Produção (depois)

Os mesmos passos, trocando:

- projeto `-p omni`, arquivo `deploy/.env.production` (a partir de `deploy/production.env.example`; lista completa em `guia-producao.md`), `OMNI_AMBIENTE=producao`, `APP_ORIGIN=https://omni.filtrovali.com.br`, `OMNI_WEB_PORT=8084`, `WEB_PUSH_SUBJECT=https://omni.filtrovali.com.br`;
- **todos os segredos novos** (banco, `AUTH_SECRET`, VAPID, Evolution), token do filtroAPP "Omni – produção";
- URI `https://omni.filtrovali.com.br/auth/callback` no Entra e o bloco `omni.filtrovali.com.br` do Caddy;
- modos reais só quando o checklist liberar (`entrada-em-producao.md`).

Quando a produção estiver no ar, **desligue no staging** o que repete trabalho com efeito fora do Omni (WhatsApp do staging, `IA_*`) ou pare o staging (`omni-stg stop`).
