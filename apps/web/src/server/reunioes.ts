import { createHash } from "node:crypto";

/** Id fixo da tarefa de uma pendência de reunião (reunião + missão + posição): clicar de novo não duplica. Só servidor. */
export function idTarefaDaPendencia(meetingId: string, missionId: string, indice: number): string {
  const h = createHash("sha256").update(`reuniao:${meetingId}:${missionId}:${indice}`).digest("hex");
  const variante = ((parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
