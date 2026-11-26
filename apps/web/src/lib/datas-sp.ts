/**
 * Datas no fuso da empresa para as listas e chats, com formatadores criados UMA vez:
 * `toLocaleDateString(…, { timeZone })` cria um formatador novo a cada chamada, e chamado em
 * cada conversa e cada mensagem travava a troca de conversa (medido: ~0,5 s por troca).
 */
const TZ = "America/Sao_Paulo";
const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, ...o });

const DIA = f({ day: "2-digit", month: "2-digit", year: "numeric" });
const ANO = f({ year: "numeric" });
const HORA = f({ hour: "2-digit", minute: "2-digit" });
const DIA_MES = f({ day: "2-digit", month: "2-digit" });
const DIA_MES_ANO2 = f({ day: "2-digit", month: "2-digit", year: "2-digit" });
const SEPARADOR = f({ weekday: "long", day: "2-digit", month: "2-digit" });
const SEPARADOR_ANO = f({ weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });

export const diaSP = (d: Date) => DIA.format(d);
export const horaSP = (d: Date) => HORA.format(d);
export const deOutroAnoSP = (d: Date) => ANO.format(d) !== ANO.format(new Date());

/** Hora se for hoje; senão o dia (com o ano, se for de outro ano). */
export function quandoCurto(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (DIA.format(d) === DIA.format(new Date())) return HORA.format(d);
  return deOutroAnoSP(d) ? DIA_MES_ANO2.format(d) : DIA_MES.format(d);
}

/** O separador de dia nos chats: "quinta-feira, 26/11" (com o ano, se for de outro ano). */
export const separadorDoDia = (d: Date) => (deOutroAnoSP(d) ? SEPARADOR_ANO : SEPARADOR).format(d);
