import { TZDate } from "@date-fns/tz";

import { EMPRESA_TIME_ZONE } from "./business-calendar.ts";

export type Vencimento = {
  /** "hoje, 14:32", "amanhã, 09:00" ou "28/01/2027". */
  texto: string;
  /** Faltam 7 dias ou menos: hora de avisar para reconectar. */
  perto: boolean;
  vencido: boolean;
};

const DIA_MS = 86_400_000;

/** Descreve quando uma credencial vence, no fuso da empresa. */
export function descreverVencimento(iso: string, agora: Date = new Date(), timeZone = EMPRESA_TIME_ZONE): Vencimento {
  const vence = new TZDate(new Date(iso).getTime(), timeZone);
  const hoje = new TZDate(agora.getTime(), timeZone);
  const dd = (n: number) => String(n).padStart(2, "0");
  const hora = `${dd(vence.getHours())}:${dd(vence.getMinutes())}`;
  const mesmoDia = (a: TZDate, b: TZDate) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const amanha = new TZDate(agora.getTime() + DIA_MS, timeZone);

  const restante = vence.getTime() - agora.getTime();
  const texto = mesmoDia(vence, hoje)
    ? `hoje, ${hora}`
    : mesmoDia(vence, amanha)
      ? `amanhã, ${hora}`
      : `${dd(vence.getDate())}/${dd(vence.getMonth() + 1)}/${vence.getFullYear()}`;
  return { texto, perto: restante > 0 && restante <= 7 * DIA_MS, vencido: restante <= 0 };
}
