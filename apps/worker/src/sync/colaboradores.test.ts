import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ligarColaboradores, ligarPorEmailCorporativo } from "./filtroapp-missoes.ts";

/** Colaborador do filtroAPP ↔ conta do Omni (0045, spec 038), no banco real (omni_test). Pessoas @colab-teste são deste arquivo. */

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
const tag = Math.random().toString(36).slice(2, 8);
const email = (n: string) => `${n}.${tag}@filtrovali.com.br`;

describe.skipIf(!available)("colaboradores ligados às contas", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const colab = (pessoa: string) => owner.query<{ c: string | null }>("SELECT filtroapp_collaborator_id AS c FROM people WHERE email = $1", [pessoa]).then((r) => r.rows[0]?.c ?? null);
  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    for (const n of ["ana", "bia", "enzo"]) await owner.query("INSERT INTO people (email, display_name) VALUES ($1, $2)", [email(n), n]);
  });
  afterAll(async () => {
    await owner?.query("UPDATE people SET filtroapp_collaborator_id = NULL, active = false WHERE email LIKE $1", [`%.${tag}@filtrovali.com.br`]);
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("pelo e-mail corporativo: só quem ainda não tem, só @filtrovali, nunca o mesmo colaborador em duas contas", async () => {
    const n = await ligarPorEmailCorporativo(createWorkerDb(worker), [
      { id: `c-ana-${tag}`, emailCorporativo: email("ana").toUpperCase() },
      { id: `c-bia-${tag}`, emailCorporativo: `bia.${tag}@gmail.com` },
      { id: `c-sem-${tag}`, emailCorporativo: null },
    ]);
    expect(n).toBe(1);
    expect(await colab(email("ana"))).toBe(`c-ana-${tag}`);
    expect(await colab(email("bia"))).toBeNull();
    // Outro colaborador com o e-mail da Ana não troca o que já está ligado; o mesmo id não vai para a Enzo.
    await ligarPorEmailCorporativo(createWorkerDb(worker), [{ id: `c-outro-${tag}`, emailCorporativo: email("ana") }, { id: `c-ana-${tag}`, emailCorporativo: email("enzo") }]);
    expect(await colab(email("ana"))).toBe(`c-ana-${tag}`);
    expect(await colab(email("enzo"))).toBeNull();
    expect(typeof ligarColaboradores).toBe("function");
  });
});
