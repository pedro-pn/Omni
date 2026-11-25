import { randomUUID } from "node:crypto";

import { createPool, createWorkerDb, migrate, withPerson } from "@omni/db";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enviarPush } from "./enviar.ts";

/** Liberação por módulo (0071) no banco real: a regra, quem pode mudar e o filtro das notificações. */
const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
};
async function disponivel() {
  const c = new pg.Client({ connectionString: urls.owner, connectionTimeoutMillis: 1500 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    if (process.env.CI) throw new Error("Banco de teste indisponível no CI");
    return false;
  }
}
const available = await disponivel();

describe.skipIf(!available)("liberação por módulo", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, string> = {};
  const liberado = (quem: string, m: string) => withPerson(app, quem, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.modulo_liberado(${m}) AS ok`)).then((r) => r.rows[0]!.ok);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
    for (const [k, perfil] of [["admin", "admin"], ["vendas", "vendas"], ["operacao", "operacao"], ["convidado", "operacao"]] as const) {
      const id = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${k}-${tag}@omni.invalid`, k])).rows[0]!.id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      await owner.query("INSERT INTO push_subscriptions (person_id, endpoint, p256dh, auth) VALUES ($1, $2, repeat('k', 60), repeat('a', 20))", [id, `https://push.exemplo/${tag}/${k}`]);
      p[k] = id;
    }
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM module_access WHERE module IN ('whatsapp', 'chamadas')");
    await owner?.query("DELETE FROM push_subscriptions WHERE endpoint LIKE $1", [`https://push.exemplo/${tag}/%`]);
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  it("sem configuração vale para todos; só alguns (perfil ou pessoa); ninguém; quem administra sempre vê; só quem administra muda", async () => {
    await owner.query("DELETE FROM module_access WHERE module IN ('whatsapp', 'chamadas')");
    expect(await liberado(p.operacao!, "whatsapp")).toBe(true);
    // Quem não administra não muda a liberação.
    await expect(withPerson(app, p.vendas!, (db) => db.execute(sql`INSERT INTO module_access (module, mode) VALUES ('whatsapp', 'ninguem')`))).rejects.toThrow();
    await withPerson(app, p.admin!, (db) =>
      db.execute(sql`INSERT INTO module_access (module, mode, profiles, people) VALUES ('whatsapp', 'restrito', '{vendas}', ${`{${p.convidado}}`}::uuid[])`),
    );
    expect(await liberado(p.vendas!, "whatsapp")).toBe(true); // pelo perfil
    expect(await liberado(p.convidado!, "whatsapp")).toBe(true); // pela pessoa
    expect(await liberado(p.operacao!, "whatsapp")).toBe(false);
    expect(await liberado(p.admin!, "whatsapp")).toBe(true);
    await withPerson(app, p.admin!, (db) => db.execute(sql`INSERT INTO module_access (module, mode) VALUES ('chamadas', 'ninguem')`));
    expect(await liberado(p.vendas!, "chamadas")).toBe(false);
    expect(await liberado(p.admin!, "chamadas")).toBe(true);
    expect(await liberado(p.vendas!, "tarefas")).toBe(true);
  });

  it("notificações do WhatsApp só para quem tem o módulo; os avisos do sino continuam para todos", async () => {
    const enviados: string[] = [];
    const enviar = async (a: { endpoint: string }) => {
      enviados.push(a.endpoint.split("/").at(-1)!);
    };
    const todos = [p.admin!, p.vendas!, p.operacao!, p.convidado!];
    await enviarPush(createWorkerDb(worker), enviar, todos, "whatsapp", { titulo: "t", corpo: "c", url: "/", tag: "x" });
    expect(enviados.sort()).toEqual(["admin", "convidado", "vendas"]);
    enviados.length = 0;
    await enviarPush(createWorkerDb(worker), enviar, todos, "aviso", { titulo: "t", corpo: "c", url: "/", tag: "x" });
    expect(enviados.sort()).toEqual(["admin", "convidado", "operacao", "vendas"]);
  });
});
