import { fluxo, type PayloadPergunta } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Respostas às perguntas da IA (Fase 5). A permissão é do banco (migrations 0006
 * e 0008: só quem vê o Interno responde — inclusive quem ocupa a função que a IA
 * endereçou —, só pergunta enviada, sempre em nome próprio).
 * Resposta e pedido de desvio entram na mesma transação; o worker envia o desvio.
 */

export class IAError extends ErroParaTela {}

const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

export const responderPergunta = createServerFn({ method: "POST" })
  .validator(
    z.object({
      questionId: z.uuid(),
      opcao: z.string().min(1).max(40),
      nova_data: z.iso.date().optional(),
      motivo: z.string().trim().max(1000).optional(),
      detalhe: z.string().trim().max(2000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const meuId = await personIdFromRequest(getRequest());
    if (!meuId) throw new IAError("Sessão expirada. Entre de novo.");

    return withPerson(getPool(), meuId, async (db) => {
      const [q] = await db.select().from(schema.aiQuestions).where(eq(schema.aiQuestions.id, data.questionId));
      if (!q) throw new IAError("Pergunta não encontrada.");
      if (q.status !== "enviada") throw new IAError("Esta pergunta já foi respondida.");
      const opcao = fluxo(q.flow)?.opcoes.find((o) => o.id === data.opcao);
      if (!opcao) throw new IAError("Opção inválida.");
      const pede = opcao.pede ?? [];
      if (pede.includes("nova_data") && (!data.nova_data || data.nova_data < hojeSaoPaulo())) {
        throw new IAError("Informe a nova data (hoje ou depois).");
      }
      if (pede.includes("motivo") && (data.motivo?.length ?? 0) < 3) throw new IAError("Conte o motivo em poucas palavras.");
      if (pede.includes("detalhe") && (data.detalhe?.length ?? 0) < 3) throw new IAError("Preencha o detalhe pedido.");

      const [eu] = await db.select({ nome: schema.people.displayName }).from(schema.people).where(eq(schema.people.id, meuId));
      const payload = q.payload as unknown as PayloadPergunta;

      // Resposta que vira tarefa (fluxos.ts → opção.tarefa): para quem respondeu, no projeto da missão.
      let tarefa: { id: string; titulo: string } | null = null;
      if (opcao.tarefa) {
        const projeto = await db.execute<{ id: string }>(sql`SELECT app.projeto_da_missao(${q.missionId}) AS id`);
        const titulo = opcao.tarefa.titulo(payload);
        const [t] = await db
          .insert(schema.tasks)
          .values({
            content: titulo,
            description: `Criada pela resposta "${opcao.rotulo}" à pergunta do assistente (${fluxo(q.flow)?.titulo ?? q.flow}).`,
            projectId: projeto.rows[0]!.id,
            assigneePersonId: meuId,
            dueDate: opcao.tarefa.prazo === "nova_data" && data.nova_data ? data.nova_data : hojeSaoPaulo(),
            createdBy: meuId,
          })
          .returning({ id: schema.tasks.id });
        tarefa = { id: t!.id, titulo };
      }

      const resposta = {
        opcao: opcao.id,
        rotulo: opcao.rotulo,
        ...(pede.includes("nova_data") ? { nova_data: data.nova_data } : {}),
        ...(pede.includes("motivo") ? { motivo: data.motivo } : {}),
        ...(pede.includes("detalhe") ? { detalhe: data.detalhe } : {}),
        ...(tarefa ? { tarefa } : {}),
      };
      const respondidas = await db
        .update(schema.aiQuestions)
        .set({ status: "respondida", answer: resposta, answeredBy: meuId, answeredAt: new Date() })
        .where(and(eq(schema.aiQuestions.id, q.id), eq(schema.aiQuestions.status, "enviada")))
        .returning({ id: schema.aiQuestions.id });
      if (!respondidas.length) throw new IAError("Esta pergunta já foi respondida ou você não tem acesso.");

      // Confirmação de descarga: o worker envia ao filtroAPP em nome de quem respondeu (0016).
      if (opcao.descarga && payload.romaneio?.id) {
        await db.insert(schema.aiUnloadings).values({
          questionId: q.id,
          missionId: q.missionId,
          createdBy: meuId,
          request: { romaneioId: payload.romaneio.id, tipo: opcao.descarga, confirmadaEm: new Date().toISOString() },
        });
      }

      if (opcao.desvio) {
        const [missao] = await db.select({ code: schema.missions.code }).from(schema.missions).where(eq(schema.missions.id, q.missionId));
        await db.insert(schema.aiDeviations).values({
          questionId: q.id,
          missionId: q.missionId,
          createdBy: meuId,
          request: {
            type: "DESVIO",
            projectCode: missao!.code,
            eventDate: hojeSaoPaulo(),
            description: opcao.desvio(payload, { ...resposta, respondidoPor: eu?.nome ?? "alguém" }),
            impact: "MEDIO",
            externalRef: { system: "omni", url: new URL(`/?missao=${q.missionId}`, getEnv().APP_ORIGIN).toString(), reference: q.id },
          },
        });
      }
      await db.insert(schema.auditLog).values({
        actorPersonId: meuId,
        action: "ia.respondida",
        entityType: "ai_question",
        entityId: q.id,
        metadata: { flow: q.flow, opcao: opcao.id, desvio: Boolean(opcao.desvio), tarefa: tarefa?.id ?? null },
      });
      return { ok: true, desvio: Boolean(opcao.desvio), tarefa: Boolean(tarefa) };
    });
  });

export type ItemAgenda = { id: string; titulo: string; quando: string; motivo: string | null };

/** Próximas perguntas da IA na missão (o RLS só mostra a quem vê o Interno). */
export const listAgendaIA = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ItemAgenda[]> => {
    const meuId = await personIdFromRequest(getRequest());
    if (!meuId) throw new IAError("Sessão expirada. Entre de novo.");
    const rows = await withPerson(getPool(), meuId, (db) =>
      db
        .select()
        .from(schema.aiQuestions)
        .where(and(eq(schema.aiQuestions.missionId, data.missionId), eq(schema.aiQuestions.status, "agendada")))
        .orderBy(asc(schema.aiQuestions.dueAt)),
    );
    return rows.map((q) => ({ id: q.id, titulo: fluxo(q.flow)?.titulo ?? q.flow, quando: q.dueAt.toISOString(), motivo: q.motivoData }));
  });
