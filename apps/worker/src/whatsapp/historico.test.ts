import { createPool, createWorkerDb, migrate } from "@omni/db";
import { WhatsAppError } from "@omni/integrations/whatsapp";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { recuperarRecentes, type FonteHistorico } from "./historico.ts";

/** Histórico escolhido e recuperação do WhatsApp (instância "omni-hst001" é deste arquivo). */

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

const GRUPO = "120363000000000777@g.us";
const OUTRO_GRUPO = "120363000000000888@g.us";
const PESSOA = "5547933330000@s.whatsapp.net";
const s = (d: string) => Math.floor(new Date(d).getTime() / 1000);
const reg = (jid: string, id: string, quando: string, texto: string, extra: Record<string, unknown> = {}) => ({
  key: { remoteJid: jid, fromMe: false, id, ...(jid.endsWith("@g.us") ? { participant: "5547911110000@s.whatsapp.net" } : {}) },
  pushName: "Líder",
  message: { conversation: texto },
  messageTimestamp: s(quando),
  ...extra,
});
// O que a Evolution guardou do pareamento: dois grupos e uma conversa pessoal.
const GUARDADO = [
  reg(GRUPO, "G1", "2026-09-01T12:00:00Z", "Mobilização confirmada"),
  reg(GRUPO, "G2", "2026-09-02T12:00:00Z", "Chegamos"),
  reg(OUTRO_GRUPO, "O1", "2026-09-03T12:00:00Z", "Churrasco sábado"),
  reg(PESSOA, "P1", "2026-09-04T12:00:00Z", "conversa pessoal"),
];

function fonte(registros = GUARDADO, erro?: WhatsAppError): FonteHistorico & { pedidos: string[] } {
  const pedidos: string[] = [];
  return {
    pedidos,
    async mensagens(instancia, filtro, pagina) {
      // Números de outros arquivos de teste não têm nada guardado.
      if (instancia !== "omni-hst001") return { registros: [], paginas: 0, total: 0 };
      pedidos.push(`${filtro.jid ?? "todas"}:${pagina}`);
      if (erro) throw erro;
      const lista = registros.filter((r) => (!filtro.jid || r.key.remoteJid === filtro.jid) && (!filtro.desde || r.messageTimestamp >= s(filtro.desde.toISOString())));
      // Duas páginas de 1 para conferir a paginação.
      return { registros: lista.slice(pagina - 1, pagina), paginas: lista.length, total: lista.length };
    },
    async infoGrupo(_i, jid) {
      return jid === GRUPO ? { nome: "Missão 7901 - Cliente H", participantes: 9 } : null;
    },
  };
}

describe.skipIf(!available)("histórico do WhatsApp", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let numero: string;
  const db = () => createWorkerDb(worker);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name = 'omni-hst001'");
    numero = (await owner.query<{ id: string }>("INSERT INTO whatsapp_numbers (instance_name, label, purpose, status) VALUES ('omni-hst001', 'Hist', 'operacao', 'conectado') RETURNING id")).rows[0]!.id;
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM whatsapp_numbers WHERE instance_name = 'omni-hst001'");
    await Promise.all([owner?.end(), worker?.end()]);
  });

  const conversas = async () =>
    (await owner.query("SELECT c.jid, c.name, count(m.id)::int AS n FROM whatsapp_chats c LEFT JOIN whatsapp_messages m ON m.chat_id = c.id WHERE c.number_id = $1 GROUP BY c.jid, c.name ORDER BY c.jid", [numero])).rows;

  it("recuperação: grava só as últimas horas, inclusive conversas novas, sem duplicar", async () => {
    const agora = new Date("2026-09-04T13:00:00Z");
    const f = fonte();
    expect(await recuperarRecentes(db(), f, { horas: 2, now: () => agora })).toMatchObject({ novas: 1 });
    expect(await conversas()).toEqual([{ jid: PESSOA, name: "Líder", n: 1 }]);
    expect((await recuperarRecentes(db(), f, { horas: 2, now: () => agora })).novas).toBe(0);
  });
});
