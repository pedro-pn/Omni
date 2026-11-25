import { createPool, createWorkerDb, migrate } from "@omni/db";
import { comTeto, TetoDiarioAtingido, type Llm } from "@omni/integrations/openai";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { conferidorDoTeto } from "./teto-ia.ts";

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
};

async function disponivel(): Promise<boolean> {
  const client = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

/** Teto diário da IA (E11; migration 0080). As chamadas `teto-teste` são deste arquivo. */
describe.skipIf(!available)("teto diário da IA", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  const db = () => createWorkerDb(worker);
  const usoAtual = async () => {
    const { rows } = await owner.query<{ tokens: string; chamadas: string }>("SELECT tokens, chamadas FROM app.gasto_ia_hoje()");
    return { tokens: Number(rows[0]!.tokens), chamadas: Number(rows[0]!.chamadas) };
  };
  let chamadasFeitas = 0;
  const llmFalso: Llm = {
    async estruturado<T>() {
      chamadasFeitas += 1;
      return { dados: {} as T, modelo: "falso", tokensEntrada: 0, tokensSaida: 0, duracaoMs: 0 };
    },
  };

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    worker = createPool(urls.worker, 2);
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM llm_calls WHERE purpose = 'teto-teste'");
    await owner?.query("DELETE FROM system_errors WHERE fingerprint IN ('operacao|ia:teto', 'operacao|ia:metade')");
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
  });

  it("o web registra só metadados pela função e não escreve direto em llm_calls", async () => {
    const antes = await usoAtual();
    await app.query("SELECT app.registrar_chamada_llm('teto-teste', 'falso', 100, 50, 10, 'ok', NULL)");
    const depois = await usoAtual();
    expect(depois.tokens - antes.tokens).toBe(150);
    expect(depois.chamadas - antes.chamadas).toBe(1);
    await expect(app.query("INSERT INTO llm_calls (purpose, model, outcome) VALUES ('teto-teste', 'x', 'ok')")).rejects.toThrow();
  });

  it("abaixo da metade chama; com metade avisa e chama; no teto recusa e avisa", async () => {
    const uso = await usoAtual();
    const folgado = comTeto(llmFalso, conferidorDoTeto(db(), { tokens: uso.tokens * 4 + 1000, chamadas: 0 }));
    await folgado.estruturado({ modelo: "x", sistema: "", entrada: "", nome: "t", esquema: {} });
    expect(chamadasFeitas).toBe(1);

    const metade = comTeto(llmFalso, conferidorDoTeto(db(), { tokens: Math.max(1, Math.ceil(uso.tokens * 1.5)), chamadas: 0 }));
    if (uso.tokens > 0) {
      await metade.estruturado({ modelo: "x", sistema: "", entrada: "", nome: "t", esquema: {} });
      expect(chamadasFeitas).toBe(2);
      expect((await owner.query("SELECT count(*)::int AS n FROM system_errors WHERE fingerprint = 'operacao|ia:metade'")).rows[0].n).toBe(1);
    }

    const estourado = comTeto(llmFalso, conferidorDoTeto(db(), { tokens: 0, chamadas: Math.max(1, uso.chamadas) }));
    const antes = chamadasFeitas;
    await expect(estourado.estruturado({ modelo: "x", sistema: "", entrada: "", nome: "t", esquema: {} })).rejects.toBeInstanceOf(TetoDiarioAtingido);
    expect(chamadasFeitas).toBe(antes);
    const { rows } = await owner.query("SELECT location, message FROM system_errors WHERE fingerprint = 'operacao|ia:teto'");
    expect(rows[0].location).toBe("ia");
    expect(rows[0].message).toContain("Teto diário da IA atingido");
  });
});
