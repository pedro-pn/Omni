import { faltasDoIncidente, GRAVIDADES_INCIDENTE, SITUACOES_INCIDENTE, TIPOS_INCIDENTE } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Administração → Incidentes (E21, pilar 12.4; migration 0086). Só quem administra lê e escreve (RLS).
 * Encerrar exige causa e correção (e, com dado pessoal, titulares e comunicações): `faltasDoIncidente`
 * avisa aqui, o CHECK do banco garante. Não há exclusão: o registro é guardado por 5 anos ou mais.
 */

export type IncidenteNaTela = {
  id: string;
  titulo: string;
  tipo: keyof typeof TIPOS_INCIDENTE;
  gravidade: keyof typeof GRAVIDADES_INCIDENTE;
  status: keyof typeof SITUACOES_INCIDENTE;
  inicio: string;
  conhecidoEm: string;
  resolvidoEm: string | null;
  oQueAconteceu: string;
  impacto: string | null;
  dadosPessoais: boolean;
  titulares: string | null;
  acoes: string | null;
  causa: string | null;
  correcao: string | null;
  comunicacoes: string | null;
  referencias: string | null;
  criadoPor: string | null;
  criadoEm: string;
  atualizadoPor: string | null;
  atualizadoEm: string;
};

async function admin(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

const criador = alias(schema.people, "criador");
const editor = alias(schema.people, "editor");

export const incidentes = createServerFn({ method: "GET" }).handler(async (): Promise<IncidenteNaTela[]> => {
  const personId = await admin();
  const linhas = await withPerson(getPool(), personId, async (db) => {
    const ok = (await db.execute<{ ok: boolean }>(sql`SELECT app.has_profile('admin') AS ok`)).rows[0]?.ok;
    if (!ok) throw new ErroParaTela("Só quem administra vê os incidentes.");
    return db
      .select({ i: schema.incidentes, criador: criador.displayName, editor: editor.displayName })
      .from(schema.incidentes)
      .leftJoin(criador, eq(criador.id, schema.incidentes.criadoPor))
      .leftJoin(editor, eq(editor.id, schema.incidentes.atualizadoPor))
      .orderBy(desc(schema.incidentes.inicio))
      .limit(500);
  });
  return linhas.map(({ i, criador: quemCriou, editor: quemMudou }) => ({
    id: i.id,
    titulo: i.titulo,
    tipo: i.tipo,
    gravidade: i.gravidade,
    status: i.status,
    inicio: i.inicio.toISOString(),
    conhecidoEm: i.conhecidoEm.toISOString(),
    resolvidoEm: i.resolvidoEm?.toISOString() ?? null,
    oQueAconteceu: i.oQueAconteceu,
    impacto: i.impacto,
    dadosPessoais: i.dadosPessoais,
    titulares: i.titulares,
    acoes: i.acoes,
    causa: i.causa,
    correcao: i.correcao,
    comunicacoes: i.comunicacoes,
    referencias: i.referencias,
    criadoPor: quemCriou ?? null,
    criadoEm: i.criadoEm.toISOString(),
    atualizadoPor: quemMudou ?? null,
    atualizadoEm: i.atualizadoEm.toISOString(),
  }));
});

const texto = (max: number) =>
  z
    .string()
    .max(max, `Use no máximo ${max} caracteres.`)
    .transform((v) => v.trim() || null)
    .nullable();
const hora = z.iso.datetime({ offset: true, message: "Data e hora inválidas." });

const entrada = z.object({
  id: z.uuid().optional(),
  titulo: z.string().trim().min(3, "Dê um título.").max(160),
  tipo: z.enum(Object.keys(TIPOS_INCIDENTE) as [keyof typeof TIPOS_INCIDENTE]),
  gravidade: z.enum(Object.keys(GRAVIDADES_INCIDENTE) as [keyof typeof GRAVIDADES_INCIDENTE]),
  status: z.enum(Object.keys(SITUACOES_INCIDENTE) as [keyof typeof SITUACOES_INCIDENTE]),
  inicio: hora,
  conhecidoEm: hora,
  resolvidoEm: hora.nullable(),
  oQueAconteceu: z.string().trim().min(3, "Conte o que aconteceu.").max(4000),
  impacto: texto(2000),
  dadosPessoais: z.boolean(),
  titulares: texto(1000),
  acoes: texto(4000),
  causa: texto(4000),
  correcao: texto(4000),
  comunicacoes: texto(2000),
  referencias: texto(1000),
});
export type IncidenteParaSalvar = z.input<typeof entrada>;

export const salvarIncidente = createServerFn({ method: "POST" })
  .validator(entrada)
  .handler(async ({ data }) => {
    const personId = await admin();
    const faltas = faltasDoIncidente(data);
    if (faltas.length) throw new ErroParaTela(faltas.join(" "));
    const { id, ...campos } = data;
    const valores = {
      ...campos,
      inicio: new Date(campos.inicio),
      conhecidoEm: new Date(campos.conhecidoEm),
      resolvidoEm: campos.resolvidoEm ? new Date(campos.resolvidoEm) : null,
    };
    return withPerson(getPool(), personId, async (db) => {
      const ok = (await db.execute<{ ok: boolean }>(sql`SELECT app.has_profile('admin') AS ok`)).rows[0]?.ok;
      if (!ok) throw new ErroParaTela("Só quem administra registra incidentes.");
      if (!id) {
        const [r] = await db.insert(schema.incidentes).values({ ...valores, criadoPor: personId }).returning({ id: schema.incidentes.id });
        return { id: r!.id };
      }
      const r = await db
        .update(schema.incidentes)
        .set({ ...valores, atualizadoPor: personId, atualizadoEm: new Date() })
        .where(eq(schema.incidentes.id, id))
        .returning({ id: schema.incidentes.id });
      if (!r.length) throw new ErroParaTela("Incidente não encontrado.");
      return { id };
    });
  });
