import { createHash, randomBytes } from "node:crypto";

import { schema, type Db } from "@omni/db";
import { GraphError, type GraphClient } from "@omni/integrations/graph";
import { eq, inArray } from "drizzle-orm";
import pg from "pg";

/**
 * Aviso imediato de e-mail novo (0070). Uma assinatura do Graph por caixa ativa, na
 * Entrada; o Graph chama /api/graph/avisos, que confere o segredo (só o SHA-256 fica no
 * banco) e acorda o worker (pg_notify omni_graph_email) para ler as caixas na hora.
 * As assinaturas de e-mail vencem em até ~7 dias: renovadas quando faltam menos de 36 h.
 */
export type FonteAssinaturas = Pick<GraphClient, "assinarEntrada" | "renovarAssinatura" | "apagarAssinatura">;

const DURACAO_MS = 3 * 24 * 3600_000;
const RENOVAR_ANTES_MS = 36 * 3600_000;
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

export async function manterAssinaturas(
  db: Db,
  graph: FonteAssinaturas,
  url: string,
  agora: () => Date = () => new Date(),
): Promise<{ criadas: number; renovadas: number; removidas: number; erros: number }> {
  const r = { criadas: 0, renovadas: 0, removidas: 0, erros: 0 };
  const caixas = await db.select({ id: schema.mailMailboxes.id, email: schema.mailMailboxes.email }).from(schema.mailMailboxes).where(eq(schema.mailMailboxes.active, true));
  const ativas = new Set(caixas.map((c) => c.id));
  const assinaturas = await db.select().from(schema.graphSubscriptions);
  // Caixa desligada: a assinatura sai.
  for (const a of assinaturas.filter((x) => !ativas.has(x.mailboxId))) {
    try {
      await graph.apagarAssinatura(a.id);
      await db.delete(schema.graphSubscriptions).where(eq(schema.graphSubscriptions.id, a.id));
      r.removidas += 1;
    } catch {
      r.erros += 1;
    }
  }
  for (const caixa of caixas) {
    const atual = assinaturas.find((a) => a.mailboxId === caixa.id);
    const agoraMs = agora().getTime();
    if (atual && atual.expiresAt.getTime() - agoraMs > RENOVAR_ANTES_MS) continue;
    const expira = new Date(agoraMs + DURACAO_MS);
    if (atual) {
      try {
        const nova = await graph.renovarAssinatura(atual.id, expira);
        await db.update(schema.graphSubscriptions).set({ expiresAt: nova }).where(eq(schema.graphSubscriptions.id, atual.id));
        r.renovadas += 1;
        continue;
      } catch (error) {
        // Sumiu do Graph (venceu ou foi apagada): cria outra; outro erro fica para a próxima rodada.
        if (!(error instanceof GraphError && error.status === 404)) {
          r.erros += 1;
          continue;
        }
        await db.delete(schema.graphSubscriptions).where(eq(schema.graphSubscriptions.id, atual.id));
      }
    }
    const segredo = randomBytes(32).toString("base64url");
    try {
      const nova = await graph.assinarEntrada(caixa.email, url, segredo, expira);
      await db.insert(schema.graphSubscriptions).values({ id: nova.id, mailboxId: caixa.id, secretSha256: sha256(segredo), expiresAt: nova.expira });
      r.criadas += 1;
    } catch (error) {
      r.erros += 1;
      console.warn(`[graph-avisos] não assinou uma caixa: ${error instanceof GraphError ? `${error.status} ${error.code ?? ""}` : (error as Error).name}`);
    }
  }
  return r;
}

/** Remove as assinaturas de caixas que não existem mais (ex.: ao desligar o aviso imediato). */
export async function apagarTodasAsAssinaturas(db: Db, graph: FonteAssinaturas): Promise<number> {
  const todas = await db.select({ id: schema.graphSubscriptions.id }).from(schema.graphSubscriptions);
  const apagadas: string[] = [];
  for (const a of todas) {
    try {
      await graph.apagarAssinatura(a.id);
      apagadas.push(a.id);
    } catch {
      // fica para a próxima vez
    }
  }
  if (apagadas.length) await db.delete(schema.graphSubscriptions).where(inArray(schema.graphSubscriptions.id, apagadas));
  return apagadas.length;
}

/**
 * Escuta os avisos (omni_graph_email) numa conexão própria e chama `aoAviso` no máximo
 * uma vez a cada `esperaMs` (vários e-mails de uma vez viram uma leitura). Reconecta sozinha.
 */
export function ouvirAvisosDoGraph(url: string, aoAviso: () => void, esperaMs = 3_000): () => Promise<void> {
  let client: pg.Client | null = null;
  let parado = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const conectar = async () => {
    if (parado) return;
    client = new pg.Client({ connectionString: url });
    client.on("notification", () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        aoAviso();
      }, esperaMs);
    });
    client.on("error", () => {
      client = null;
      if (!parado) setTimeout(() => void conectar(), 5_000);
    });
    try {
      await client.connect();
      await client.query("LISTEN omni_graph_email");
    } catch {
      client = null;
      if (!parado) setTimeout(() => void conectar(), 5_000);
    }
  };
  void conectar();
  return async () => {
    parado = true;
    if (timer) clearTimeout(timer);
    await client?.end().catch(() => undefined);
  };
}
