import type { MotivoVinculo } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { idTarefaDaPendencia } from "../server/reunioes.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Aba Reuniões da missão (Fases 4 e 8): reuniões do Teams das caixas
 * autorizadas que se ligam à missão, com o resumo feito pela IA a partir da
 * transcrição (que não fica no Omni). Só diretoria e gerentes (app.ve_emails,
 * pela função app.reunioes_da_missao, migration 0026). Cada pendência do resumo
 * vira tarefa no projeto da missão com um clique (id fixo: não duplica).
 */

export type SituacaoTranscricao = "pendente" | "sem_link" | "sem_transcricao" | "sem_acesso" | "acesso_desligado" | "disponivel" | "resumida" | "erro";

export type PendenciaReuniao = { descricao: string; responsavel: string | null; prazo: string | null; tarefaId: string; virouTarefa: boolean };

export type Reuniao = {
  id: string;
  titulo: string;
  inicio: string;
  fim: string;
  organizador: string | null;
  participantes: { nome: string | null; endereco: string }[];
  linkTeams: string | null;
  transcricao: SituacaoTranscricao;
  resumo: { texto: string; decisoes: string[]; pendencias: PendenciaReuniao[] } | null;
  motivos: { motivo: MotivoVinculo; detalhe: string }[];
};
export type ReunioesDaMissao = { podeVer: boolean; reunioes: Reuniao[] };

type Linha = {
  id: string;
  subject: string | null;
  starts_at: string | Date;
  ends_at: string | Date;
  organizer_name: string | null;
  organizer_address: string | null;
  attendees: { nome: string | null; endereco: string }[];
  join_url: string | null;
  transcript_status: SituacaoTranscricao;
  summary: { resumo: string; decisoes: string[]; pendencias: { descricao: string; responsavel: string | null; prazo: string | null }[] } | null;
  motivos: { motivo: MotivoVinculo; detalhe: string }[] | null;
};

const iso = (d: string | Date) => (d instanceof Date ? d : new Date(d)).toISOString();
const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const listarReunioesDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ReunioesDaMissao> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [acesso] = (await db.execute<{ ok: boolean }>(sql`SELECT app.ve_emails() AS ok`)).rows;
      if (!acesso?.ok) return { podeVer: false, reunioes: [] };
      const linhas = (await db.execute<Linha>(sql`SELECT * FROM app.reunioes_da_missao(${data.missionId}::uuid)`)).rows;
      const ids = linhas.flatMap((l) => (l.summary?.pendencias ?? []).map((_, i) => idTarefaDaPendencia(l.id, data.missionId, i)));
      const existentes = new Set(
        ids.length ? (await db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.id, ids))).map((t) => t.id) : [],
      );
      return {
        podeVer: true,
        reunioes: linhas.map((l) => ({
          id: l.id,
          titulo: l.subject?.trim() || "Reunião sem título",
          inicio: iso(l.starts_at),
          fim: iso(l.ends_at),
          organizador: l.organizer_name ?? l.organizer_address,
          participantes: l.attendees ?? [],
          linkTeams: l.join_url,
          transcricao: l.transcript_status,
          resumo: l.summary
            ? {
                texto: l.summary.resumo,
                decisoes: l.summary.decisoes,
                pendencias: l.summary.pendencias.map((p, i) => {
                  const tarefaId = idTarefaDaPendencia(l.id, data.missionId, i);
                  return { ...p, tarefaId, virouTarefa: existentes.has(tarefaId) };
                }),
              }
            : null,
          motivos: l.motivos ?? [],
        })),
      };
    });
  });

export const pendenciaParaTarefa = createServerFn({ method: "POST" })
  .validator(z.object({ missionId: z.uuid(), meetingId: z.uuid(), indice: z.number().int().min(0).max(30) }))
  .handler(async ({ data }): Promise<{ id: string }> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [reuniao] = (
        await db.execute<Linha>(sql`SELECT * FROM app.reunioes_da_missao(${data.missionId}::uuid) WHERE id = ${data.meetingId}::uuid`)
      ).rows;
      const p = reuniao?.summary?.pendencias[data.indice];
      if (!reuniao || !p) throw new ErroParaTela("Pendência não encontrada.");
      let projeto: string;
      try {
        projeto = (await db.execute<{ id: string }>(sql`SELECT app.projeto_da_missao(${data.missionId}) AS id`)).rows[0]!.id;
      } catch {
        throw new ErroParaTela("Para criar tarefas da missão, você precisa ver o Interno dela.");
      }
      const [membro] = await db
        .select({ id: schema.taskProjectMembers.personId })
        .from(schema.taskProjectMembers)
        .where(and(eq(schema.taskProjectMembers.projectId, projeto), eq(schema.taskProjectMembers.personId, personId)));
      const quando = new Date(reuniao.starts_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "America/Sao_Paulo" });
      const descricao = [
        `Pendência da reunião "${reuniao.subject?.trim() || "sem título"}" de ${quando} (resumo da IA pela transcrição do Teams).`,
        p.responsavel ? `Responsável citado: ${p.responsavel}.` : "",
        p.prazo ? `Prazo citado: ${p.prazo}.` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const id = idTarefaDaPendencia(data.meetingId, data.missionId, data.indice);
      try {
        await db
          .insert(schema.tasks)
          .values({
            id,
            content: p.descricao,
            description: descricao,
            projectId: projeto,
            ownerPersonId: null,
            sectionId: null,
            assigneePersonId: membro ? personId : null,
            dueDate: hojeSaoPaulo(),
            dueTime: null,
            recurrence: null,
            priority: 4,
            labels: [],
            createdBy: personId,
          })
          .onConflictDoNothing({ target: schema.tasks.id });
      } catch {
        throw new ErroParaTela("Não foi possível criar a tarefa no projeto da missão.");
      }
      return { id };
    });
  });
