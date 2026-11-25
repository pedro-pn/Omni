import { schema, type Db } from "@omni/db";
import { cifrarGravacao, embrulharChave, novaChave } from "@omni/integrations/gravacoes";
import type { GraphClient } from "@omni/integrations/graph";
import { and, asc, eq, isNotNull, isNull, lt, lte, gt, or } from "drizzle-orm";

/**
 * Gravações das ligações no SharePoint (0052, site OmniAnexos):
 * - terminada a ligação, pega o WAV no serviço de voz, comprime em M4A, **cifra** com
 *   uma chave só desta gravação (0053; a chave fica no banco, embrulhada pela chave
 *   mestra do servidor), envia para <pasta>/AAAA/MM/<id da ligação>.m4a.cifrado (sem
 *   nome nem telefone no caminho; a pasta é "Gravacoes" na produção e
 *   "Gravacoes-<ambiente>" fora dela), confere o tamanho e só então apaga o WAV do
 *   serviço de voz. No SharePoint nunca vai áudio aberto;
 * - excluída pelo dono ou vencida, apaga o arquivo de vez no SharePoint (sem lixeira)
 *   e a chave (excluir já apaga a chave no banco, pelo gatilho da 0053).
 */
export type DepsArquivar = {
  buscarWav: (c: { numberId: string; ownerId: string; recordingId: string }) => Promise<Uint8Array | null>;
  apagarDoServico: (c: { numberId: string; ownerId: string; recordingId: string }) => Promise<void>;
  comprimir: (wav: Uint8Array) => Promise<Uint8Array>;
  sharepoint: Pick<GraphClient, "enviarArquivo" | "apagarDefinitivo">;
  driveId: string;
  /** Pasta raiz no SharePoint (separa produção, staging e desenvolvimento). */
  pasta: string;
  /** Chave mestra (GRAVACOES_CHAVE_MESTRA) que embrulha a chave de cada gravação. */
  mestra: Buffer;
};
export type ResultadoArquivar = { arquivadas: number; apagadas: number; erros: number };

const MAX_TENTATIVAS = 5;

export async function arquivarGravacoes(db: Db, deps: DepsArquivar, agora = new Date()): Promise<ResultadoArquivar> {
  const r: ResultadoArquivar = { arquivadas: 0, apagadas: 0, erros: 0 };
  const c = schema.whatsappCalls;

  // 1. Enviar ao SharePoint o que terminou há pelo menos 1 min (o serviço de voz já fechou o arquivo).
  const pendentes = await db
    .select({ id: c.id, numberId: c.numberId, ownerId: c.ownerPersonId, recordingId: c.recordingId, fim: c.endedAt, tentativas: c.arquivamentoTentativas })
    .from(c)
    .where(
      and(
        eq(c.audio, true),
        isNull(c.deletedAt),
        eq(c.arquivoLocal, "voz"),
        isNotNull(c.endedAt),
        lt(c.endedAt, new Date(agora.getTime() - 60_000)),
        gt(c.expiresAt, agora),
        lt(c.arquivamentoTentativas, MAX_TENTATIVAS),
      ),
    )
    .orderBy(asc(c.endedAt))
    .limit(5);
  for (const g of pendentes) {
    const ident = { numberId: g.numberId, ownerId: g.ownerId, recordingId: g.recordingId };
    try {
      const wav = await deps.buscarWav(ident);
      if (!wav) throw new Error("gravação não encontrada no serviço de voz");
      const m4a = await deps.comprimir(wav);
      const chave = novaChave();
      const cifrado = cifrarGravacao(m4a, chave);
      const quando = g.fim!.toISOString();
      const caminho = `${deps.pasta}/${quando.slice(0, 4)}/${quando.slice(5, 7)}/${g.id}.m4a.cifrado`;
      const item = await deps.sharepoint.enviarArquivo(deps.driveId, caminho, cifrado);
      if (item.tamanho !== cifrado.byteLength) {
        await deps.sharepoint.apagarDefinitivo(deps.driveId, item.id).catch(() => undefined);
        throw new Error("tamanho diferente no SharePoint");
      }
      const gravou = await db
        .update(c)
        // arquivoBytes: tamanho do M4A original (o player pede trechos dele).
        .set({
          arquivoLocal: "sharepoint",
          spDriveId: deps.driveId,
          spItemId: item.id,
          arquivoBytes: m4a.byteLength,
          arquivoFormato: "m4a",
          arquivadoEm: new Date(),
          chaveCifrada: embrulharChave(chave, deps.mestra, g.id),
          chaveVersao: 1,
        })
        .where(and(eq(c.id, g.id), isNull(c.deletedAt)))
        .returning({ id: c.id });
      if (!gravou.length) {
        // O dono excluiu enquanto enviava: não fica nada no SharePoint.
        await deps.sharepoint.apagarDefinitivo(deps.driveId, item.id).catch(() => undefined);
        continue;
      }
      r.arquivadas += 1;
      // No SharePoint e conferido: o WAV sai do serviço de voz (se falhar, a retenção dele remove).
      await deps.apagarDoServico(ident).catch(() => undefined);
    } catch {
      r.erros += 1;
      await db.update(c).set({ arquivamentoTentativas: g.tentativas + 1 }).where(eq(c.id, g.id));
    }
  }

  // 2. Apagar de vez no SharePoint o que o dono excluiu ou venceu.
  const apagar = await db
    .select({ id: c.id, driveId: c.spDriveId, itemId: c.spItemId, excluida: c.deletedAt })
    .from(c)
    .where(and(isNotNull(c.spItemId), isNull(c.spApagadoEm), or(isNotNull(c.deletedAt), lte(c.expiresAt, agora))))
    .limit(20);
  for (const a of apagar) {
    try {
      await deps.sharepoint.apagarDefinitivo(a.driveId!, a.itemId!);
      // Vencida (ou excluída): a transcrição sai junto com o arquivo (0062).
      await db.update(c).set({ spApagadoEm: new Date(), chaveCifrada: null, transcript: null }).where(eq(c.id, a.id));
      r.apagadas += 1;
    } catch {
      r.erros += 1;
    }
  }
  return r;
}
