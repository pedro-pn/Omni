import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import { WhatsAppError, type WhatsApp } from "@omni/integrations/whatsapp";
import { like } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { conferirNumeros } from "./estado.ts";

/** Conferência do estado dos números de WhatsApp (instâncias "omni-wkr…" são deste arquivo). */

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

describe.skipIf(!available)("estado dos números de WhatsApp", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  const db = () => createWorkerDb(worker);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name LIKE 'omni-wkr%'");
    await owner.query(
      `INSERT INTO whatsapp_numbers (instance_name, label, purpose, status, phone) VALUES
         ('omni-wkr001', 'Operação', 'operacao', 'conectado', '5547900000001'),
         ('omni-wkr002', 'Campo', 'campo', 'criado', NULL),
         ('omni-wkr003', 'Gestão', 'gestao', 'conectando', NULL),
         ('omni-wkr004', 'Antigo', 'outro', 'removido', NULL)`,
    );
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM whatsapp_numbers WHERE instance_name LIKE 'omni-wkr%'");
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const comoEsta = async (i: string): Promise<Awaited<ReturnType<WhatsApp["estado"]>>> => {
    const [n] = (await owner.query<{ status: string; phone: string | null }>("SELECT status, phone FROM whatsapp_numbers WHERE instance_name = $1", [i])).rows;
    const estado = n?.status === "conectado" ? "conectado" : n?.status === "conectando" ? "conectando" : "desconectado";
    return { estado, telefone: n?.phone ?? null, nomePerfil: null };
  };
  const lista = async () =>
    Object.fromEntries((await db().select().from(schema.whatsappNumbers).where(like(schema.whatsappNumbers.instanceName, "omni-wkr%"))).map((n) => [n.instanceName, [n.status, n.phone, Boolean(n.lastError)]]));

  it("atualiza com o que a Evolution diz; não mexe nos removidos; 'criado' fica até parear", async () => {
    const estados: Record<string, Awaited<ReturnType<WhatsApp["estado"]>>> = {
      "omni-wkr001": { estado: "desconectado", telefone: null, nomePerfil: null },
      "omni-wkr002": { estado: "desconectado", telefone: null, nomePerfil: null },
      "omni-wkr003": { estado: "conectado", telefone: "5547900000003", nomePerfil: "Gestão" },
    };
    const chamadas: string[] = [];
    // Números de outros arquivos de teste respondem com o estado que já têm (sem mexer neles).
    const r = await conferirNumeros(db(), { estado: async (i) => (chamadas.push(i), estados[i] ?? (await comoEsta(i))) });
    expect(r.erros).toBe(0);
    expect(chamadas).not.toContain("omni-wkr004");
    expect(await lista()).toEqual({
      "omni-wkr001": ["desconectado", "5547900000001", false],
      "omni-wkr002": ["criado", null, false],
      "omni-wkr003": ["conectado", "5547900000003", false],
      "omni-wkr004": ["removido", null, false],
    });
  });

  it("Evolution fora do ar: para a rodada sem mudar nada; aparelho repetido vira aviso", async () => {
    const fora = await conferirNumeros(db(), { estado: async () => { throw new WhatsAppError("fora", 503, "indisponivel"); } });
    expect(fora.erros).toBe(1);
    const repetido = await conferirNumeros(db(), {
      estado: async (i) =>
        i === "omni-wkr003" ? { estado: "conectado", telefone: "5547900000001", nomePerfil: null } : i.startsWith("omni-wkr") ? { estado: "conectado", telefone: null, nomePerfil: null } : comoEsta(i),
    });
    expect(repetido.erros).toBe(0);
    expect((await lista())["omni-wkr003"]).toEqual(["conectado", null, true]);
  });
});
