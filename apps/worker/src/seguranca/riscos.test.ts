import { randomUUID } from "node:crypto";

import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { vigiarRiscos } from "./riscos.ts";

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

describe.skipIf(!available)("alertas de risco (worker)", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 8);
  const p: Record<string, string> = {};
  const db = () => createWorkerDb(worker);
  async function pessoa(nome: string, perfil: string | null) {
    const { rows } = await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@filtrovali.com.br`, `${nome} ${tag}`]);
    if (perfil) await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [rows[0]!.id, perfil]);
    return rows[0]!.id;
  }

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    p.admin = await pessoa("admin", "admin");
    p.baixador = await pessoa("baixador", "operacao");
    p.remetente = await pessoa("remetente", "gerente");
    p.tranquilo = await pessoa("tranquilo", "operacao");
  });
  afterAll(async () => {
    const ids = Object.values(p);
    await owner?.query("DELETE FROM notifications WHERE person_id = ANY($1::uuid[])", [ids]);
    await owner?.query("DELETE FROM risk_alerts WHERE person_id = ANY($1::uuid[])", [ids]);
    // audit_log é só de inserção (gatilho): os registros ficam, de pessoas só deste teste.
    await owner?.query("DELETE FROM mail_outbox WHERE person_id = ANY($1::uuid[])", [ids]);
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("download em massa e envio para fora viram alerta (um por hora) e aviso para quem administra; o dia a dia, não", async () => {
    // 45 arquivos diferentes na última hora (e o mesmo arquivo repetido conta uma vez).
    await owner.query("INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id) SELECT $1, 'arquivo.baixado', 'sharepoint', 'pasta:item' || i FROM generate_series(1, 45) i", [p.baixador]);
    await owner.query("INSERT INTO audit_log (actor_person_id, action, entity_type, entity_id) SELECT $1, 'arquivo.baixado', 'sharepoint', 'pasta:mesmo' FROM generate_series(1, 30)", [p.tranquilo]);
    // 16 anexos para fora (cliente) e 20 para dentro (só a empresa): conta só os de fora.
    const anexos = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ nome: `a${i}.pdf`, tipo: "application/pdf", tamanho: 1000 })));
    const envio = (para: string, n: number) =>
      owner.query(
        "INSERT INTO mail_outbox (person_id, from_address, to_recipients, subject, body, mode, status, attachments) VALUES ($1, 'x@filtrovali.com.br', $2, 's', 'b', 'real', 'enviado', $3)",
        [p.remetente, JSON.stringify([para]), anexos(n)],
      );
    await envio("compras@cliente-teste.com.br", 8);
    await envio("outro@cliente-teste.com.br", 8);
    await envio(`admin-${tag}@filtrovali.com.br`, 20);

    await vigiarRiscos(db());
    // Só as pessoas deste teste (o banco de teste guarda execuções anteriores).
    const alertas = (await owner.query("SELECT kind, person_id, details FROM risk_alerts WHERE person_id = ANY($1::uuid[]) ORDER BY kind", [Object.values(p)])).rows;
    expect(alertas.map((a) => [a.kind, a.person_id])).toEqual([
      ["downloads_em_massa", p.baixador],
      ["envio_para_fora", p.remetente],
    ]);
    expect(alertas[0].details.origens).toEqual({ sharepoint: 45 });
    expect(alertas[1].details.arquivos).toBe(16);
    const avisos = (await owner.query("SELECT kind, title FROM notifications WHERE person_id = $1 AND kind = 'risco' AND title LIKE $2 ORDER BY title", [p.admin, `%${tag}`])).rows;
    expect(avisos.map((a) => a.title)).toEqual([`Download em massa: baixador ${tag}`, `Envio de arquivos para fora: remetente ${tag}`]);
    // Na mesma hora, não repete.
    await vigiarRiscos(db());
    expect((await owner.query("SELECT count(*)::int AS n FROM risk_alerts WHERE person_id = ANY($1::uuid[])", [Object.values(p)])).rows[0].n).toBe(2);
  }, 30_000);
});
