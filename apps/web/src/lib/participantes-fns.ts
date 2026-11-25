import { detectarParticipantes, type LadoParticipante, type OrigemParticipante } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Participantes da missão (INSTRUCOES §6.7): quem aparece nos e-mails da missão
 * (só para quem vê os e-mails: app.ve_emails) e nos grupos do WhatsApp ligados a
 * ela (quem vê o Interno), com o que a equipe completou à mão (migration 0042).
 * A lista em si é só para quem vê o Interno da missão.
 */

export type Participante = {
  chave: string;
  nome: string | null;
  cargo: string | null;
  empresa: string | null;
  email: string | null;
  telefone: string | null;
  lado: LadoParticipante;
  setor: boolean;
  origens: OrigemParticipante[];
  vezes: number;
  ultimaVez: string;
  oculto: boolean;
  completadoPor: string | null;
  /** Cargo/empresa vieram da assinatura do e-mail (IA), não de alguém da equipe. */
  pelaAssinatura: boolean;
  /** Enviado ao Prisma como participante do cliente (0047). */
  prisma: { contatoId: string; em: string } | null;
};

export type ParticipantesDaMissao = { podeVer: boolean; incluiEmails: boolean; participantes: Participante[] };

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const participantesDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ParticipantesDaMissao> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [acesso] = (
        await db.execute<{ interno: boolean; emails: boolean }>(sql`SELECT app.ve_interno(${data.missionId}::uuid, ${personId}::uuid) AS interno, app.ve_emails() AS emails`)
      ).rows;
      if (!acesso?.interno) return { podeVer: false, incluiEmails: false, participantes: [] };
      const [emails, whatsapp, dominios, telefones, notas, assinaturas] = await Promise.all([
        acesso.emails
          ? db
              .execute<{ from_name: string | null; from_address: string | null; to_recipients: { nome: string | null; endereco: string }[]; cc_recipients: { nome: string | null; endereco: string }[]; received_at: string | Date | null }>(
                sql`SELECT from_name, from_address, to_recipients, cc_recipients, received_at FROM app.emails_da_missao(${data.missionId}::uuid)`,
              )
              .then((r) => r.rows)
          : Promise.resolve([]),
        // Agregado no banco: uma linha por autor e nome (a RLS só deixa os grupos que a pessoa lê).
        db
          .execute<{ jid: string | null; nome: string | null; em: string | Date; vezes: number }>(sql`
            SELECT m.author_jid AS jid, m.author_name AS nome, max(m.sent_at) AS em, count(*)::int AS vezes
              FROM whatsapp_messages m
              JOIN whatsapp_chats c ON c.id = m.chat_id AND c.is_group
              JOIN whatsapp_chat_missions l ON l.chat_id = c.id AND l.mission_id = ${data.missionId}::uuid
             WHERE NOT m.from_me AND m.author_jid IS NOT NULL
             GROUP BY 1, 2`)
          .then((r) => r.rows),
        // A tela não lê as tabelas do Prisma: só os domínios, pela função (0043).
        db
          .execute<{ d: string[] | null }>(sql`SELECT app.dominios_do_cliente(${data.missionId}::uuid) AS d`)
          .then((r) => r.rows[0]?.d ?? []),
        db
          .select({ telefone: schema.people.phone })
          .from(schema.people)
          .where(and(eq(schema.people.active, true), isNotNull(schema.people.phone)))
          .then((r) => r.map((x) => x.telefone!)),
        db
          .select({ n: schema.missionParticipantNotes, por: schema.people.displayName })
          .from(schema.missionParticipantNotes)
          .leftJoin(schema.people, eq(schema.people.id, schema.missionParticipantNotes.updatedBy))
          .where(eq(schema.missionParticipantNotes.missionId, data.missionId)),
        // Assinaturas lidas pela IA (0044): só com acesso aos e-mails.
        acesso.emails
          ? db
              .execute<{ endereco: string; nome: string | null; cargo: string | null; empresa: string | null; telefone: string | null }>(
                sql`SELECT * FROM app.assinaturas_da_missao(${data.missionId}::uuid)`,
              )
              .then((r) => r.rows)
          : Promise.resolve([]),
      ]);
      const assinaturaDe = new Map(assinaturas.map((a) => [`email:${a.endereco}`, a]));
      const iso = (d: string | Date | null) => (d ? new Date(d).toISOString() : new Date(0).toISOString());
      const detectados = detectarParticipantes({
        dominiosCliente: dominios,
        telefonesFiltrovali: telefones,
        emails: emails.map((e) => ({ de: { nome: e.from_name, endereco: e.from_address }, para: e.to_recipients ?? [], cc: e.cc_recipients ?? [], em: iso(e.received_at) })),
        whatsapp: whatsapp.map((w) => ({ jid: w.jid, nome: w.nome, em: iso(w.em), vezes: w.vezes })),
      });
      const porChave = new Map(notas.map((x) => [x.n.chave, x]));
      return {
        podeVer: true,
        incluiEmails: Boolean(acesso.emails),
        participantes: detectados.map((p) => {
          const nota = porChave.get(p.chave);
          const a = assinaturaDe.get(p.chave);
          // O que a equipe completou vale mais que a assinatura; a assinatura, mais que o cabeçalho.
          const cargo = nota?.n.cargo ?? a?.cargo ?? null;
          const empresa = nota?.n.empresa ?? a?.empresa ?? null;
          return {
            ...p,
            nome: nota?.n.nome ?? a?.nome ?? p.nome,
            telefone: p.telefone ?? a?.telefone ?? null,
            cargo,
            empresa,
            prisma: nota?.n.prismaContactId ? { contatoId: nota.n.prismaContactId, em: (nota.n.prismaVinculadoEm ?? nota.n.updatedAt).toISOString() } : null,
            pelaAssinatura: Boolean(a && ((!nota?.n.cargo && a.cargo) || (!nota?.n.empresa && a.empresa))),
            lado: nota?.n.lado ?? p.lado,
            oculto: nota?.n.oculto ?? false,
            completadoPor: nota?.por ?? null,
          };
        }),
      };
    });
  });

/** Completar à mão (nome, cargo, empresa, lado) ou tirar da lista ("não é participante"). */
export const completarParticipante = createServerFn({ method: "POST" })
  .validator(
    z.object({
      missionId: z.uuid(),
      chave: z.string().regex(/^(email|wa):.{3,200}$/),
      nome: z.string().trim().max(120).nullable(),
      cargo: z.string().trim().max(120).nullable(),
      empresa: z.string().trim().max(120).nullable(),
      lado: z.enum(["cliente", "filtrovali", "terceiro"]).nullable(),
      oculto: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const valores = {
      nome: data.nome || null,
      cargo: data.cargo || null,
      empresa: data.empresa || null,
      lado: data.lado,
      oculto: data.oculto,
      updatedBy: personId,
      updatedAt: new Date(),
    };
    try {
      await withPerson(getPool(), personId, (db) =>
        db
          .insert(schema.missionParticipantNotes)
          .values({ missionId: data.missionId, chave: data.chave, ...valores })
          .onConflictDoUpdate({ target: [schema.missionParticipantNotes.missionId, schema.missionParticipantNotes.chave], set: valores }),
      );
    } catch {
      throw new ErroParaTela("Só quem vê o Interno da missão pode completar os participantes.");
    }
    return { ok: true };
  });
