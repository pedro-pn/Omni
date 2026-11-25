import { schema, type Db } from "@omni/db";
import { eq, inArray, sql } from "drizzle-orm";
import webpush from "web-push";

/**
 * Notificações no celular/computador (Web Push, PWA). O conteúdo vai cifrado
 * de ponta a ponta até o aparelho (o serviço de push do Google/Apple não lê);
 * mesmo assim, só título curto, prévia de até 120 caracteres e o endereço a abrir.
 * Aparelho que não existe mais (404/410) sai da lista.
 */

export type Notificacao = { titulo: string; corpo: string; url: string; tag: string };
export type TipoPush = "aviso" | "canal" | "whatsapp" | "email";
const MODULO_DO_PUSH: Partial<Record<TipoPush, string>> = { canal: "missoes", whatsapp: "whatsapp", email: "emails" };
export type Enviador = (assinatura: { endpoint: string; keys: { p256dh: string; auth: string } }, carga: string) => Promise<void>;

export function enviadorWebPush(chaves: { publica: string; privada: string; assunto: string }): Enviador {
  webpush.setVapidDetails(chaves.assunto, chaves.publica, chaves.privada);
  return async (assinatura, carga) => {
    await webpush.sendNotification(assinatura, carga, { TTL: 60 * 60 * 12, urgency: "high" });
  };
}

const curto = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export async function enviarPush(db: Db, enviar: Enviador, pessoas: string[], tipo: TipoPush, n: Notificacao): Promise<{ enviados: number; removidos: number }> {
  const r = { enviados: 0, removidos: 0 };
  if (!pessoas.length) return r;
  let alvo = [...new Set(pessoas)];
  if (tipo !== "aviso") {
    // Preferências: sem linha = tudo ligado.
    const prefs = await db.select().from(schema.pushPreferences).where(inArray(schema.pushPreferences.personId, alvo));
    const desligados = new Set(prefs.filter((p) => (tipo === "canal" ? !p.canais : tipo === "email" ? !p.email : !p.whatsapp)).map((p) => p.personId));
    alvo = alvo.filter((p) => !desligados.has(p));
  }
  // Liberação por módulo (0071): sem o módulo, sem as notificações dele.
  const modulo = MODULO_DO_PUSH[tipo];
  if (modulo && alvo.length) {
    const liberadas = new Set(
      (
        await db.execute<{ id: string }>(
          sql`SELECT p AS id FROM unnest(${`{${alvo.join(",")}}`}::uuid[]) AS p WHERE app.modulo_liberado_para(p, ${modulo})`,
        )
      ).rows.map((x) => x.id),
    );
    alvo = alvo.filter((p) => liberadas.has(p));
  }
  if (!alvo.length) return r;
  const assinaturas = await db.select().from(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.personId, alvo));
  const carga = JSON.stringify({ titulo: curto(n.titulo, 80), corpo: curto(n.corpo, 120), url: n.url, tag: n.tag });
  for (const a of assinaturas) {
    try {
      await enviar({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } }, carga);
      await db.update(schema.pushSubscriptions).set({ lastOkAt: new Date(), failures: 0 }).where(eq(schema.pushSubscriptions.id, a.id));
      r.enviados += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410 || a.failures >= 9) {
        await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, a.id));
        r.removidos += 1;
      } else {
        await db.update(schema.pushSubscriptions).set({ failures: sql`${schema.pushSubscriptions.failures} + 1` }).where(eq(schema.pushSubscriptions.id, a.id));
      }
    }
  }
  return r;
}
