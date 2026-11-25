import { BusinessCalendar, type Holiday } from "@omni/core";
import { schema, type Db } from "@omni/db";

/** Calendário útil com os feriados municipais e da empresa cadastrados na Administração. */
export async function carregarCalendario(db: Db, timeZone: string): Promise<BusinessCalendar> {
  const linhas = await db.select().from(schema.holidays);
  const extraHolidays: Holiday[] = linhas.map((h) => ({
    date: h.date,
    name: h.name,
    scope: h.scope,
    ...(h.city ? { city: h.city } : {}),
  }));
  return new BusinessCalendar({ extraHolidays, timeZone });
}
