-- Painel de saúde (E20, pilar 12.3): Administração → Saúde, só para quem administra.
--
-- O web não enxerga o worker nem os arquivos de status do backup; o worker grava aqui um resumo a cada
-- 5 minutos (job `saude`): o próprio processo (versão, memória, desde quando está no ar) e, com
-- OPERACAO_STATUS=ligado, o último backup local, o último no B2 e o último ensaio de restauração.
-- Os números do web vêm da medição da E19 (desempenho_rotas) e das filas do pg-boss.

CREATE TABLE estado_operacao (
  chave         text PRIMARY KEY CHECK (chave IN ('worker', 'backup')),
  valor         jsonb NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE estado_operacao ENABLE ROW LEVEL SECURITY;
CREATE POLICY estado_operacao_admin ON estado_operacao FOR SELECT TO omni_app USING (app.has_profile('admin'));
GRANT SELECT ON estado_operacao TO omni_app;
CREATE POLICY estado_operacao_worker ON estado_operacao FOR ALL TO omni_worker USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON estado_operacao TO omni_worker;

-- Banco: tamanho, conexões e as maiores tabelas. Só admin.
CREATE FUNCTION app.saude_banco() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app.has_profile('admin') THEN
    RAISE EXCEPTION 'Só quem administra vê a saúde do sistema.' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'tamanho_bytes', pg_database_size(current_database()),
    'conexoes', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
    'conexoes_max', current_setting('max_connections')::int,
    'maiores_tabelas', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('tabela', relname, 'bytes', bytes) ORDER BY bytes DESC), '[]')
        FROM (SELECT c.relname, pg_total_relation_size(c.oid) AS bytes
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE c.relkind = 'r' AND n.nspname IN ('public', 'pgboss')
               ORDER BY 2 DESC LIMIT 6) t
    )
  );
END $$;
REVOKE ALL ON FUNCTION app.saude_banco() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.saude_banco() TO omni_app;
