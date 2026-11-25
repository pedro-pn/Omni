-- 0013 · Funções do esquema `app` sem EXECUTE para PUBLIC.
--
-- A 0001 tentou isso com `ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ...
-- FROM PUBLIC`, mas o PostgreSQL não permite que o padrão por esquema retire
-- um privilégio concedido globalmente (o EXECUTE para PUBLIC): o comando não
-- tinha efeito e todas as funções nasciam abertas a qualquer papel do banco.
-- Quem precisa recebe GRANT explícito em cada migration (omni_app/omni_worker);
-- funções de trigger e as chamadas só por dentro de SECURITY DEFINER não
-- precisam de EXECUTE para quem dispara.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE omni_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
