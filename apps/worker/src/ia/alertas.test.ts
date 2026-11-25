import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate, schema } from "@omni/db";
import type { Llm } from "@omni/integrations/openai";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enviarPush } from "../push/enviar.ts";
import { aoMensagemDeCanal } from "../push/eventos.ts";
import { conferirAlertas, publicarDisparos } from "./alertas.ts";

/** Alertas pedidos à IA e push, no banco real (omni_test). Missão 7951 é deste arquivo. */

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
const cal = new BusinessCalendar();

// O "modelo": acha a metragem quando o RDO diz "liberado: N m"; inventa um trecho no RDO 03.
function llm(chamadas: string[]): Llm {
  return {
    async estruturado<T>(p: { entrada: string }) {
      chamadas.push(p.entrada);
      const m = p.entrada.match(/liberado: \d+ m/);
      const dados = p.entrada.includes("RDO03") ? { presente: true, trecho: "200 metros liberados ontem" } : m ? { presente: true, trecho: m[0] } : { presente: false, trecho: null };
      return { dados: dados as T, modelo: "modelo-teste", tokensEntrada: 200, tokensSaida: 10, duracaoMs: 300 };
    },
  };
}

describe.skipIf(!available)("alertas pedidos à IA", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let missao: string;
  let lider: string;
  let criador: string;
  const db = () => createWorkerDb(worker);

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
  });
  beforeEach(async () => {
    await owner.query("DELETE FROM missions WHERE code = '7951'");
    await owner.query("DELETE FROM people WHERE email LIKE '%@alerta-teste.invalid'");
    missao = (await owner.query<{ id: string }>("INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at) VALUES ('7951', 'al-7951', 'Cliente A', true, now()) RETURNING id")).rows[0]!.id;
    lider = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('lider@alerta-teste.invalid', 'Ana Líder') RETURNING id")).rows[0]!.id;
    criador = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('quem@alerta-teste.invalid', 'Bruno Pediu') RETURNING id")).rows[0]!.id;
    await owner.query("INSERT INTO mission_responsibles (mission_id, role, name, email, filtroapp_updated_at) VALUES ($1, 'LEADER', 'Ana Líder', 'lider@alerta-teste.invalid', now())", [missao]);
    const rdo = (id: string, data: string, texto: string) =>
      owner.query("INSERT INTO reports (id, mission_id, report_type, report_number, status, report_date, daily_description, filtroapp_updated_at) VALUES ($1, $2, 'RDO', $3, 'APPROVED', $4, $5, now())", [
        `al-${id}`, missao, id.slice(-2), data, `${id}: ${texto} Serviço de flushing da linha de retorno em andamento.`,
      ]);
    await rdo("RDO01", "2026-11-02", "Frente liberado: 120 m pelo cliente.");
    await rdo("RDO02", "2026-11-03", "Sem informação de frente.");
    await rdo("RDO03", "2026-11-04", "Sem informação de frente.");
    await owner.query(
      `INSERT INTO ai_alerts (mission_id, channel, created_by, request_text, spec, status, prompt_version)
       VALUES ($1, 'interno', $2, 'me avise se não vier a metragem liberada', $3, 'ativo', 't')`,
      [missao, criador, JSON.stringify({ fonte: "rdo", tipo: "ausencia", oQue: "metros liberados pelo cliente", dias: 2, marcar: "LEADER" })],
    );
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM missions WHERE code = '7951'");
    await owner?.query("DELETE FROM people WHERE email LIKE '%@alerta-teste.invalid'");
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("dispara com 2 RDOs seguidos sem a informação (trecho inventado não conta); publica só na janela útil; avisa quem foi marcado", async () => {
    const chamadas: string[] = [];
    const r = await conferirAlertas(db(), llm(chamadas), { modelo: "m" });
    expect(r).toMatchObject({ lidos: 2, disparos: 1 }); // recém-ativado: os últimos 2 RDOs
    const [alerta] = await db().select().from(schema.aiAlerts).where(eq(schema.aiAlerts.missionId, missao));
    expect([alerta!.fires, alerta!.afterDate]).toEqual([1, "2026-11-04"]);
    const [disparo] = await db().select().from(schema.aiAlertFires).where(eq(schema.aiAlertFires.alertId, alerta!.id));
    expect(disparo!.reportIds).toEqual(["al-RDO02", "al-RDO03"]);

    expect((await publicarDisparos(db(), cal, new Date("2026-11-07T15:00:00Z"))).publicados).toBe(0); // sábado
    expect((await publicarDisparos(db(), cal, new Date("2026-11-09T12:00:00Z"))).publicados).toBe(1); // segunda, 09:00
    const msgs = await db().select().from(schema.missionMessages).where(eq(schema.missionMessages.missionId, missao));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ channel: "interno", kind: "ia", alertFireId: disparo!.id });
    expect(msgs[0]!.body).toContain("@Ana (líder de projetos)");
    expect(msgs[0]!.body).toContain("RDO nº 02 (03/11), RDO nº 03 (04/11)");
    const avisos = await db().select().from(schema.notifications).where(eq(schema.notifications.missionId, missao));
    expect(avisos.map((a) => [a.personId, a.kind])).toEqual([[lider, "ia_alerta"]]);

    // Nada novo: não lê de novo nem dispara.
    expect(await conferirAlertas(db(), llm(chamadas), { modelo: "m" })).toMatchObject({ lidos: 0, disparos: 0 });
    expect(chamadas).toHaveLength(2);
  });

  it("push de mensagem do canal: só quem acompanha, sem o autor, respeitando a preferência; aparelho expirado sai", async () => {
    await owner.query("INSERT INTO mission_members (mission_id, channel, person_id, added_by) VALUES ($1, 'interno', $2, $2)", [missao, criador]);
    const outro = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('fora@alerta-teste.invalid', 'Fora') RETURNING id")).rows[0]!.id;
    for (const [p, n] of [[lider, 1], [criador, 2], [outro, 3]] as const) {
      await owner.query("INSERT INTO push_subscriptions (person_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)", [p, `https://push.invalid/al-${n}`, "B".repeat(87), "a".repeat(22)]);
    }
    const m = (await owner.query<{ id: string }>("INSERT INTO mission_messages (mission_id, channel, author_person_id, body) VALUES ($1, 'interno', $2, 'Chegamos na obra') RETURNING id", [missao, criador])).rows[0]!.id;
    const enviados: string[] = [];
    const enviar = async (a: { endpoint: string }, carga: string) => {
      enviados.push(`${a.endpoint}|${JSON.parse(carga).corpo}`);
    };
    await aoMensagemDeCanal(db(), enviar, { missionId: missao, channel: "interno", id: m });
    expect(enviados).toEqual(["https://push.invalid/al-1|Bruno: Chegamos na obra"]); // o líder; não o autor nem quem é de fora

    await owner.query("INSERT INTO push_preferences (person_id, canais) VALUES ($1, false)", [lider]);
    enviados.length = 0;
    await aoMensagemDeCanal(db(), enviar, { missionId: missao, channel: "interno", id: m });
    expect(enviados).toEqual([]);

    // Aviso (sino) ignora a preferência de canais; aparelho que sumiu (410) é removido.
    const expirado = async () => {
      throw Object.assign(new Error("Gone"), { statusCode: 410 });
    };
    expect(await enviarPush(db(), expirado, [lider], "aviso", { titulo: "t", corpo: "c", url: "/", tag: "x" })).toEqual({ enviados: 0, removidos: 1 });
    expect((await owner.query("SELECT count(*)::int AS n FROM push_subscriptions WHERE person_id = $1", [lider])).rows[0]).toEqual({ n: 0 });
  });
});
