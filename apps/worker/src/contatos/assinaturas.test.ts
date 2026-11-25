import { createPool, createWorkerDb, migrate } from "@omni/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { vincularPelasAssinaturas } from "./assinaturas.ts";

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
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

describe.skipIf(!available)("agenda pelas assinaturas dos e-mails", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const enderecos = ["ana@assin.invalid", "bia@assin.invalid", "enzo@assin.invalid", "duda@assin.invalid", "eva@assin.invalid", "fixo1@assin.invalid", "dup1@assin.invalid", "dup2@assin.invalid"];
  const limpar = async () => {
    await owner.query("DELETE FROM contacts WHERE id IN (SELECT contact_id FROM contact_identities WHERE value = ANY($1) OR value LIKE '55479900000%' OR value LIKE '5547300000%')", [enderecos]);
    await owner.query("DELETE FROM email_signature_extractions WHERE address = ANY($1)", [enderecos]);
  };
  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    await limpar();
  });
  afterAll(async () => {
    await limpar();
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("cria o contato com e-mail e celular; acrescenta o celular ao contato do e-mail; não junta pelo telefone, fixo nem telefone repetido; repetir não duplica", async () => {
    const assinatura = (address: string, telefone: string | null, status = "ok", nome = "Fulana de Tal") =>
      owner.query("INSERT INTO email_signature_extractions (address, nome, empresa, telefone, status) VALUES ($1, $2, 'Cliente SA', $3, $4)", [address, nome, telefone, status]);
    await assinatura("ana@assin.invalid", "(47) 9000-0011", "ok", "Ana Assinatura"); // celular sem o 9 → ganha o 9
    await assinatura("bia@assin.invalid", "47 99000-0012");
    await assinatura("enzo@assin.invalid", "47 99000-0013");
    await assinatura("duda@assin.invalid", null);
    await assinatura("eva@assin.invalid", "47 99000-0015", "sem_assinatura");
    await assinatura("fixo1@assin.invalid", "47 3000-0016"); // fixo: central da empresa
    await assinatura("dup1@assin.invalid", "47 99000-0017"); // mesmo celular em duas assinaturas
    await assinatura("dup2@assin.invalid", "47 99000-0017");
    // Bia já está na agenda (só o e-mail); o telefone de Enzo já é de outro contato.
    const bia = (await owner.query("INSERT INTO contacts (name) VALUES ('Bia') RETURNING id")).rows[0].id;
    await owner.query("INSERT INTO contact_identities (contact_id, kind, value) VALUES ($1, 'email', 'bia@assin.invalid')", [bia]);
    const outro = (await owner.query("INSERT INTO contacts (name) VALUES ('Outro') RETURNING id")).rows[0].id;
    await owner.query("INSERT INTO contact_identities (contact_id, kind, value) VALUES ($1, 'telefone', '5547990000013'), ($1, 'email', 'outro@assin.invalid')", [outro]);
    try {
      const r = await vincularPelasAssinaturas(createWorkerDb(worker));
      expect(r.criados).toBeGreaterThanOrEqual(1);
      const de = async (v: string) =>
        (await owner.query("SELECT c.name, c.company, i.source, i.contact_id FROM contact_identities i JOIN contacts c ON c.id = i.contact_id WHERE i.value = $1", [v])).rows[0];
      const ana = await de("ana@assin.invalid");
      expect(ana).toMatchObject({ name: "Ana Assinatura", company: "Cliente SA", source: "assinatura" });
      expect((await de("5547990000011")).contact_id).toBe(ana.contact_id);
      expect((await de("5547990000012")).contact_id).toBe(bia); // acrescentado à Bia
      expect((await de("5547990000013")).contact_id).toBe(outro); // continua do outro contato
      expect(await de("enzo@assin.invalid")).toBeUndefined(); // não entra no contato só porque o telefone bate
      expect(await de("fixo1@assin.invalid")).toBeUndefined();
      expect(await de("dup1@assin.invalid")).toBeUndefined();
      expect(await de("duda@assin.invalid")).toBeUndefined();
      expect(await de("5547990000015")).toBeUndefined();
      const antes = (await owner.query("SELECT count(*)::int AS n FROM contact_identities WHERE value = ANY($1)", [enderecos])).rows[0].n;
      await vincularPelasAssinaturas(createWorkerDb(worker));
      expect((await owner.query("SELECT count(*)::int AS n FROM contact_identities WHERE value = ANY($1)", [enderecos])).rows[0].n).toBe(antes);
    } finally {
      await owner.query("DELETE FROM contacts WHERE id IN ($1, $2)", [bia, outro]);
    }
  });
});
