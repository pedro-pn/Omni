#!/bin/sh
# Manutenção manual do Omni (E24): para o web e o worker; o Caddy passa a mostrar a página de
# manutenção (503) sozinho, porque o web não responde (bloco omni_manutencao em deploy/caddy/omni.caddy).
#
# Uso, na pasta do repositório na VPS:
#   deploy/manutencao.sh producao on "restaurando o backup"   # liga (motivo opcional)
#   deploy/manutencao.sh producao off                          # sobe web e worker e confere /api/saude
#   deploy/manutencao.sh producao status
#
# O sinal fica em ~/omni-manutencao-<ambiente> (data, quem e motivo). Enquanto ele existe, o
# publicar.sh recusa publicar, a não ser com --encerrar-manutencao. O Postgres continua no ar.
set -eu

AMBIENTE="${1:?ambiente: staging ou producao}"
ACAO="${2:-status}"
MOTIVO="${3:-manutenção manual}"

case "$AMBIENTE" in
  staging) PROJETO=omni-staging; ENVFILE=deploy/.env.staging; PORTA_PADRAO=8085 ;;
  producao) PROJETO=omni; ENVFILE=deploy/.env.production; PORTA_PADRAO=8084 ;;
  *) echo "ambiente desconhecido: $AMBIENTE (use staging ou producao)" >&2; exit 2 ;;
esac

cd "${OMNI_DIR:-$(dirname "$0")/..}"
[ -f "$ENVFILE" ] || { echo "faltando $ENVFILE" >&2; exit 2; }
PORTA="$(grep -E '^OMNI_WEB_PORT=' "$ENVFILE" | cut -d= -f2 || true)"
PORTA="${PORTA:-$PORTA_PADRAO}"
SAUDE="http://172.17.0.1:${PORTA}/api/saude"
COMPOSE="docker compose -p ${PROJETO} -f deploy/docker-compose.prod.yml --env-file ${ENVFILE}"
SINAL="${HOME}/omni-manutencao-${AMBIENTE}"
REGISTRO="${HOME}/omni-publicacoes.log"

registrar() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ${AMBIENTE} $*" | tee -a "$REGISTRO"; }

case "$ACAO" in
  on)
    if [ -f "$SINAL" ]; then echo "já em manutenção desde: $(cat "$SINAL")"; exit 0; fi
    printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SUDO_USER:-${USER:-omni}}" "$MOTIVO" > "$SINAL"
    $COMPOSE stop web worker
    registrar "manutenção LIGADA: ${MOTIVO}"
    ;;
  off)
    $COMPOSE up -d --no-build --wait web worker
    i=0
    while [ $i -lt 30 ]; do
      case "$(wget -qO- "$SAUDE" 2>/dev/null || true)" in
        *'"status":"ok"'*) rm -f "$SINAL"; registrar "manutenção desligada (saúde ok)"; exit 0 ;;
      esac
      i=$((i + 1))
      sleep 2
    done
    registrar "manutenção: web e worker subiram, mas /api/saude não respondeu ok; o sinal continua"
    exit 1
    ;;
  status)
    if [ -f "$SINAL" ]; then echo "manutenção LIGADA desde: $(cat "$SINAL")"; else echo "manutenção desligada"; fi
    $COMPOSE ps web worker
    ;;
  *) echo "uso: $0 staging|producao on [motivo] | off | status" >&2; exit 2 ;;
esac
