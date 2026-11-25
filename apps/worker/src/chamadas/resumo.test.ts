import { createPool, createWorkerDb, migrate } from "@omni/db";
import type { Llm, Transcritor } from "@omni/integrations/openai";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { partesDoMono, resumirChamadas, wavParaMono } from "./resumo.ts";

/** Resumo das ligações gravadas, no banco real (omni_test). Instância omni-resumoteste01 é deste arquivo. */

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

/** WAV estéreo 16 bits, 16 kHz: canal 0 = a, canal 1 = b. */
function wavEstereo(segundos: number, a = 1000, b = 3000): Uint8Array {
  const quadros = Math.round(segundos * 16000);
  const w = new Uint8Array(44 + quadros * 4);
  const v = new DataView(w.buffer);
  const t = (o: number, s: string) => [...s].forEach((c, i) => (w[o + i] = c.charCodeAt(0)));
  t(0, "RIFF");
  v.setUint32(4, 36 + quadros * 4, true);
  t(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 64000, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  t(36, "data");
  v.setUint32(40, quadros * 4, true);
  for (let q = 0; q < quadros; q += 1) {
    v.setInt16(44 + q * 4, a, true);
    v.setInt16(46 + q * 4, b, true);
  }
  return w;
}

describe("WAV para mono", () => {
  it("média dos dois canais, mesma taxa, duração certa; outro formato devolve null", () => {
    const m = wavParaMono(wavEstereo(0.5))!;
    expect(m.segundos).toBeCloseTo(0.5);
    const v = new DataView(m.audio.buffer);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getInt16(44, true)).toBe(2000);
    expect(m.audio.byteLength).toBe(44 + 8000 * 2);
    expect(wavParaMono(new Uint8Array(10))).toBeNull();
  });

  it("ligação longa: partes de até 10 min, cada uma um WAV válido, sem perder amostras", () => {
    const m = wavParaMono(wavEstereo(25 * 60))!; // 25 min
    const partes = partesDoMono(m.audio);
    expect(partes).toHaveLength(3);
    const segundos = partes.map((p) => new DataView(p.buffer).getUint32(40, true) / 2 / 16000);
    expect(segundos).toEqual([600, 600, 300]);
    for (const p of partes) {
      const v = new DataView(p.buffer);
      expect(String.fromCharCode(...p.subarray(0, 4))).toBe("RIFF");
      expect(v.getUint32(4, true)).toBe(p.byteLength - 8);
      expect(p.byteLength).toBeLessThan(25 * 1024 * 1024);
    }
    expect(partes.reduce((n, p) => n + p.byteLength - 44, 0)).toBe(m.audio.byteLength - 44);
    expect(partesDoMono(wavParaMono(wavEstereo(0.5))!.audio)).toHaveLength(1);
  });
});

describe.skipIf(!available)("resumo das ligações gravadas", () => {
  let owner: pg.Pool;
  let worker: pg.Pool;
  let dono: string;
  let numero: string;
  const transcricoes: number[] = [];
  const entradas: string[] = [];
  const transcritor: Transcritor = {
    async transcrever(p) {
      transcricoes.push(p.audio.byteLength);
      return { texto: "Bom dia, aqui é da Filtrovali. Combinamos que o relatório de flushing vai na sexta.", modelo: "transcritor-teste", duracaoMs: 100 };
    },
  };
  const llm: Llm = {
    async estruturado<T>(p: { entrada: string }) {
      entradas.push(p.entrada);
      const dados = { resumo: "Ficou combinado o envio do relatório de flushing.", decisoes: ["Relatório na sexta"], pendencias: [{ descricao: "Enviar o relatório", responsavel: "Colaborador", prazo: "sexta" }] };
      return { dados: dados as T, modelo: "modelo-teste", tokensEntrada: 300, tokensSaida: 40, duracaoMs: 200 };
    },
  };
  const audios = new Map<string, Uint8Array>();
  const deps = () => ({ buscarAudio: async (c: { recordingId: string }) => audios.get(c.recordingId) ?? null, transcritor, llm, modelo: "modelo-teste", modeloTranscricao: "transcritor-teste" });
  const chamada = async (rec: string, segundos: number) => {
    const fim = new Date(Date.now() - 60_000);
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO whatsapp_calls (number_id, owner_person_id, recording_id, peer, direction, state, created_at, started_at, ended_at, recording, audio, expires_at)
       VALUES ($1, $2, $3, '5547999990001', 'saida', 'encerrada', $4, $4, $5, true, true, now() + interval '1 day') RETURNING id`,
      [numero, dono, rec, new Date(fim.getTime() - segundos * 1000), fim],
    );
    // O dono pediu o resumo na tela.
    await owner.query("UPDATE whatsapp_calls SET summary_status = 'pendente' WHERE id = $1", [rows[0]!.id]);
    audios.set(rec, wavEstereo(segundos));
    return rows[0]!.id;
  };

  beforeAll(async () => {
    await migrate(urls.owner);
    owner = createPool(urls.owner, 2);
    worker = createPool(urls.worker, 2);
    await owner.query("DELETE FROM whatsapp_calls WHERE number_id IN (SELECT id FROM whatsapp_numbers WHERE instance_name = 'omni-resumoteste01')");
    await owner.query("DELETE FROM whatsapp_numbers WHERE instance_name = 'omni-resumoteste01'");
    await owner.query("DELETE FROM people WHERE email = 'dono@resumo-teste.invalid'");
    dono = (await owner.query<{ id: string }>("INSERT INTO people (email, display_name) VALUES ('dono@resumo-teste.invalid', 'Dono') RETURNING id")).rows[0]!.id;
    numero = (
      await owner.query<{ id: string }>("INSERT INTO whatsapp_numbers (instance_name, label, purpose, owner_person_id, status) VALUES ('omni-resumoteste01', 'Teste', 'outro', $1, 'desconectado') RETURNING id", [dono])
    ).rows[0]!.id;
    // Chamadas gravadas de outros testes no mesmo banco não entram nesta rodada.
    await owner.query("UPDATE whatsapp_calls SET summary_status = 'sem_fala' WHERE number_id <> $1 AND summary_status IS NULL", [numero]);
  });
  afterAll(async () => {
    await owner?.query("DELETE FROM whatsapp_calls WHERE number_id = $1", [numero]);
    await owner?.query("DELETE FROM whatsapp_numbers WHERE id = $1", [numero]);
    await owner?.query("DELETE FROM people WHERE id = $1", [dono]);
    await Promise.all([owner?.end(), worker?.end()]);
  });

  it("transcreve em mono, resume e guarda a transcrição e o resumo; curta vira sem fala; não repete", async () => {
    const longa = await chamada("a".repeat(32), 4);
    const curta = await chamada("b".repeat(32), 1);
    const r = await resumirChamadas(createWorkerDb(worker), deps());
    expect(r).toMatchObject({ resumidas: 1, semFala: 1, erros: 0 });
    expect(transcricoes).toEqual([44 + 4 * 16000 * 2]); // a curta não vai à OpenAI
    expect(entradas[0]).toContain("Ligação feita para: (47) 99999-0001");
    const [l] = await owner.query("SELECT summary, summary_status, summary_model, transcript FROM whatsapp_calls WHERE id = $1", [longa]).then((x) => x.rows);
    expect(l).toMatchObject({
      summary_status: "resumida",
      summary_model: "modelo-teste",
      summary: { resumo: "Ficou combinado o envio do relatório de flushing." },
      transcript: "Bom dia, aqui é da Filtrovali. Combinamos que o relatório de flushing vai na sexta.",
    });
    expect((await owner.query("SELECT summary_status FROM whatsapp_calls WHERE id = $1", [curta])).rows[0]).toEqual({ summary_status: "sem_fala" });
    const usos = await owner.query("SELECT purpose FROM llm_calls WHERE data_ids->>'callId' = $1 ORDER BY created_at", [longa]);
    expect(usos.rows.map((u) => u.purpose)).toEqual(["chamada_transcricao", "chamada_resumo"]);
    expect(await resumirChamadas(createWorkerDb(worker), deps())).toMatchObject({ resumidas: 0, semFala: 0 });
  });

  it("áudio que sumiu conta tentativa e para em erro; excluir a gravação apaga o resumo e a transcrição", async () => {
    const sumiu = await chamada("c".repeat(32), 5);
    audios.delete("c".repeat(32));
    for (let i = 0; i < 4; i += 1) await resumirChamadas(createWorkerDb(worker), deps());
    expect((await owner.query("SELECT summary_status, summary_attempts FROM whatsapp_calls WHERE id = $1", [sumiu])).rows[0]).toEqual({ summary_status: "erro", summary_attempts: 3 });
    const [resumida] = (await owner.query("SELECT id FROM whatsapp_calls WHERE number_id = $1 AND summary_status = 'resumida'", [numero])).rows;
    await owner.query("UPDATE whatsapp_calls SET deleted_at = now(), audio = false WHERE id = $1", [resumida.id]);
    expect((await owner.query("SELECT summary, summary_status, transcript FROM whatsapp_calls WHERE id = $1", [resumida.id])).rows[0]).toEqual({ summary: null, summary_status: null, transcript: null });
  });

  it("sem pedido do dono, nada vai à OpenAI", async () => {
    const fim = new Date(Date.now() - 60_000);
    const { rows } = await owner.query<{ id: string }>(
      `INSERT INTO whatsapp_calls (number_id, owner_person_id, recording_id, peer, direction, state, created_at, started_at, ended_at, recording, audio, expires_at)
       VALUES ($1, $2, $3, '5547999990001', 'entrada', 'encerrada', $4, $4, $5, true, true, now() + interval '1 day') RETURNING id`,
      [numero, dono, "d".repeat(32), new Date(fim.getTime() - 10_000), fim],
    );
    audios.set("d".repeat(32), wavEstereo(10));
    const antes = transcricoes.length;
    await resumirChamadas(createWorkerDb(worker), deps());
    expect(transcricoes.length).toBe(antes);
    expect((await owner.query("SELECT summary_status FROM whatsapp_calls WHERE id = $1", [rows[0]!.id])).rows[0]).toEqual({ summary_status: null });
  });

  it("o worker não lê nem altera o que não é dele na chamada", async () => {
    await expect(worker.query("SELECT state FROM whatsapp_calls LIMIT 1")).rejects.toThrow(/permission denied/);
    await expect(worker.query("UPDATE whatsapp_calls SET audio = false WHERE number_id = $1", [numero])).rejects.toThrow(/permission denied/);
  });
});
