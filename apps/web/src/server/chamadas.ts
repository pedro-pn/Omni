import { createHash } from "node:crypto";
import { schema, withPerson } from "@omni/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { getPool } from "./db.ts";
import { getEnv } from "./env.ts";
import { ErroParaTela } from "../lib/erros.ts";

export function chamadasConfiguradas() {
  const e = getEnv();
  return e.CHAMADAS_HABILITADAS === "on" && Boolean(e.CHAMADAS_SERVICO_URL && e.CHAMADAS_SERVICO_KEY);
}
export async function servicoChamadas(path: string, options: RequestInit = {}) {
  const e = getEnv();
  if (!chamadasConfiguradas()) throw new ErroParaTela("As chamadas ainda não estão habilitadas neste ambiente.");
  const headers = new Headers(options.headers); headers.set("Authorization", `Bearer ${e.CHAMADAS_SERVICO_KEY}`);
  try {
    return await fetch(`${e.CHAMADAS_SERVICO_URL}${path}`, { ...options, redirect: "error", signal: AbortSignal.timeout(25_000),
      headers });
  } catch { throw new ErroParaTela("O serviço de chamadas está indisponível. Tente novamente."); }
}
export async function identidadeDaLinha(personId: string, numberId: string) {
  return withPerson(getPool(), personId, async db => {
    const [n] = await db.select().from(schema.whatsappNumbers).where(and(eq(schema.whatsappNumbers.id, numberId), eq(schema.whatsappNumbers.ownerPersonId, personId), ne(schema.whatsappNumbers.status, "removido")));
    const check = await db.execute<{ ok: boolean }>(sql`select app.pode_usar_linha_chamada(${numberId}::uuid) as ok`);
    if (!n?.phone || !check.rows[0]?.ok) throw new ErroParaTela("Você só pode ligar e atender pelo seu próprio número conectado.");
    const [permission] = await db.select().from(schema.whatsappCallPermissions).where(eq(schema.whatsappCallPermissions.personId, personId));
    return { numberId: n.id, ownerId: personId, phone: n.phone, canRecord: permission?.canRecord ?? false };
  });
}
export async function controlarLinha(personId: string, numberId: string, input: { action: string; peer?: string; id?: string; record?: boolean; notified?: boolean }) {
  const identity = await identidadeDaLinha(personId, numberId);
  if (input.record && (!identity.canRecord || !input.notified)) throw new ErroParaTela("Para gravar, é preciso ter permissão e confirmar o aviso aos participantes.");
  const response = await servicoChamadas("/internal/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...identity, ...input }) });
  if (!response.ok) throw new ErroParaTela("Não foi possível concluir. Confira a conexão, o microfone e o destino permitido para o teste.");
  return response.json() as Promise<EstadoChamada>;
}
export type EstadoChamada = {
  mode: string;
  connection: { state: string; message?: string };
  /** recording: a ligação tem gravação; recordingActive: gravando agora (pode pausar e retomar). */
  call: { id: string; peer: string; direction: string; state: string; recording: boolean; recordingActive?: boolean } | null;
  allowed: string[];
  ticket?: string;
};

/** Id fixo por chamada e pendência do resumo: criar de novo não duplica a tarefa. */
export function idTarefaDaChamada(callId: string, indice: number): string {
  const h = createHash("sha256").update(`chamada:${callId}:${indice}`).digest("hex");
  const variante = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
