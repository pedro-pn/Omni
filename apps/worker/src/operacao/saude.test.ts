import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registrarSaude } from "./saude.ts";

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
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

/** Painel de saúde (E20): o que o job `saude` grava. */
describe.skipIf(!available)("job saude", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });
  afterAll(async () => {
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("grava o worker e, com a pasta de status, só a situação e o horário do backup", async () => {
    const pasta = await mkdtemp(join(tmpdir(), "omni-saude-"));
    await writeFile(join(pasta, "backup-latest.json"), JSON.stringify({ status: "SUCCESS", finishedAt: "2026-11-26T02:20:00Z", b2Uri: "b2://segredo/x", erro: "detalhe" }));
    await writeFile(join(pasta, "restore-latest.json"), JSON.stringify({ status: "FAILED", finishedAt: "2026-11-02T04:50:00Z", message: "falhou em /home/omni" }));
    const r = await registrarSaude(createWorkerDb(worker), pasta);
    expect(r.backup).toEqual({
      local: { status: "SUCCESS", em: "2026-11-26T02:20:00Z" },
      remoto: null,
      ensaio: { status: "FAILED", em: "2026-11-02T04:50:00Z" },
    });
    const linhas = (await owner.query("SELECT chave, valor FROM estado_operacao ORDER BY chave")).rows;
    expect(linhas.map((l) => l.chave)).toEqual(["backup", "worker"]);
    expect(JSON.stringify(linhas)).not.toMatch(/segredo|detalhe|home\/omni/);
    expect(linhas[1].valor.memoriaMb).toBeGreaterThan(0);
  });

  it("sem pasta de status (staging), só o worker", async () => {
    const r = await registrarSaude(createWorkerDb(worker), null);
    expect(Object.keys(r)).toEqual(["worker"]);
  });
});
