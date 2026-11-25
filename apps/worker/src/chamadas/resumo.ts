import { entradaResumoChamada, SISTEMA_RESUMO_CHAMADA, ESQUEMA_RESUMO_REUNIAO, validarResumo, VERSAO_PROMPT_CHAMADA, formatarTelefone } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { LlmError, type Llm, type Transcritor } from "@omni/integrations/openai";
import { and, asc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";

/**
 * Resumo das ligações gravadas (job `chamadas-resumo`, IA_RESUMO_CHAMADA), só
 * das que o dono pediu na tela (status 'pendente'): o áudio vem do serviço de voz, os dois canais viram um só (mono, 16 kHz), em
 * partes de até 10 min (o limite da transcrição é 25 MB, ~13 min), a OpenAI transcreve cada parte e resume o todo.
 * A transcrição fica só na memória desta rodada; o banco guarda o resumo.
 */

const MAX_TENTATIVAS = 3;
const SEM_CREDITO = new Set(["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached"]);

/** WAV PCM 16 bits com N canais → WAV mono (média dos canais). null se o formato não for esse. */
export function wavParaMono(wav: Uint8Array): { audio: Uint8Array; segundos: number } | null {
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const texto = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n));
  if (wav.byteLength < 44 || texto(0, 4) !== "RIFF" || texto(8, 4) !== "WAVE") return null;
  let canais = 0;
  let taxa = 0;
  let bits = 0;
  let inicio = -1;
  let tamanho = 0;
  for (let o = 12; o + 8 <= wav.byteLength; ) {
    const id = texto(o, 4);
    const n = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      if (v.getUint16(o + 8, true) !== 1) return null; // só PCM
      canais = v.getUint16(o + 10, true);
      taxa = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === "data") {
      inicio = o + 8;
      tamanho = Math.min(n, wav.byteLength - inicio);
      break;
    }
    o += 8 + n + (n % 2);
  }
  if (inicio < 0 || bits !== 16 || canais < 1 || !taxa) return null;
  const quadros = Math.floor(tamanho / (2 * canais));
  const saida = new Uint8Array(44 + quadros * 2);
  const s = new DataView(saida.buffer);
  const escreve = (o: number, t: string) => [...t].forEach((c, i) => (saida[o + i] = c.charCodeAt(0)));
  escreve(0, "RIFF");
  s.setUint32(4, 36 + quadros * 2, true);
  escreve(8, "WAVEfmt ");
  s.setUint32(16, 16, true);
  s.setUint16(20, 1, true);
  s.setUint16(22, 1, true);
  s.setUint32(24, taxa, true);
  s.setUint32(28, taxa * 2, true);
  s.setUint16(32, 2, true);
  s.setUint16(34, 16, true);
  escreve(36, "data");
  s.setUint32(40, quadros * 2, true);
  for (let q = 0; q < quadros; q += 1) {
    let soma = 0;
    for (let c = 0; c < canais; c += 1) soma += v.getInt16(inicio + (q * canais + c) * 2, true);
    s.setInt16(44 + q * 2, Math.max(-32768, Math.min(32767, Math.round(soma / canais))), true);
  }
  return { audio: saida, segundos: quadros / taxa };
}

/** Partes de até `maxSegundos` de um WAV mono 16 bits (cada uma com o próprio cabeçalho), na ordem. */
export function partesDoMono(mono: Uint8Array, maxSegundos = 600): Uint8Array[] {
  const v = new DataView(mono.buffer, mono.byteOffset, mono.byteLength);
  const taxa = v.getUint32(24, true);
  const dados = mono.subarray(44);
  const porParte = Math.max(2, Math.floor(maxSegundos * taxa) * 2);
  const partes: Uint8Array[] = [];
  for (let o = 0; o < dados.byteLength; o += porParte) {
    const pedaco = dados.subarray(o, Math.min(o + porParte, dados.byteLength));
    const parte = new Uint8Array(44 + pedaco.byteLength);
    parte.set(mono.subarray(0, 44));
    const p = new DataView(parte.buffer);
    p.setUint32(4, 36 + pedaco.byteLength, true);
    p.setUint32(40, pedaco.byteLength, true);
    parte.set(pedaco, 44);
    partes.push(parte);
  }
  return partes;
}

export type DepsResumoChamadas = {
  /** Áudio da gravação no serviço de voz (null: não está mais lá). */
  /** Gravação em WAV: do serviço de voz ou, já arquivada, do SharePoint (0052). */
  buscarAudio: (c: {
    id: string;
    numberId: string;
    ownerId: string;
    recordingId: string;
    arquivoLocal: "voz" | "sharepoint";
    spDriveId: string | null;
    spItemId: string | null;
    chaveCifrada: Buffer | null;
  }) => Promise<Uint8Array | null>;
  transcritor: Transcritor;
  llm: Llm;
  modelo: string;
  modeloTranscricao: string;
};

export type ResultadoResumoChamadas = { resumidas: number; semFala: number; erros: number };

export async function resumirChamadas(db: Db, deps: DepsResumoChamadas, agora = new Date()): Promise<ResultadoResumoChamadas> {
  const r: ResultadoResumoChamadas = { resumidas: 0, semFala: 0, erros: 0 };
  const c = schema.whatsappCalls;
  const pendentes = await db
    .select({ id: c.id, numberId: c.numberId, ownerId: c.ownerPersonId, recordingId: c.recordingId, arquivoLocal: c.arquivoLocal, spDriveId: c.spDriveId, spItemId: c.spItemId, chaveCifrada: c.chaveCifrada, peer: c.peer, direcao: c.direction, inicio: c.startedAt, fim: c.endedAt, tentativas: c.summaryAttempts })
    .from(c)
    .where(
      and(
        eq(c.audio, true),
        isNull(c.deletedAt),
        isNotNull(c.endedAt),
        isNotNull(c.startedAt),
        gt(c.expiresAt, agora),
        // Só o que o dono pediu ("Resumir com IA", app.pedir_resumo_chamada): nada vai à OpenAI sozinho.
        eq(c.summaryStatus, "pendente"),
        lt(c.summaryAttempts, MAX_TENTATIVAS),
      ),
    )
    .orderBy(asc(c.endedAt))
    .limit(5);

  const marcar = (id: string, valores: Partial<typeof c.$inferInsert>) => db.update(c).set(valores).where(eq(c.id, id));
  for (const ch of pendentes) {
    const falhou = async (codigo: string | null) => {
      r.erros += 1;
      const tentativas = ch.tentativas + 1;
      await marcar(ch.id, { summaryAttempts: tentativas, summaryStatus: tentativas >= MAX_TENTATIVAS ? "erro" : "pendente" });
      return codigo && SEM_CREDITO.has(codigo);
    };
    const bruto = await deps
      .buscarAudio({ id: ch.id, numberId: ch.numberId, ownerId: ch.ownerId, recordingId: ch.recordingId, arquivoLocal: ch.arquivoLocal, spDriveId: ch.spDriveId, spItemId: ch.spItemId, chaveCifrada: ch.chaveCifrada })
      .catch(() => null);
    const mono = bruto ? wavParaMono(bruto) : null;
    if (!mono) {
      await falhou(null);
      continue;
    }
    if (mono.segundos < 3) {
      r.semFala += 1;
      await marcar(ch.id, { summaryStatus: "sem_fala", summarizedAt: agora });
      continue;
    }
    let texto: string;
    try {
      // Ligação longa: uma transcrição por parte de 10 min, juntadas na ordem.
      const textos: string[] = [];
      const partes = partesDoMono(mono.audio);
      for (const [i, parte] of partes.entries()) {
        const t = await deps.transcritor.transcrever({ modelo: deps.modeloTranscricao, audio: parte, nomeArquivo: `ligacao-${i + 1}.wav`, tipo: "audio/wav" });
        textos.push(t.texto.trim());
        await db.insert(schema.llmCalls).values({ purpose: "chamada_transcricao", model: t.modelo, durationMs: t.duracaoMs, outcome: "ok", dataIds: { callId: ch.id, parte: String(i + 1), partes: String(partes.length) } });
      }
      texto = textos.filter(Boolean).join("\n").trim();
      // A transcrição fica guardada junto da gravação (0062), mesmo se o resumo falhar depois.
      if (texto) await marcar(ch.id, { transcript: texto.slice(0, 500_000) });
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      await db.insert(schema.llmCalls).values({ purpose: "chamada_transcricao", model: deps.modeloTranscricao, outcome: "erro", errorCode: error.code ?? String(error.status), dataIds: { callId: ch.id } });
      if (await falhou(error.code ?? null)) break;
      continue;
    }
    if (texto.length < 30) {
      r.semFala += 1;
      await marcar(ch.id, { summaryStatus: "sem_fala", summarizedAt: agora });
      continue;
    }
    const nome = (
      await db
        .select({ nome: schema.whatsappChats.name })
        .from(schema.whatsappChats)
        .where(and(eq(schema.whatsappChats.numberId, ch.numberId), eq(schema.whatsappChats.isGroup, false), or(eq(schema.whatsappChats.phone, ch.peer), eq(schema.whatsappChats.jid, `${ch.peer}@s.whatsapp.net`)), isNotNull(schema.whatsappChats.name)))
        .limit(1)
    )[0]?.nome;
    const data = ch.fim!.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    try {
      const resposta = await deps.llm.estruturado<unknown>({
        modelo: deps.modelo,
        sistema: SISTEMA_RESUMO_CHAMADA,
        entrada: entradaResumoChamada({ contato: nome ?? formatarTelefone(ch.peer) ?? "contato", direcao: ch.direcao, data, minutos: (ch.fim!.getTime() - ch.inicio!.getTime()) / 60_000, transcricao: texto }),
        nome: "resumo_chamada",
        esquema: ESQUEMA_RESUMO_REUNIAO as unknown as Record<string, unknown>,
      });
      await db.insert(schema.llmCalls).values({
        purpose: "chamada_resumo",
        model: resposta.modelo,
        inputTokens: resposta.tokensEntrada,
        outputTokens: resposta.tokensSaida,
        durationMs: resposta.duracaoMs,
        outcome: "ok",
        dataIds: { callId: ch.id, prompt: VERSAO_PROMPT_CHAMADA },
      });
      const resumo = validarResumo(resposta.dados);
      if (!resumo) {
        await falhou(null);
        continue;
      }
      await marcar(ch.id, { summary: resumo, summaryStatus: "resumida", summaryModel: resposta.modelo, summarizedAt: agora });
      r.resumidas += 1;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      await db.insert(schema.llmCalls).values({ purpose: "chamada_resumo", model: deps.modelo, outcome: "erro", errorCode: error.code ?? String(error.status), dataIds: { callId: ch.id, prompt: VERSAO_PROMPT_CHAMADA } });
      if (await falhou(error.code ?? null)) break;
    }
  }
  return r;
}

/** Áudio pelo endpoint interno do serviço de voz (mesmo caminho do player do web). */
export function buscarAudioNoServico(url: string, chave: string) {
  return async (c: { numberId: string; ownerId: string; recordingId: string }): Promise<Uint8Array | null> => {
    const resposta = await fetch(`${url}/internal/recordings/${c.numberId}/${c.ownerId}/${c.recordingId}`, {
      headers: { Authorization: `Bearer ${chave}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!resposta.ok) return null;
    return new Uint8Array(await resposta.arrayBuffer());
  };
}

/** Apaga o WAV do serviço de voz (depois de arquivado no SharePoint). */
export function apagarAudioNoServico(url: string, chave: string) {
  return async (c: { numberId: string; ownerId: string; recordingId: string }): Promise<void> => {
    const resposta = await fetch(`${url}/internal/recordings/${c.numberId}/${c.ownerId}/${c.recordingId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${chave}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!resposta.ok) throw new Error(`serviço de voz respondeu ${resposta.status}`);
  };
}
