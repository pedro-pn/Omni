#!/usr/bin/env bash
# Ensaio de restauração do Omni: prova que o backup mais recente fora da VPS volta (pilar 3.5).
#
# Baixa o backup mais recente do B2 (ou usa uma pasta local), confere os checksums, restaura o banco
# num PostgreSQL descartável (container próprio, sem rede, apagado no fim), confere a leitura dos
# arquivos de volume e dos segredos cifrados e grava o resultado em RESTORE_STATUS_FILE.
# NUNCA toca o banco de produção nem os serviços do Compose.
#
#   deploy/restore-drill.sh                                   # último em b2://filtrovali-omni/daily
#   RESTORE_DRILL_B2_URI=b2://filtrovali-omni/monthly deploy/restore-drill.sh
#   RESTORE_DRILL_SOURCE=/root/backups/omni/latest deploy/restore-drill.sh   # pasta local
set -euo pipefail

PATH="${PATH:-/usr/bin:/bin}:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

STARTED_AT="$(date -Iseconds)"
STARTED_EPOCH="$(date +%s)"
RESTORE_DRILL_B2_URI="${RESTORE_DRILL_B2_URI:-b2://filtrovali-omni/daily}"
RESTORE_DRILL_SOURCE="${RESTORE_DRILL_SOURCE:-}"
B2_BIN="${B2_BIN:-b2}"
B2_ENV_FILE="${B2_ENV_FILE:-/root/.config/omni-backup/b2.env}"
export B2_ACCOUNT_INFO="${B2_ACCOUNT_INFO:-/root/.config/omni-backup/b2_account_info}"
SECRETS_PASSPHRASE_FILE="${SECRETS_PASSPHRASE_FILE:-/root/.config/omni-backup/segredos.senha}"
RESTORE_STATUS_FILE="${RESTORE_STATUS_FILE:-/root/backups/omni/status/restore-latest.json}"
WORK_ROOT="${RESTORE_DRILL_WORK_ROOT:-/root/backups/omni/restore-drill}"
POSTGRES_IMAGE="${RESTORE_DRILL_POSTGRES_IMAGE:-postgres:16-alpine}"
CONTAINER_NAME="omni-restore-drill-$$"
MAX_DATA_AGE_HOURS="${RESTORE_DRILL_MAX_DATA_AGE_HOURS:-36}"
DRILL_MEMORY="${RESTORE_DRILL_MEMORY:-1g}"
DRILL_CPUS="${RESTORE_DRILL_CPUS:-1}"
TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"

WORK_DIR=""
BACKUP_LABEL=""
SANITY_JSON="{}"

log() { echo "[restore-drill $(date '+%H:%M:%S')] $*"; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }

write_status() {
  local status="$1" message="$2"
  mkdir -p "$(dirname "$RESTORE_STATUS_FILE")"
  cat > "${RESTORE_STATUS_FILE}.tmp" <<EOF
{
  "kind": "restore-drill",
  "status": "$status",
  "startedAt": "$STARTED_AT",
  "finishedAt": "$(date -Iseconds)",
  "durationSeconds": $(( $(date +%s) - STARTED_EPOCH )),
  "backupSource": "$(json_escape "$BACKUP_LABEL")",
  "target": "throwaway-container",
  "sanity": $SANITY_JSON,
  "message": "$(json_escape "$message")"
}
EOF
  mv "${RESTORE_STATUS_FILE}.tmp" "$RESTORE_STATUS_FILE"
}

avisar() {
  [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ] || return 0
  curl -sS --max-time 15 -X POST "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" > /dev/null || true
}

cleanup() {
  docker rm -f "$CONTAINER_NAME" > /dev/null 2>&1 || true
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then rm -rf -- "$WORK_DIR"; fi
}

on_error() {
  local exit_code="$?" line_no="${BASH_LINENO[0]}"
  log "FALHA (exit $exit_code, linha $line_no): ${BASH_COMMAND}"
  write_status "FAILURE" "linha $line_no: ${BASH_COMMAND}" || true
  avisar "❌ Ensaio de restauração do Omni falhou em $(hostname): linha $line_no"
  cleanup
  exit "$exit_code"
}
trap on_error ERR
trap cleanup EXIT

psql_drill() { docker exec -i "$CONTAINER_NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d omni "$@"; }

umask 077
mkdir -p "$WORK_ROOT"
WORK_DIR="$(mktemp -d "$WORK_ROOT/run-XXXXXX")"

# 1. Origem ------------------------------------------------------------------
if [ -n "$RESTORE_DRILL_SOURCE" ]; then
  SOURCE_DIR="$(readlink -f "$RESTORE_DRILL_SOURCE")"
  BACKUP_LABEL="$SOURCE_DIR"
  log "usando backup local $SOURCE_DIR"
else
  [ -f "$B2_ENV_FILE" ] && { set -a; # shellcheck disable=SC1090
    source "$B2_ENV_FILE"; set +a; }
  command -v "$B2_BIN" > /dev/null 2>&1 || { log "CLI b2 não encontrada (B2_BIN=$B2_BIN)"; false; }
  # Autoriza com a chave do Omni (variáveis do b2.env) no arquivo de conta próprio, uma vez.
  if [ ! -s "$B2_ACCOUNT_INFO" ]; then
    "$B2_BIN" account authorize > /dev/null 2>&1 || "$B2_BIN" authorize-account > /dev/null
  fi
  log "procurando o backup mais recente em $RESTORE_DRILL_B2_URI"
  LATEST="$("$B2_BIN" ls "${RESTORE_DRILL_B2_URI%/}/" | sed 's#/$##' | awk -F/ '{print $NF}' \
    | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}$' | sort | tail -n 1 || true)"
  [ -n "$LATEST" ] || { log "nenhum backup em $RESTORE_DRILL_B2_URI"; false; }
  BACKUP_LABEL="${RESTORE_DRILL_B2_URI%/}/$LATEST"
  SOURCE_DIR="$WORK_DIR/backup"
  mkdir -p "$SOURCE_DIR"
  log "baixando $BACKUP_LABEL"
  "$B2_BIN" sync "$BACKUP_LABEL" "$SOURCE_DIR"
fi
[ -s "$SOURCE_DIR/omni.dump" ] || { log "omni.dump ausente ou vazio"; false; }

# 2. Integridade -------------------------------------------------------------
[ -f "$SOURCE_DIR/SHA256SUMS" ] || { log "SHA256SUMS ausente: o backup não pode ser comprovado"; false; }
log "conferindo SHA256SUMS"
(cd "$SOURCE_DIR" && sha256sum -c --quiet SHA256SUMS)
for arq in evolution-sessions.tar.gz chamadas.tar.gz; do
  if [ -f "$SOURCE_DIR/$arq" ]; then log "conferindo a leitura de $arq"; tar -tzf "$SOURCE_DIR/$arq" > /dev/null; fi
done
SEGREDOS="ausentes"
if [ -f "$SOURCE_DIR/segredos.tar.gz.enc" ]; then
  if [ -s "$SECRETS_PASSPHRASE_FILE" ]; then
    log "conferindo os segredos cifrados (abre e lista, sem gravar)"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$SECRETS_PASSPHRASE_FILE" \
      < "$SOURCE_DIR/segredos.tar.gz.enc" | tar -tzf - | grep -q "env.production"
    SEGREDOS="conferidos"
  else
    SEGREDOS="sem senha para conferir"
  fi
fi

# 3. PostgreSQL descartável, sem rede ------------------------------------------
log "subindo PostgreSQL descartável ($POSTGRES_IMAGE, sem rede)"
docker run -d --rm --name "$CONTAINER_NAME" --network none --memory "$DRILL_MEMORY" --cpus "$DRILL_CPUS" \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" -e POSTGRES_DB=omni \
  "$POSTGRES_IMAGE" > /dev/null
for _ in $(seq 1 60); do
  docker exec "$CONTAINER_NAME" pg_isready -U postgres -d omni -q 2> /dev/null && break
  sleep 2
done
docker exec "$CONTAINER_NAME" pg_isready -U postgres -d omni -q

# Papéis não vêm no dump (deploy/postgres/init/01-roles.sh); aqui só existem, sem login.
psql_drill <<'SQL'
CREATE ROLE omni_owner NOLOGIN NOBYPASSRLS;
CREATE ROLE omni_app NOLOGIN NOBYPASSRLS;
CREATE ROLE omni_worker NOLOGIN NOBYPASSRLS;
ALTER DATABASE omni OWNER TO omni_owner;
SQL

# 4. Restauração -------------------------------------------------------------
RESTORE_STARTED="$(date +%s)"
log "restaurando omni.dump (--exit-on-error)"
docker exec -i "$CONTAINER_NAME" pg_restore -U postgres -d omni --exit-on-error < "$SOURCE_DIR/omni.dump"
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_STARTED ))
log "restauração concluída em ${RESTORE_SECONDS}s"
if [ -f "$SOURCE_DIR/evolution.dump" ]; then
  log "conferindo a leitura de evolution.dump"
  docker exec -i "$CONTAINER_NAME" pg_restore --list < "$SOURCE_DIR/evolution.dump" > /dev/null
fi

# 5. Sanidade ----------------------------------------------------------------
SANITY_LINE="$(psql_drill -At -F '|' <<'SQL'
SELECT
  (SELECT count(*) FROM schema_migrations),
  COALESCE((SELECT max(name) FROM schema_migrations), ''),
  (SELECT count(*) FROM people),
  (SELECT count(*) FROM missions),
  (SELECT count(*) FROM tasks),
  COALESCE((SELECT floor(extract(epoch FROM now() - max(started_at)) / 3600)::int::text FROM sync_runs), ''),
  (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity AND tablename <> 'schema_migrations'),
  pg_size_pretty(pg_database_size(current_database()));
SQL
)"
IFS='|' read -r MIGRATIONS ULTIMA PEOPLE MISSIONS TASKS HORAS SEM_RLS DB_SIZE <<< "$SANITY_LINE"

SANITY_JSON="$(cat <<EOF
{
    "restoreSeconds": $RESTORE_SECONDS,
    "appliedMigrations": ${MIGRATIONS:-0},
    "latestMigration": "$(json_escape "$ULTIMA")",
    "people": ${PEOPLE:-0},
    "missions": ${MISSIONS:-0},
    "tasks": ${TASKS:-0},
    "hoursSinceLastSync": ${HORAS:-null},
    "tablesWithoutRls": ${SEM_RLS:-0},
    "secrets": "$(json_escape "$SEGREDOS")",
    "databaseSize": "$(json_escape "$DB_SIZE")"
  }
EOF
)"
log "migrations=$MIGRATIONS (última $ULTIMA) pessoas=$PEOPLE missões=$MISSIONS tarefas=$TASKS última sincronização há ${HORAS}h sem RLS=$SEM_RLS segredos=$SEGREDOS tamanho=$DB_SIZE"

FALHAS=()
[ "${MIGRATIONS:-0}" -gt 0 ] || FALHAS+=("nenhuma migration")
[ "${PEOPLE:-0}" -gt 0 ] || FALHAS+=("nenhuma pessoa")
[ "${MISSIONS:-0}" -gt 0 ] || FALHAS+=("nenhuma missão")
[ "${SEM_RLS:-0}" -eq 0 ] || FALHAS+=("$SEM_RLS tabela(s) sem RLS no backup")
if [ -n "${HORAS:-}" ] && [ "$HORAS" -gt "$MAX_DATA_AGE_HOURS" ]; then
  FALHAS+=("última sincronização há ${HORAS}h (limite ${MAX_DATA_AGE_HOURS}h): backup velho?")
fi

trap - ERR
if [ "${#FALHAS[@]}" -gt 0 ]; then
  msg="sanidade reprovada: $(IFS='; '; echo "${FALHAS[*]}")"
  log "$msg"
  write_status "FAILURE" "$msg"
  avisar "❌ Ensaio de restauração do Omni: $msg"
  exit 1
fi
write_status "SUCCESS" "restauração de $BACKUP_LABEL em ${RESTORE_SECONDS}s"
log "ensaio OK: $BACKUP_LABEL restaurado em ${RESTORE_SECONDS}s (total $(( $(date +%s) - STARTED_EPOCH ))s)"
