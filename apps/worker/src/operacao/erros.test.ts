import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { avisarErros, conferirOperacao, registrarErroDoWorker } from "./erros.ts";

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

/** Erros do sistema no worker (E09). Os locais `teste-<tag>` são deste arquivo. */
describe.skipIf(!available)("erros do sistema (worker)", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const local = `teste-${tag}`;
  const p: Record<string, string> = {};
  const db = () => createWorkerDb(worker);
  async function pessoa(nome: string, perfil: string | null) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, `${nome} ${tag}`]);
    if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }
  const avisosDe = async (quem: string) =>
    (await owner.query("SELECT title, body FROM notifications WHERE person_id = $1 AND kind = 'erro_sistema' AND title LIKE $2", [quem, `%${tag}%`])).rows;

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    p.admin = await pessoa("admin", "admin");
    p.diretoria = await pessoa("diretoria", "diretoria");
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM notifications WHERE person_id = ANY($1::uuid[])", [Object.values(p)]);
    await owner?.query("DELETE FROM system_errors WHERE location = $1 OR fingerprint LIKE 'operacao|%'", [local]);
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("registra o erro limpo, avisa só quem é admin e não repete antes de 6 h", async () => {
    await registrarErroDoWorker(db(), new Error("falhou para ana@cliente.com.br depois de 3 tentativas"), local);
    await registrarErroDoWorker(db(), new Error("falhou para ana@cliente.com.br depois de 3 tentativas"), local);
    const { rows } = await owner.query("SELECT message, occurrences, source FROM system_errors WHERE location = $1", [local]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "worker", occurrences: 2 });
    expect(rows[0].message).not.toContain("ana@cliente");

    const agora = new Date();
    await avisarErros(db(), agora);
    const avisos = await avisosDe(p.admin!);
    expect(avisos).toHaveLength(1);
    expect(avisos[0].title).toBe(`Erro no Omni: Worker · ${local}`);
    expect(avisos[0].body).toContain("(2 vezes)");
    expect(await avisosDe(p.diretoria!)).toHaveLength(0);

    // Voltou a acontecer, mas antes de 6 h: sem aviso novo.
    await registrarErroDoWorker(db(), new Error("falhou para ana@cliente.com.br depois de 3 tentativas"), local);
    await avisarErros(db(), new Date(agora.getTime() + 60_000));
    expect(await avisosDe(p.admin!)).toHaveLength(1);
    // Depois de 6 h, avisa de novo.
    await avisarErros(db(), new Date(agora.getTime() + 7 * 3_600_000));
    expect(await avisosDe(p.admin!)).toHaveLength(2);
  });

  it("confere o status do backup e registra o que está fora do limite", async () => {
    const pasta = await mkdtemp(join(tmpdir(), "omni-ops-"));
    const agora = new Date("2026-11-26T12:00:00Z");
    await writeFile(join(pasta, "backup-latest.json"), JSON.stringify({ status: "SUCCESS" }));
    await writeFile(
      join(pasta, "backup-remoto-latest.json"),
      JSON.stringify({ status: "SUCCESS", uploadSucceeded: true, finishedAt: "2026-11-24T02:21:00+00:00" }),
    );
    await writeFile(join(pasta, "restore-latest.json"), JSON.stringify({ status: "SUCCESS", finishedAt: "2026-11-02T04:51:00+00:00" }));
    const r = await conferirOperacao(db(), pasta, agora);
    expect(r.problemas).toEqual(["backup:remoto-velho"]);
    const { rows } = await owner.query("SELECT source, location, message FROM system_errors WHERE fingerprint = 'operacao|backup:remoto-velho'");
    expect(rows[0]).toMatchObject({ source: "operacao", location: "backup" });
    expect(rows[0].message).toContain("57 horas");
  });
});
