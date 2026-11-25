#!/bin/sh
set -eu
cd "$(dirname "$0")"
# Esta configuração é só da POC; nunca carrega o .env da raiz do Omni.
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
if ! command -v "${GO:-go}" >/dev/null 2>&1; then
  echo 'Instale Go 1.27 ou use: npm run chamada:docker' >&2
  exit 1
fi
exec "${GO:-go}" run .
