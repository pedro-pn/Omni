import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool, withPerson } from "./client.ts";
import { migrate } from "./migrate.ts";

/** Agenda do celular (0088): o worker troca a lista inteira; o dono lê e adiciona; os outros, nada. */

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

describe.skipIf(!available)("agenda do celular", () => {
  let owner: pg.Pool;
  let app: pg.Pool;
  let worker: pg.Pool;
  const tag = randomUUID().slice(0, 6);
  const instancia = `omni-agenda${tag}`;
  let dono = "";
  let outro = "";
  let numero = "";

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    app = createPool(urls.app, 2);
    worker = createPool(urls.worker, 2);
    const pessoa = async (nome: string) => {
      const id = (await owner.query("INSERT INTO people (email, display_name) VALUES ($1, $2) RETURNING id", [`${nome}-${tag}@agenda.invalid`, nome])).rows[0].id as string;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, 'operacao')", [id]);
      return id;
    };
    dono = await pessoa("dono");
    outro = await pessoa("outro");
    numero = (await owner.query("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, phone, status) VALUES ($1, 'Meu', 'outro', $2, '5547900000001', 'conectado') RETURNING id", [instancia, dono])).rows[0].id;
    await owner.query("INSERT INTO whatsapp_chats (number_id, jid, is_group, phone, last_message_at) VALUES ($1, '5547900000011@s.whatsapp.net', false, '5547900000011', now())", [numero]);
  });
  afterAll(async () => {
    if (owner) {
      await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name = $1", [instancia]).catch(() => undefined);
      await owner.query("UPDATE people SET active = false WHERE email LIKE $1", [`%-${tag}@agenda.invalid`]);
    }
    await Promise.all([owner?.end(), app?.end(), worker?.end()]);
  });

  it("o worker troca a agenda inteira (o que saiu do celular sai daqui) e marca a leitura", async () => {
    const salvar = (lista: unknown[]) => worker.query("SELECT app.whatsapp_salvar_agenda($1, $2::jsonb) AS n", [numero, JSON.stringify(lista)]);
    await salvar([
      { jid: "5547900000011@s.whatsapp.net", lid: "999001@lid", telefone: "5547900000011@s.whatsapp.net", nome: "Ana (obra)" },
      { jid: "5547900000012@s.whatsapp.net", lid: null, telefone: null, nome: "Caio" },
      { jid: "x@broadcast", nome: "Inválido" },
      { jid: "5547900000013@s.whatsapp.net", nome: "  " },
    ]);
    expect((await owner.query("SELECT jid, lid, phone, saved_name FROM whatsapp_contacts WHERE number_id = $1 ORDER BY jid", [numero])).rows).toEqual([
      { jid: "5547900000011@s.whatsapp.net", lid: "999001@lid", phone: "5547900000011", saved_name: "Ana (obra)" },
      { jid: "5547900000012@s.whatsapp.net", lid: null, phone: null, saved_name: "Caio" },
    ]);
    await salvar([{ jid: "5547900000011@s.whatsapp.net", nome: "Ana Campo" }]);
    expect((await owner.query("SELECT jid, saved_name FROM whatsapp_contacts WHERE number_id = $1", [numero])).rows).toEqual([{ jid: "5547900000011@s.whatsapp.net", saved_name: "Ana Campo" }]);
    expect((await owner.query("SELECT contacts_synced_at IS NOT NULL AS lida FROM whatsapp_numbers WHERE id = $1", [numero])).rows[0].lida).toBe(true);
    // O web não chama a função do worker.
    await expect(app.query("SELECT app.whatsapp_salvar_agenda($1, '[]'::jsonb)", [numero])).rejects.toThrow(/permission denied/);
  });

  it("RLS: o dono lê e adiciona contato; outra pessoa não lê nem grava", async () => {
    const ler = (quem: string) => withPerson(app, quem, (db) => db.execute(sql`SELECT count(*)::int AS n FROM whatsapp_contacts WHERE number_id = ${numero}::uuid`)).then((r) => r.rows[0]!.n);
    expect(await ler(dono)).toBe(1);
    expect(await ler(outro)).toBe(0);
    await withPerson(app, dono, (db) => db.execute(sql`INSERT INTO whatsapp_contacts (number_id, jid, phone, saved_name) VALUES (${numero}::uuid, '5547900000077@s.whatsapp.net', '5547900000077', 'Bruno')`));
    await expect(
      withPerson(app, outro, (db) => db.execute(sql`INSERT INTO whatsapp_contacts (number_id, jid, phone, saved_name) VALUES (${numero}::uuid, '5547900000078@s.whatsapp.net', '5547900000078', 'X')`)),
    ).rejects.toThrow();
    expect(await ler(dono)).toBe(2);
  });
});
