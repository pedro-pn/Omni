#!/bin/sh
# Backup do banco do Omni (e da Evolution do Omni, se o perfil whatsapp estiver no ar,
# e das gravações das chamadas, se o perfil chamadas existir).
# Uso, na pasta do repositório na VPS:
#   deploy/backup.sh omni-staging deploy/.env.staging      # staging
#   deploy/backup.sh omni deploy/.env.production           # produção
# Cópia local rápida, feita pelo deploy/publicar.sh antes de cada publicação (volta de versão com
# migration). Guarda em ~/backups/<projeto>/ (ou BACKUP_DIR) e apaga as com mais de 14 dias.
# O backup para fora da VPS (B2, horário/diário/mensal) é o deploy/backup-prod.sh: docs/producao/backup.md.
set -eu
PROJETO="${1:?projeto (omni ou omni-staging)}"
ENVFILE="${2:?arquivo .env do ambiente}"
DESTINO="${BACKUP_DIR:-${HOME}/backups/${PROJETO}}"
QUANDO="$(date +%Y%m%d-%H%M)"
COMPOSE="docker compose -p ${PROJETO} -f deploy/docker-compose.prod.yml --env-file ${ENVFILE}"
umask 077
mkdir -p "${DESTINO}"
${COMPOSE} exec -T postgres pg_dump -U postgres --format=custom omni > "${DESTINO}/omni-${QUANDO}.dump"
if ${COMPOSE} --profile whatsapp ps --status running --services 2>/dev/null | grep -qx evolution-postgres; then
  ${COMPOSE} --profile whatsapp exec -T evolution-postgres pg_dump -U evolution --format=custom evolution > "${DESTINO}/evolution-${QUANDO}.dump"
fi
# Gravações das chamadas (perfil "chamadas"): cópia do volume, só leitura.
if docker volume inspect "${PROJETO}_chamadas_data" >/dev/null 2>&1; then
  docker run --rm --network none -v "${PROJETO}_chamadas_data:/data:ro" alpine:3.22 tar -C /data -czf - . > "${DESTINO}/chamadas-${QUANDO}.tar.gz"
fi
find "${DESTINO}" \( -name '*.dump' -o -name 'chamadas-*.tar.gz' \) -mtime +14 -delete
ls -lh "${DESTINO}" | tail -n 4
