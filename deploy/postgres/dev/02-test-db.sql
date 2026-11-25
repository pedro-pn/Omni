-- Banco separado para os testes de RLS (só desenvolvimento e CI).
CREATE DATABASE omni_test OWNER omni_owner;
GRANT CONNECT ON DATABASE omni_test TO omni_app, omni_worker;
GRANT CREATE ON DATABASE omni_test TO omni_worker;

\connect omni_test
GRANT ALL ON SCHEMA public TO omni_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA pgboss AUTHORIZATION omni_worker;
GRANT USAGE ON SCHEMA pgboss TO omni_app;
