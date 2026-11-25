import { BusinessCalendar } from "@omni/core";
import { createPool, createWorkerDb, migrate, schema, withPerson } from "@omni/db";
import { GraphError, type EventoAgenda } from "@omni/integrations/graph";
import { LlmError, type Llm } from "@omni/integrations/openai";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resumirReunioes, syncReunioes, type FonteTranscricoes } from "./teams-reunioes.ts";

/** Reuniões do Teams no banco real (omni_test), com Graph e LLM de mentira. Missão 7801 é deste arquivo. */

const urls = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? "postgres://omni_owner:omni_owner_dev@localhost:5433/omni_test",
  worker: process.env.TEST_DATABASE_URL_WORKER ?? "postgres://omni_worker:omni_worker_dev@localhost:5433/omni_test",
  app: process.env.TEST_DATABASE_URL_APP ?? "postgres://omni_app:omni_app_dev@localhost:5433/omni_test",
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
const AGORA = new Date("2026-11-10T14:00:00Z"); // terça, 11:00 em São Paulo (janela útil)
const NOITE = new Date("2026-11-10T23:30:00Z"); // 20:30 em São Paulo

const evento = (id: string, assunto: string, extra: Partial<EventoAgenda> = {}): EventoAgenda => ({
  id,
  iCalUId: `ical-${id}`,
  subject: assunto,
  start: { dateTime: "2026-11-10T12:00:00.0000000" },
  end: { dateTime: "2026-11-10T13:00:00.0000000" },
  isCancelled: false,
  isOnlineMeeting: true,
  onlineMeeting: { joinUrl: `https://teams.microsoft.com/l/meetup-join/${id}` },
  organizer: { emailAddress: { name: "Piloto", address: "piloto@reuniao.invalid" } },
  attendees: [{ emailAddress: { name: "Cliente", address: "contato@cliente-r.invalid" } }],
  bodyPreview: "",
  ...extra,
});

const VTT = `WEBVTT

00:00:01.000 --> 00:00:05.000
<v Ana>Vamos alinhar a mobilização da 7801. O caminhão sai na segunda-feira de manhã.</v>

00:00:05.000 --> 00:00:09.000
<v Bruno>Eu confirmo a permissão de trabalho com o cliente até sexta.</v>
`;

function graph(opcoes: { transcricoes?: number; erro?: GraphError } = {}): FonteTranscricoes & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    usuarioId: async (email) => (chamadas.push(`usuario:${email}`), email.endsWith("@reuniao.invalid") ? "00000000-0000-0000-0000-000000000001" : null),
    reuniaoOnline: async () => (chamadas.push("reuniao"), "MSoxMjM0NTY3ODkwYWJjZGVm"),
    transcricoes: async () => {
      chamadas.push("transcricoes");
      if (opcoes.erro) throw opcoes.erro;
      return Array.from({ length: opcoes.transcricoes ?? 1 }, (_, i) => ({ id: `MSMjMCMjdHJhbnNjcmljYW8${i}`, criadaEm: `2026-11-10T13:0${i}:00Z` }));
    },
    conteudoTranscricao: async () => (chamadas.push("conteudo"), VTT),
  };
}

function llm(entradas: string[], erro?: LlmError): Llm {
  return {
    async estruturado<T>(p: { entrada: string }) {
      entradas.push(p.entrada);
      if (erro) throw erro;
      const dados = {
        resumo: "Alinhada a mobilização da missão 7801.",
        decisoes: ["Caminhão sai na segunda de manhã"],
        pendencias: [{ descricao: "Confirmar a permissão de trabalho com o cliente", responsavel: "Bruno", prazo: "sexta" }],
      };
      return { dados: dados as T, modelo: "modelo-teste", tokensEntrada: 500, tokensSaida: 80, duracaoMs: 1200 };
    },
  };
}

describe.skipIf(!available)("reuniões do Teams", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let app: pg.Pool;
  let missao: string;
  const db = () => createWorkerDb(worker);

  const limpar = async () => {
    await owner.query("DELETE FROM meetings WHERE ical_uid LIKE 'ical-r%'");
    await owner.query("DELETE FROM mail_mailboxes WHERE email LIKE '%@reuniao.invalid'");
    await owner.query("DELETE FROM missions WHERE code = '7801'");
  };

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    app = createPool(urls.app, 2);
  });

  beforeEach(async () => {
    await limpar();
    missao = (
      await owner.query<{ id: string }>(
        `INSERT INTO missions (code, filtroapp_project_id, client_name, is_active, filtroapp_updated_at)
         VALUES ('7801', 'tr-7801', 'Cliente R', true, now()) RETURNING id`,
      )
    ).rows[0]!.id;
    await owner.query("INSERT INTO mail_mailboxes (email) VALUES ('piloto@reuniao.invalid')");
  });

  afterAll(async () => {
    await limpar();
    await Promise.all([owner?.end(), worker?.end(), app?.end()]);
  });

  // Outras caixas ativas no banco de teste (de outros arquivos) não têm eventos.
  const agenda = (eventos: EventoAgenda[]) => ({ agenda: async (caixa: string) => (caixa === "piloto@reuniao.invalid" ? eventos : []) });

  it("guarda só as reuniões ligadas a uma missão e tira as que somem da agenda", async () => {
    const r = await syncReunioes(db(), agenda([evento("r1", "7801 - alinhamento da mobilização"), evento("r2", "Almoço"), evento("r3", "7801 cancelada", { isCancelled: true })]), {
      now: () => AGORA,
    });
    expect(r).toMatchObject({ eventos: 3, guardadas: 1 });
    const [m] = await db().select().from(schema.meetings).where(eq(schema.meetings.icalUid, "ical-r1"));
    expect(m).toMatchObject({ subject: "7801 - alinhamento da mobilização", transcriptStatus: "pendente", organizerAddress: "piloto@reuniao.invalid" });
    expect(m!.startsAt.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    const links = await db().select().from(schema.meetingMissions).where(eq(schema.meetingMissions.meetingId, m!.id));
    expect(links).toEqual([expect.objectContaining({ missionId: missao, motivo: "numero" })]);

    // Saiu da agenda: some do Omni.
    expect((await syncReunioes(db(), agenda([evento("r2", "Almoço")]), { now: () => AGORA })).removidas).toBe(1);
    expect(await db().select().from(schema.meetings).where(eq(schema.meetings.icalUid, "ical-r1"))).toEqual([]);
  });

  it("resume a transcrição, não guarda o texto e publica no Gerencial só na janela útil", async () => {
    await syncReunioes(db(), agenda([evento("r1", "7801 - alinhamento")]), { now: () => AGORA });
    const entradas: string[] = [];
    const g = graph({ transcricoes: 2 });

    const noite = await resumirReunioes(db(), g, llm(entradas), cal, { modelo: "m", now: () => NOITE });
    expect(noite).toMatchObject({ verificadas: 1, resumidas: 1, publicadas: 0 });
    expect(entradas[0]).toContain("Ana: Vamos alinhar a mobilização da 7801.");
    expect(g.chamadas.filter((c) => c === "conteudo")).toHaveLength(2); // as duas partes da reunião

    const [m] = await db().select().from(schema.meetings).where(eq(schema.meetings.icalUid, "ical-r1"));
    expect(m!.transcriptStatus).toBe("resumida");
    expect(m!.summary!.pendencias[0]).toMatchObject({ responsavel: "Bruno", prazo: "sexta" });
    expect(JSON.stringify(m)).not.toContain("Vamos alinhar"); // a transcrição não fica no banco
    const registros = await db().execute<{ purpose: string }>(sql`SELECT purpose FROM llm_calls WHERE data_ids->>'meetingId' = ${m!.id}`);
    expect(registros.rows).toEqual([{ purpose: "reuniao_resumo" }]);

    const manha = new Date("2026-11-11T12:00:00Z"); // 09:00 do dia seguinte
    expect((await resumirReunioes(db(), g, llm(entradas), cal, { modelo: "m", now: () => manha })).publicadas).toBe(1);
    const msgs = await db().select().from(schema.missionMessages).where(eq(schema.missionMessages.missionId, missao));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ channel: "gerencial", kind: "ia" });
    expect(msgs[0]!.body).toContain("• Confirmar a permissão de trabalho com o cliente — Bruno (sexta)");
    expect((await resumirReunioes(db(), g, llm(entradas), cal, { modelo: "m", now: () => manha })).publicadas).toBe(0);
    expect(entradas).toHaveLength(1);
  });

  it("acesso às transcrições desligado no tenant: marca e para a rodada; sem transcrição: tenta de novo depois", async () => {
    await syncReunioes(db(), agenda([evento("r1", "7801 - a"), evento("r4", "7801 - b", { start: { dateTime: "2026-11-10T10:00:00" }, end: { dateTime: "2026-11-10T11:00:00" } })]), {
      now: () => AGORA,
    });
    const desligado = new GraphError("Graph respondeu 403 (Forbidden)", 403, "Forbidden", "GraphAccessToTranscriptsDisabled");
    const r = await resumirReunioes(db(), graph({ erro: desligado }), llm([]), cal, { modelo: "m", now: () => AGORA });
    expect(r).toMatchObject({ verificadas: 1, acessoDesligado: true });
    const status = async () =>
      Object.fromEntries((await db().select().from(schema.meetings).where(sql`ical_uid LIKE 'ical-r%'`)).map((m) => [m.icalUid, [m.transcriptStatus, m.transcriptAttempts]]));
    expect(await status()).toEqual({ "ical-r4": ["acesso_desligado", 0], "ical-r1": ["pendente", 0] });

    // Uma hora depois, sem transcrição ainda: conta tentativa e volta mais tarde.
    const depois = new Date(AGORA.getTime() + 60 * 60_000);
    const s = await resumirReunioes(db(), graph({ transcricoes: 0 }), llm([]), cal, { modelo: "m", now: () => depois });
    expect(s).toMatchObject({ verificadas: 2, semTranscricao: 2 });
    expect(await status()).toEqual({ "ical-r4": ["sem_transcricao", 1], "ical-r1": ["sem_transcricao", 1] });
  });

  it("sem crédito na OpenAI: volta para a fila sem gastar tentativa", async () => {
    await syncReunioes(db(), agenda([evento("r1", "7801 - alinhamento")]), { now: () => AGORA });
    const r = await resumirReunioes(db(), graph(), llm([], new LlmError("sem crédito", 429, "credit_balance_exhausted")), cal, { modelo: "m", now: () => AGORA });
    expect(r).toMatchObject({ resumidas: 0, erros: 1 });
    const [m] = await db().select().from(schema.meetings).where(eq(schema.meetings.icalUid, "ical-r1"));
    expect([m!.transcriptStatus, m!.transcriptAttempts, m!.summary]).toEqual(["pendente", 0, null]);
  });

  it("só diretoria e gerentes veem as reuniões da missão; o app não lê as tabelas", async () => {
    await syncReunioes(db(), agenda([evento("r1", "7801 - alinhamento")]), { now: () => AGORA });
    const pessoa = async (perfil: string) => {
      const id = (await owner.query<{ id: string }>(`INSERT INTO people (email, display_name) VALUES ('r.' || gen_random_uuid() || '@filtrovali.com.br', 'Pessoa') RETURNING id`)).rows[0]!.id;
      await owner.query("INSERT INTO person_profiles (person_id, profile) VALUES ($1, $2)", [id, perfil]);
      return id;
    };
    const [gerente, operacao] = [await pessoa("gerente"), await pessoa("operacao")];
    const ler = (quem: string, q: ReturnType<typeof sql>) => withPerson(app, quem, (d) => d.execute<Record<string, unknown>>(q)).then((x) => x.rows);
    const lista = sql`SELECT subject, transcript_status, motivos FROM app.reunioes_da_missao(${missao}::uuid)`;
    expect(await ler(gerente, lista)).toEqual([{ subject: "7801 - alinhamento", transcript_status: "pendente", motivos: [{ motivo: "numero", detalhe: expect.any(String) }] }]);
    expect(await ler(operacao, lista)).toEqual([]);
    await expect(ler(gerente, sql`SELECT 1 FROM meetings`)).rejects.toThrow();
    await expect(ler(gerente, sql`SELECT 1 FROM meeting_missions`)).rejects.toThrow();
  });
});
