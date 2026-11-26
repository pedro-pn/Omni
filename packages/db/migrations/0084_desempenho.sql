-- Desempenho (E19, pilar 11.1): tempo por rota e consultas lentas, para otimizar pelo que a medição
-- apontar. Administração → Desempenho (só admin).
--
-- Tempo por rota: o web soma em memória cada requisição (rota com os ids trocados por :id) e cada
-- server function (pelo nome) e grava a cada minuto, por hora: quantidade, soma, máximo, erros 5xx e
-- a contagem por faixa de tempo (até 50, 100, 250, 500, 1000, 2500, 5000 ms e acima), de onde sai o p95
-- aproximado. Nada de usuário, parâmetro ou corpo. Guardado por 90 dias.
--
-- Consultas lentas: pg_stat_statements (consultas normalizadas, sem os valores), ligado no Postgres
-- (shared_preload_libraries no compose) e criado pelo superusuário (deploy/postgres/init/01-roles.sh;
-- no banco que já existe, docs/producao/desempenho.md). Sem a extensão, a tela avisa e segue.

CREATE TABLE desempenho_rotas (
  hora    timestamptz NOT NULL,
  rota    text NOT NULL CHECK (length(rota) BETWEEN 1 AND 200),
  n       int NOT NULL CHECK (n > 0),
  soma_ms bigint NOT NULL,
  max_ms  int NOT NULL,
  erros   int NOT NULL DEFAULT 0,
  faixas  int[] NOT NULL CHECK (cardinality(faixas) = 8),
  PRIMARY KEY (hora, rota)
);
ALTER TABLE desempenho_rotas ENABLE ROW LEVEL SECURITY;
CREATE POLICY desempenho_admin ON desempenho_rotas FOR SELECT TO omni_app USING (app.has_profile('admin'));
GRANT SELECT ON desempenho_rotas TO omni_app;

-- O web grava (sem sessão) só por aqui: soma ao que já houver na mesma hora e rota.
CREATE FUNCTION app.registrar_desempenho(p jsonb) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF jsonb_typeof(p) <> 'array' OR jsonb_array_length(p) > 2000 THEN
    RAISE EXCEPTION 'Lote de desempenho inválido.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO desempenho_rotas AS d (hora, rota, n, soma_ms, max_ms, erros, faixas)
  SELECT date_trunc('hour', (x->>'hora')::timestamptz), left(x->>'rota', 200), (x->>'n')::int, (x->>'soma')::bigint,
         (x->>'max')::int, (x->>'erros')::int, ARRAY(SELECT jsonb_array_elements_text(x->'faixas')::int)
    FROM jsonb_array_elements(p) x
  ON CONFLICT (hora, rota) DO UPDATE SET
    n = d.n + excluded.n,
    soma_ms = d.soma_ms + excluded.soma_ms,
    max_ms = greatest(d.max_ms, excluded.max_ms),
    erros = d.erros + excluded.erros,
    faixas = ARRAY(SELECT a + b FROM unnest(d.faixas, excluded.faixas) AS t(a, b));
  DELETE FROM desempenho_rotas WHERE hora < now() - interval '90 days';
END $$;
REVOKE ALL ON FUNCTION app.registrar_desempenho(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.registrar_desempenho(jsonb) TO omni_app;

-- As consultas mais lentas em média (pg_stat_statements). Só admin. Sem a extensão carregada, nada.
CREATE FUNCTION app.consultas_lentas(p_limite int)
  RETURNS TABLE (consulta text, chamadas bigint, media_ms numeric, max_ms numeric, total_ms numeric, linhas bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT app.has_profile('admin') THEN
    RAISE EXCEPTION 'Só quem administra vê o desempenho.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    RETURN;
  END IF;
  BEGIN
    RETURN QUERY EXECUTE
      'SELECT left(regexp_replace(query, ''\s+'', '' '', ''g''), 400), calls,
              round(mean_exec_time::numeric, 1), round(max_exec_time::numeric, 1), round(total_exec_time::numeric, 0), rows
         FROM pg_stat_statements
        WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND calls >= 5
        ORDER BY mean_exec_time DESC
        LIMIT $1'
      USING least(greatest(p_limite, 1), 50);
  EXCEPTION WHEN object_not_in_prerequisite_state OR insufficient_privilege THEN
    RETURN; -- extensão criada mas não carregada (shared_preload_libraries), ou sem pg_read_all_stats
  END;
END $$;
REVOKE ALL ON FUNCTION app.consultas_lentas(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consultas_lentas(int) TO omni_app;

-- Se a extensão está disponível neste banco (criada pelo superusuário), diz à tela.
CREATE FUNCTION app.consultas_lentas_ligadas() RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    RETURN false;
  END IF;
  EXECUTE 'SELECT 1 FROM pg_stat_statements LIMIT 1';
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false; -- criada mas não carregada no shared_preload_libraries
END $$;
REVOKE ALL ON FUNCTION app.consultas_lentas_ligadas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consultas_lentas_ligadas() TO omni_app;
