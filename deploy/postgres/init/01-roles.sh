#!/bin/sh
# Papéis do Omni. Roda uma vez, na criação do banco (docker-entrypoint-initdb.d),
# em desenvolvimento e em produção. As senhas vêm do ambiente — nunca do arquivo.
#
# omni_owner : dono do schema e das tabelas; só as migrations usam.
# omni_app   : usado pelo web. NUNCA tem BYPASSRLS — toda leitura passa pelas políticas.
# omni_worker: usado pelo worker (sincronizações, IA). Também sem BYPASSRLS;
#              recebe políticas próprias, explícitas, por tabela.
set -eu

: "${OMNI_OWNER_PASSWORD:?defina OMNI_OWNER_PASSWORD}"
: "${OMNI_APP_PASSWORD:?defina OMNI_APP_PASSWORD}"
: "${OMNI_WORKER_PASSWORD:?defina OMNI_WORKER_PASSWORD}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" \
  -v owner_pw="$OMNI_OWNER_PASSWORD" \
  -v app_pw="$OMNI_APP_PASSWORD" \
  -v worker_pw="$OMNI_WORKER_PASSWORD" <<'SQL'
CREATE ROLE omni_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE omni_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE omni_worker LOGIN PASSWORD :'worker_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

ALTER DATABASE :"db" OWNER TO omni_owner;
GRANT ALL ON SCHEMA public TO omni_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO omni_app, omni_worker;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Fila de jobs (pg-boss). O worker é dono; o web só enfileira.
-- O pg-boss roda CREATE SCHEMA IF NOT EXISTS no start, e o Postgres exige CREATE no
-- banco mesmo com o schema já criado. Por isso o worker recebe CREATE no banco.
GRANT CREATE ON DATABASE :"db" TO omni_worker;
CREATE SCHEMA pgboss AUTHORIZATION omni_worker;
GRANT USAGE ON SCHEMA pgboss TO omni_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omni_worker IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE ON TABLES TO omni_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omni_worker IN SCHEMA pgboss
  GRANT EXECUTE ON FUNCTIONS TO omni_app;
SQL
