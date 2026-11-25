import { createPool, createWorkerDb, migrate } from "@omni/db";
import { GraphError } from "@omni/integrations/graph";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { manterAssinaturas, type FonteAssinaturas } from "./graph-avisos.ts";

/** Assinaturas de aviso do Graph (0070) no banco real, com um Graph falso. Caixas @avisos.invalid são deste arquivo. */
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

function graphFalso() {
  const segredos = new Map<string, string>();
  const vivas = new Set<string>();
  let n = 0;
  const log: string[] = [];
  const g: FonteAssinaturas = {
    assinarEntrada: async (caixa, url, segredo, expira) => {
      if (caixa.startsWith("negada")) throw new GraphError("Graph respondeu 403", 403, "ExtensionError");
      n += 1;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      segredos.set(id, segredo);
      vivas.add(id);
      log.push(`criar ${caixa} ${url}`);
      return { id, expira };
    },
    renovarAssinatura: async (id, expira) => {
      log.push(`renovar ${id}`);
      if (!vivas.has(id)) throw new GraphError("Graph respondeu 404", 404, "ResourceNotFound");
      return expira;
    },
    apagarAssinatura: async (id) => {
      log.push(`apagar ${id}`);
      vivas.delete(id);
    },
  };
  return { g, segredos, vivas, log };
}

describe.skipIf(!available)("aviso imediato de e-mail novo (assinaturas do Graph)", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  const db = () => createWorkerDb(worker);
  const URL_AVISOS = "https://omni.exemplo/api/graph/avisos";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
    await owner.query("DELETE FROM mail_mailboxes WHERE email LIKE '%@avisos.invalid'");
    // Caixas de outros testes não entram nesta conta.
    await owner.query("UPDATE mail_mailboxes SET active = false WHERE email NOT LIKE '%@avisos.invalid'");
    await owner.query("DELETE FROM graph_subscriptions");
    await owner.query("INSERT INTO mail_mailboxes (email) VALUES ('ana@avisos.invalid'), ('bia@avisos.invalid'), ('negada@avisos.invalid')");
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM mail_mailboxes WHERE email LIKE '%@avisos.invalid'");
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  it("assina cada caixa ativa (segredo só como SHA-256), renova perto de vencer, recria a que sumiu e tira a da caixa desligada; o webhook confere o segredo", async () => {
    const f = graphFalso();
    const agora = new Date("2026-11-24T12:00:00Z");
    const r1 = await manterAssinaturas(db(), f.g, URL_AVISOS, () => agora);
    expect(r1).toMatchObject({ criadas: 2, erros: 1 }); // a caixa negada fica para a próxima rodada
    const linhas = (await owner.query("SELECT s.id, b.email, s.secret_sha256, s.expires_at FROM graph_subscriptions s JOIN mail_mailboxes b ON b.id = s.mailbox_id ORDER BY b.email")).rows;
    expect(linhas.map((l) => l.email)).toEqual(["ana@avisos.invalid", "bia@avisos.invalid"]);
    const ana = linhas[0]!;
    expect(Buffer.from(ana.secret_sha256).toString("utf8")).not.toContain(f.segredos.get(ana.id)!);
    // Webhook: segredo certo acorda o worker; errado ou assinatura desconhecida, não.
    const ouvinte = new pg.Client({ connectionString: urls.owner });
    await ouvinte.connect();
    const avisos: string[] = [];
    ouvinte.on("notification", (n) => avisos.push(n.payload ?? ""));
    await ouvinte.query("LISTEN omni_graph_email");
    const aviso = (id: string, segredo: string) => app.query("SELECT app.graph_aviso_email($1, $2) AS ok", [id, segredo]).then((r) => r.rows[0].ok);
    expect(await aviso(ana.id, f.segredos.get(ana.id)!)).toBe(true);
    expect(await aviso(ana.id, "errado")).toBe(false);
    expect(await aviso("00000000-0000-4000-8000-999999999999", f.segredos.get(ana.id)!)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    await ouvinte.end();
    const caixaAna = (await owner.query("SELECT id FROM mail_mailboxes WHERE email = 'ana@avisos.invalid'")).rows[0].id;
    expect(avisos).toEqual([caixaAna]);
    // O webhook não lê a tabela (o segredo não sai do banco).
    await expect(app.query("SELECT * FROM graph_subscriptions")).rejects.toThrow(/permission/);

    // Longe de vencer: nada muda. Perto de vencer: renova; a que sumiu do Graph é recriada.
    expect(await manterAssinaturas(db(), f.g, URL_AVISOS, () => new Date(agora.getTime() + 3600_000))).toMatchObject({ criadas: 0, renovadas: 0 });
    f.vivas.delete(linhas[1]!.id); // a da Bia venceu no Graph
    const depois = new Date(agora.getTime() + 2 * 24 * 3600_000);
    expect(await manterAssinaturas(db(), f.g, URL_AVISOS, () => depois)).toMatchObject({ renovadas: 1, criadas: 1 });
    // Caixa desligada: a assinatura sai do Graph e do banco.
    await owner.query("UPDATE mail_mailboxes SET active = false WHERE email = 'ana@avisos.invalid'");
    expect(await manterAssinaturas(db(), f.g, URL_AVISOS, () => depois)).toMatchObject({ removidas: 1 });
    expect((await owner.query("SELECT count(*)::int AS n FROM graph_subscriptions WHERE mailbox_id = $1", [caixaAna])).rows[0].n).toBe(0);
  });
});
