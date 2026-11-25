import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, isNotNull, like, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Aba "Tudo" da missão (INSTRUCOES §6.7; protótipo `streamHTML` com a camada
 * "Tudo"): uma linha do tempo só, com o que a pessoa já pode ver em cada lugar —
 * Interno e Gerencial (RLS dos canais, com o corte de histórico), grupos do
 * WhatsApp ligados à missão (quem vê o Interno), e-mails e reuniões (só
 * diretoria e gerentes, app.ve_emails) e o envio dos RDOs. Só leitura: cada
 * item leva à aba de origem para responder.
 */

export type FonteTudo = "interno" | "gerencial" | "whatsapp" | "email" | "reuniao" | "rdo";

export type ItemTudo = {
  id: string;
  fonte: FonteTudo;
  em: string;
  autor: string | null;
  titulo: string | null;
  texto: string;
  /** Mensagem do sistema ou da IA no canal. */
  tipo: "texto" | "sistema" | "ia";
};

const POR_FONTE = 120;
const TOTAL = 200;
const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

export const linhaDoTempoDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ItemTudo[]> => {
    const personId = await personIdFromRequest(getRequest());
    if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
    return withPerson(getPool(), personId, async (db) => {
      const autor = alias(schema.people, "autor");
      const [acesso] = (await db.execute<{ emails: boolean }>(sql`SELECT app.ve_emails() AS emails`)).rows;
      const [canais, whatsapp, emails, reunioes, rdos] = await Promise.all([
        // Interno e Gerencial: a RLS só devolve os canais que a pessoa vê, a partir de quando vê.
        db
          .select({ id: schema.missionMessages.id, canal: schema.missionMessages.channel, tipo: schema.missionMessages.kind, texto: schema.missionMessages.body, em: schema.missionMessages.createdAt, autor: autor.displayName })
          .from(schema.missionMessages)
          .leftJoin(autor, eq(autor.id, schema.missionMessages.authorPersonId))
          .where(eq(schema.missionMessages.missionId, data.missionId))
          .orderBy(desc(schema.missionMessages.createdAt))
          .limit(POR_FONTE * 2),
        // Grupos do WhatsApp ligados à missão (RLS: quem vê o Interno lê).
        db
          .select({
            id: schema.whatsappMessages.id,
            deMim: schema.whatsappMessages.fromMe,
            autor: schema.whatsappMessages.authorName,
            tipo: schema.whatsappMessages.kind,
            texto: schema.whatsappMessages.body,
            arquivo: schema.whatsappMessages.fileName,
            em: schema.whatsappMessages.sentAt,
            grupo: schema.whatsappChats.name,
          })
          .from(schema.whatsappMessages)
          .innerJoin(schema.whatsappChats, eq(schema.whatsappChats.id, schema.whatsappMessages.chatId))
          .innerJoin(schema.whatsappChatMissions, eq(schema.whatsappChatMissions.chatId, schema.whatsappChats.id))
          .where(eq(schema.whatsappChatMissions.missionId, data.missionId))
          .orderBy(desc(schema.whatsappMessages.sentAt))
          .limit(POR_FONTE),
        acesso?.emails
          ? db
              .execute<{ id: string; subject: string | null; from_name: string | null; from_address: string | null; received_at: string | Date | null; body_preview: string | null }>(
                sql`SELECT id, subject, from_name, from_address, received_at, body_preview FROM app.emails_da_missao(${data.missionId}::uuid) LIMIT ${POR_FONTE}`,
              )
              .then((r) => r.rows)
          : Promise.resolve([]),
        acesso?.emails
          ? db
              .execute<{ id: string; subject: string | null; starts_at: string | Date; summary: { resumo: string } | null }>(
                sql`SELECT id, subject, starts_at, summary FROM app.reunioes_da_missao(${data.missionId}::uuid) WHERE starts_at <= now()`,
              )
              .then((r) => r.rows)
          : Promise.resolve([]),
        db
          .select({ id: schema.reports.id, tipo: schema.reports.reportType, numero: schema.reports.reportNumber, data: schema.reports.reportDate, enviadoEm: schema.reports.submittedAt })
          .from(schema.reports)
          .where(and(eq(schema.reports.missionId, data.missionId), like(schema.reports.reportType, "RDO%"), isNotNull(schema.reports.submittedAt)))
          .orderBy(desc(schema.reports.submittedAt))
          .limit(POR_FONTE),
      ]);

      const itens: ItemTudo[] = [
        ...canais.map((m) => ({ id: `c-${m.id}`, fonte: m.canal, em: iso(m.em), autor: m.tipo === "ia" ? "IA" : m.autor, titulo: null, texto: m.texto, tipo: m.tipo })),
        ...whatsapp.map((m) => ({
          id: `w-${m.id}`,
          fonte: "whatsapp" as const,
          em: iso(m.em),
          autor: m.deMim ? "Filtrovali" : m.autor,
          titulo: m.grupo,
          texto: m.texto ?? (m.arquivo ? `[arquivo] ${m.arquivo}` : `[${m.tipo}]`),
          tipo: "texto" as const,
        })),
        ...emails
          .filter((e) => e.received_at)
          .map((e) => ({
            id: `e-${e.id}`,
            fonte: "email" as const,
            em: iso(e.received_at!),
            autor: e.from_name || e.from_address,
            titulo: e.subject?.trim() || "(sem assunto)",
            texto: e.body_preview ?? "",
            tipo: "texto" as const,
          })),
        ...reunioes.map((r) => ({
          id: `r-${r.id}`,
          fonte: "reuniao" as const,
          em: iso(r.starts_at),
          autor: null,
          titulo: r.subject?.trim() || "Reunião sem título",
          texto: r.summary?.resumo ?? "Reunião do Teams ligada à missão.",
          tipo: "texto" as const,
        })),
        ...rdos.map((r) => {
          const n = r.numero ?? "";
          const nome = n.toUpperCase().startsWith("RDO") ? n : `RDO${n ? ` nº ${n}` : ""}`;
          return {
            id: `d-${r.id}`,
            fonte: "rdo" as const,
            em: iso(r.enviadoEm!),
            autor: null,
            titulo: null,
            texto: `${nome} de ${r.data.split("-").reverse().join("/")} enviado pelo líder de campo`,
            tipo: "sistema" as const,
          };
        }),
      ];
      return itens.sort((a, b) => b.em.localeCompare(a.em)).slice(0, TOTAL).reverse();
    });
  });
