#!/usr/bin/env bash
# Backup do Omni para fora da VPS (Backblaze B2, bucket filtrovali-omni), no mesmo modelo do filtroAPP.
# Roda como o usuário omni, pelo cron dele (passo a passo em docs/producao/backup.md).
#
#   B2_URI=b2://filtrovali-omni/daily deploy/backup-prod.sh                       # completo
#   LOCAL_BACKUP_KEEP=2 deploy/backup-prod.sh                                     # só cópia local
#
# Guarda, numa pasta com data e hora:
#   omni.dump            banco do Omni (pg_dump formato custom)
#   evolution.dump       banco da Evolution do Omni (se estiver no ar)
#   evolution-sessions.tar.gz  sessões dos WhatsApp pareados (sem ela, cada número precisa ler o QR de novo)
#   chamadas.tar.gz      gravações das chamadas ainda não arquivadas no SharePoint
#   segredos.tar.gz.enc  .env da produção e certificados, cifrados (sem a GRAVACOES_CHAVE_MESTRA as
#                        gravações no SharePoint não abrem; sem os certificados, não há login nem Graph)
#   SHA256SUMS
# Escreve o resultado em BACKUP_STATUS_FILE e avisa no Telegram se falhar (TELEGRAM_TOKEN/CHAT_ID).
set -euo pipefail

PATH="${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export PATH

TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
BACKUP_STARTED_AT="$(date -Iseconds)"
RUN_DIR=""
UPLOAD_SUCCEEDED=false
SECRETS_INCLUDED=false

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"
PROJETO="${PROJETO:-omni}"
ENVFILE="${ENVFILE:-deploy/.env.production}"
# Pasta própria: ~/backups/omni é a cópia local feita antes de publicar (deploy/backup.sh).
BACKUP_ROOT="${BACKUP_ROOT:-${HOME}/backups/omni-b2}"
BACKUP_LOCK_FILE="${BACKUP_LOCK_FILE:-$BACKUP_ROOT/backup-prod.lock}"
BACKUP_STATUS_FILE="${BACKUP_STATUS_FILE:-$BACKUP_ROOT/status/backup-latest.json}"
BACKUP_LOCK_TIMEOUT_SECONDS="${BACKUP_LOCK_TIMEOUT_SECONDS:-0}"
INCLUDE_VOLUMES="${INCLUDE_VOLUMES:-true}"
INCLUDE_SECRETS="${INCLUDE_SECRETS:-true}"
SECRETS_PASSPHRASE_FILE="${SECRETS_PASSPHRASE_FILE:-${HOME}/.config/omni-backup/segredos.senha}"
B2_URI="${B2_URI:-}"
B2_BIN="${B2_BIN:-b2}"
B2_ENV_FILE="${B2_ENV_FILE:-${HOME}/.config/omni-backup/b2.env}"
# Chave do B2 só do bucket do Omni, separada da do filtroAPP (o b2 guarda a conta autorizada nesse arquivo).
export B2_ACCOUNT_INFO="${B2_ACCOUNT_INFO:-${HOME}/.config/omni-backup/b2_account_info}"
# Mesma regra do filtroAPP: com LOCAL_BACKUP_KEEP, guarda as N cópias locais mais novas; sem ele,
# depois de um envio ao B2 bem-sucedido, fica só a cópia desta execução; sem envio, nada é apagado.
LOCAL_BACKUP_KEEP="${LOCAL_BACKUP_KEEP:-}"
# O Omni roda no Docker rootless do usuário omni (não no Docker do sistema, que é o do filtroAPP).
# O cron não carrega o ~/.profile: usa o socket do próprio usuário se ninguém disse outro.
if [ -z "${DOCKER_HOST:-}" ] && [ -S "/run/user/$(id -u)/docker.sock" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
BACKUP_NICE_LEVEL="${BACKUP_NICE_LEVEL:-19}"
BACKUP_DOCKER_CPUS="${BACKUP_DOCKER_CPUS:-0.5}"

write_backup_status() {
  local status="$1" exit_code="${2:-0}" line_no="${3:-0}"
  mkdir -p "$(dirname "$BACKUP_STATUS_FILE")"
  cat > "${BACKUP_STATUS_FILE}.tmp" <<EOF
{
  "kind": "backup",
  "status": "$status",
  "startedAt": "$BACKUP_STARTED_AT",
  "finishedAt": "$(date -Iseconds)",
  "runDir": "$RUN_DIR",
  "b2Uri": "$B2_URI",
  "includeVolumes": $INCLUDE_VOLUMES,
  "secretsIncluded": $SECRETS_INCLUDED,
  "uploadSucceeded": $UPLOAD_SUCCEEDED,
  "exitCode": $exit_code,
  "line": $line_no
}
EOF
  mv "${BACKUP_STATUS_FILE}.tmp" "$BACKUP_STATUS_FILE"
}

avisar() {
  [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ] || return 0
  curl -sS --max-time 15 -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" > /dev/null || true
}

notify_failure() {
  local exit_code="$?" line_no="${BASH_LINENO[0]}" cmd="${BASH_COMMAND}"
  echo "[backup] falhou (exit $exit_code, linha $line_no): $cmd" >&2
  write_backup_status "FAILURE" "$exit_code" "$line_no" || true
  avisar "❌ Falha no backup do Omni
Servidor: $(hostname)
Destino: ${B2_URI:-local}
Linha: $line_no
Comando: $cmd"
  exit "$exit_code"
}
trap notify_failure ERR

prune_local_backups() {
  local keep="$1" backups=() index=0 name
  [[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "[backup] LOCAL_BACKUP_KEEP inválido: '$keep'" >&2; return 1; }
  mapfile -t backups < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "20*" -printf "%f\n" | sort -r)
  for name in "${backups[@]}"; do
    index=$((index + 1))
    [ "$index" -le "$keep" ] && continue
    rm -rf -- "${BACKUP_ROOT:?}/$name"
  done
}

case "${DOCKER_HOST:-}" in
  unix://*) [ -S "${DOCKER_HOST#unix://}" ] || { echo "[backup] socket do Docker não encontrado: $DOCKER_HOST (o Docker rootless deste usuário está no ar?)" >&2; false; } ;;
esac
docker inspect "${PROJETO}-postgres-1" > /dev/null 2>&1 || { echo "[backup] o Postgres do Omni (${PROJETO}-postgres-1) não aparece no Docker deste usuário (${DOCKER_HOST:-padrão})" >&2; false; }

umask 077
mkdir -p "$BACKUP_ROOT"
exec 9>"$BACKUP_LOCK_FILE"
if ! flock -w "$BACKUP_LOCK_TIMEOUT_SECONDS" 9; then
  echo "[backup] outro backup em andamento; esta execução foi pulada"
  exit 0
fi

TIMESTAMP="$(date +%F-%H%M%S)"
RUN_DIR="$BACKUP_ROOT/$TIMESTAMP"
mkdir -p "$RUN_DIR"
cd "$PROJECT_DIR"
COMPOSE="docker compose -p $PROJETO -f deploy/docker-compose.prod.yml --env-file $ENVFILE"

echo "[backup] banco do Omni"
$COMPOSE exec -T postgres pg_dump -U postgres --format=custom --compress=6 omni > "$RUN_DIR/omni.dump"
pg_ok="$(head -c 5 "$RUN_DIR/omni.dump")"
[ "$pg_ok" = "PGDMP" ] || { echo "[backup] omni.dump não é um dump válido" >&2; false; }

if $COMPOSE --profile whatsapp ps --status running --services 2>/dev/null | grep -qx evolution-postgres; then
  echo "[backup] banco da Evolution"
  $COMPOSE --profile whatsapp exec -T evolution-postgres pg_dump -U evolution --format=custom --compress=6 evolution > "$RUN_DIR/evolution.dump"
fi

if [ "$INCLUDE_VOLUMES" = "true" ]; then
  for par in "evolution_sessions:evolution-sessions" "chamadas_data:chamadas"; do
    volume="${PROJETO}_${par%%:*}"
    arquivo="${par##*:}.tar.gz"
    if docker volume inspect "$volume" > /dev/null 2>&1; then
      echo "[backup] volume $volume"
      docker run --rm --network none --cpus "$BACKUP_DOCKER_CPUS" -v "${volume}:/from:ro" -v "${RUN_DIR}:/backup" \
        alpine:3.22 sh -c "cd /from && nice -n $BACKUP_NICE_LEVEL tar -czf /backup/$arquivo ."
    else
      echo "[backup] volume $volume não existe; pulado" >&2
    fi
  done
fi

if [ "$INCLUDE_SECRETS" = "true" ]; then
  if [ -s "$SECRETS_PASSPHRASE_FILE" ]; then
    echo "[backup] segredos (cifrados)"
    tar -czf - "$ENVFILE" deploy/secrets \
      | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$SECRETS_PASSPHRASE_FILE" \
      > "$RUN_DIR/segredos.tar.gz.enc"
    SECRETS_INCLUDED=true
  else
    echo "[backup] sem $SECRETS_PASSPHRASE_FILE: segredos NÃO incluídos" >&2
  fi
fi

# A lista não pode incluir a si mesma (o arquivo é criado antes de o glob ser lido).
(cd "$RUN_DIR" && find . -maxdepth 1 -type f ! -name 'SHA256SUMS*' -printf '%P\0' | sort -z | xargs -0 sha256sum > SHA256SUMS.tmp \
  && mv SHA256SUMS.tmp SHA256SUMS)
ln -sfn "$RUN_DIR" "$BACKUP_ROOT/latest"

if [ -n "$B2_URI" ]; then
  [ -f "$B2_ENV_FILE" ] && { set -a; # shellcheck disable=SC1090
    source "$B2_ENV_FILE"; set +a; }
  command -v "$B2_BIN" > /dev/null 2>&1 || { echo "[backup] CLI b2 não encontrada (B2_BIN=$B2_BIN)" >&2; false; }
  # Autoriza com a chave do Omni (variáveis do b2.env) no arquivo de conta próprio, uma vez.
  if [ ! -s "$B2_ACCOUNT_INFO" ]; then
    "$B2_BIN" account authorize > /dev/null 2>&1 || "$B2_BIN" authorize-account > /dev/null
  fi
  echo "[backup] enviando para ${B2_URI%/}/$TIMESTAMP"
  "$B2_BIN" sync "$RUN_DIR" "${B2_URI%/}/$TIMESTAMP"
  UPLOAD_SUCCEEDED=true
fi

if [ -n "$LOCAL_BACKUP_KEEP" ]; then
  prune_local_backups "$LOCAL_BACKUP_KEEP"
elif [ "$UPLOAD_SUCCEEDED" = "true" ]; then
  echo "[backup] envio concluído: apagando as outras cópias locais"
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name "20*" ! -path "$RUN_DIR" -exec rm -rf -- {} +
else
  echo "[backup] sem envio ao B2: cópias locais mantidas"
fi
echo "[backup] pronto: $RUN_DIR"
write_backup_status "SUCCESS" 0 0
