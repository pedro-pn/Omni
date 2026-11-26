#!/bin/sh
# Publicação repetível do Omni na VPS, com conferência depois e volta automática (pilar 3.4).
#
# Uso, na pasta do repositório na VPS:
#   deploy/publicar.sh staging                 # publica origin/master no staging
#   deploy/publicar.sh producao                # publica origin/master na produção
#   deploy/publicar.sh producao <commit>       # publica um commit específico (ex.: voltar versão)
#   deploy/publicar.sh producao --sem-backup   # pula a cópia local do banco (só em emergência)
#   OMNI_DIR=~/apps/Omni sh /tmp/publicar.sh producao   # rodando de uma cópia do script
#
# Passos: confere a árvore limpa → backup do banco → guarda as imagens atuais → leva o código ao
# commit pedido → build com a versão → migrations → web e worker → confere /api/saude (status ok e
# versão nova). Se a conferência falhar, volta o código e as imagens anteriores e sai com erro.
# As migrations só avançam: se a versão nova aplicou migration, a volta avisa e o banco precisa ser
# restaurado do backup feito no passo 2 (docs/producao/deploy.md, "Voltar uma versão").
set -eu

AMBIENTE="${1:?ambiente: staging ou producao}"
shift
ALVO="origin/master"
BACKUP=sim
for arg in "$@"; do
  case "$arg" in
    --sem-backup) BACKUP=nao ;;
    *) ALVO="$arg" ;;
  esac
done

case "$AMBIENTE" in
  staging) PROJETO=omni-staging; ENVFILE=deploy/.env.staging; PORTA_PADRAO=8085 ;;
  producao) PROJETO=omni; ENVFILE=deploy/.env.production; PORTA_PADRAO=8084 ;;
  *) echo "ambiente desconhecido: $AMBIENTE (use staging ou producao)" >&2; exit 2 ;;
esac

# OMNI_DIR: pasta do repositório, para rodar o script de uma cópia (ex.: a primeira publicação,
# quando a pasta ainda está num commit sem o script).
cd "${OMNI_DIR:-$(dirname "$0")/..}"
[ -f "$ENVFILE" ] || { echo "faltando $ENVFILE" >&2; exit 2; }
# Um ambiente por pasta (E07): publicar troca o commit da pasta, então produção e staging na mesma
# pasta se atropelam. Produção em ~/apps/Omni (só .env.production), staging em ~/apps/Omni-staging
# (só .env.staging).
case "$AMBIENTE" in
  staging) OUTRO=deploy/.env.production ;;
  producao) OUTRO=deploy/.env.staging ;;
esac
if [ -f "$OUTRO" ]; then
  echo "esta pasta também tem $OUTRO: produção e staging precisam de pastas separadas" >&2
  echo "(produção em ~/apps/Omni, staging em ~/apps/Omni-staging; docs/producao/deploy.md, seção 3.3)" >&2
  exit 2
fi
PORTA="$(grep -E '^OMNI_WEB_PORT=' "$ENVFILE" | cut -d= -f2 || true)"
PORTA="${PORTA:-$PORTA_PADRAO}"
SAUDE="http://172.17.0.1:${PORTA}/api/saude"
COMPOSE="docker compose -p ${PROJETO} -f deploy/docker-compose.prod.yml --env-file ${ENVFILE}"
REGISTRO="${HOME}/omni-publicacoes.log"

registrar() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${AMBIENTE} $*" | tee -a "$REGISTRO"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "há mudanças locais no repositório da VPS; publique só o que está no Git" >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

ANTERIOR="$(git rev-parse HEAD)"
git fetch --quiet origin
NOVO="$(git rev-parse "${ALVO}^{commit}")"
CURTO_ANT="$(echo "$ANTERIOR" | cut -c1-7)"
CURTO_NOVO="$(echo "$NOVO" | cut -c1-7)"
registrar "início ${CURTO_ANT} → ${CURTO_NOVO}"

# 2. Backup antes de qualquer migration.
if [ "$BACKUP" = sim ]; then
  sh deploy/backup.sh "$PROJETO" "$ENVFILE" >/dev/null || { registrar "falhou: backup"; exit 1; }
fi

# 3. Guarda as imagens em uso para poder voltar sem rebuild.
for s in web worker migrate; do
  docker image inspect "${PROJETO}-${s}:latest" >/dev/null 2>&1 && docker tag "${PROJETO}-${s}:latest" "${PROJETO}-${s}:${CURTO_ANT}"
done
MIG_ANTES="$($COMPOSE exec -T postgres psql -U postgres -d omni -Atc 'SELECT count(*) FROM schema_migrations' 2>/dev/null || echo '?')"

voltar() {
  registrar "conferência falhou em ${CURTO_NOVO}; voltando para ${CURTO_ANT}"
  git checkout --quiet --detach "$ANTERIOR"
  for s in web worker migrate; do
    docker image inspect "${PROJETO}-${s}:${CURTO_ANT}" >/dev/null 2>&1 && docker tag "${PROJETO}-${s}:${CURTO_ANT}" "${PROJETO}-${s}:latest"
  done
  OMNI_VERSAO="$ANTERIOR" $COMPOSE up -d --no-build --wait web worker || true
  MIG_DEPOIS="$($COMPOSE exec -T postgres psql -U postgres -d omni -Atc 'SELECT count(*) FROM schema_migrations' 2>/dev/null || echo '?')"
  if [ "$MIG_ANTES" != "$MIG_DEPOIS" ]; then
    registrar "ATENÇÃO: a versão nova aplicou migration (${MIG_ANTES} → ${MIG_DEPOIS}); restaure o backup de antes do deploy"
  fi
  registrar "voltou para ${CURTO_ANT}"
  exit 1
}

# 4–6. Código, build com a versão, migrations e serviços.
git checkout --quiet --detach "$NOVO"
export OMNI_VERSAO="$NOVO"
if ! $COMPOSE build migrate web worker; then registrar "falhou: build"; git checkout --quiet --detach "$ANTERIOR"; exit 1; fi
$COMPOSE up -d --wait || voltar

# 7. Conferência: a versão nova responde e o banco está ok.
i=0
while [ $i -lt 30 ]; do
  RESP="$(wget -qO- "$SAUDE" 2>/dev/null || true)"
  case "$RESP" in
    *'"status":"ok"'*"\"versao\":\"${NOVO}\""*) registrar "publicado ${CURTO_NOVO} (saúde ok)"; exit 0 ;;
  esac
  i=$((i + 1))
  sleep 2
done
voltar
