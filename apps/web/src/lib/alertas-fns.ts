import { comandoDeAlerta, ESQUEMA_ENTENDER_ALERTA, QUEM_MARCAR, resumoDaRegra, SISTEMA_ENTENDER_ALERTA, tituloMissao, validarRegra, VERSAO_PROMPT_ALERTA, type RegraAlertaIA } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { LlmError } from "@omni/integrations/openai";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { getLlmAlertas } from "../server/llm.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Alertas pedidos à IA no Interno/Gerencial (`@IA` ou `/alerta`, INSTRUCOES §7.6).
 * O pedido vai ao LLM (saída estruturada); a IA responde no canal com o cartão
 * "entendi assim" e o alerta só vale depois que quem pediu ativa. Permissões no
 * banco (migration 0031: app.criar_alerta, app.responder_alerta, RLS por canal).
 */

const canal = z.enum(["interno", "gerencial"]);

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export type ResultadoComando = { criado: true } | { criado: false; duvida: string };

/** Lê o comando (já postado no canal como mensagem de quem pediu) e cria o alerta em rascunho com o cartão no canal. */
export const criarAlertaPorComando = createServerFn({ method: "POST" })
  .validator(z.object({ missionId: z.uuid(), channel: canal, texto: z.string().trim().min(1).max(2000) }))
  .handler(async ({ data }): Promise<ResultadoComando> => {
    const personId = await pessoa();
    const pedido = comandoDeAlerta(data.texto);
    if (pedido === null) throw new ErroParaTela("Comece com @IA ou /alerta.");
    if (pedido.length < 8) {
      return { criado: false, duvida: 'Diga o que devo vigiar. Ex.: "@IA me avise se nos RDOs não vier a metragem de tubulação liberada por dois dias seguidos".' };
    }
    const ia = getLlmAlertas();
    if (!ia) return { criado: false, duvida: "Os alertas pela IA estão desligados neste ambiente." };
    let regra: RegraAlertaIA;
    try {
      const r = await ia.llm.estruturado<unknown>({
        modelo: ia.modelo,
        sistema: SISTEMA_ENTENDER_ALERTA,
        entrada: pedido,
        nome: "entender_alerta",
        esquema: ESQUEMA_ENTENDER_ALERTA as unknown as Record<string, unknown>,
      });
      const v = validarRegra(r.dados);
      if ("duvida" in v) return { criado: false, duvida: v.duvida };
      regra = v.regra;
    } catch (error) {
      if (error instanceof LlmError) throw new ErroParaTela("A IA não respondeu agora. Tente de novo em instantes.");
      throw error;
    }
    return withPerson(getPool(), personId, async (db) => {
      const [m] = await db.select({ code: schema.missions.code, cliente: schema.missions.clientName }).from(schema.missions).where(eq(schema.missions.id, data.missionId));
      if (!m) throw new ErroParaTela("Missão não encontrada.");
      try {
        await db.execute(
          sql`SELECT app.criar_alerta(${data.missionId}::uuid, ${data.channel}, ${pedido}, ${JSON.stringify(regra)}::jsonb, ${resumoDaRegra(regra, tituloMissao(m.code, m.cliente), data.channel)}, ${VERSAO_PROMPT_ALERTA})`,
        );
      } catch {
        throw new ErroParaTela("Você não participa deste canal.");
      }
      return { criado: true as const };
    });
  });

export const mudarAlerta = createServerFn({ method: "POST" })
  .validator(z.object({ alertId: z.uuid(), status: z.enum(["ativo", "pausado", "cancelado"]) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [a] = await db
        .update(schema.aiAlerts)
        .set({ status: data.status, ...(data.status === "ativo" ? { activatedAt: new Date() } : {}) })
        .where(eq(schema.aiAlerts.id, data.alertId))
        .returning({ id: schema.aiAlerts.id, missionId: schema.aiAlerts.missionId });
      if (!a) throw new ErroParaTela("Só quem pediu o alerta (ou a diretoria) pode mudá-lo.");
      return { ok: true };
    });
  });

const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

export const responderAlerta = createServerFn({ method: "POST" })
  .validator(z.object({ fireId: z.uuid(), opcao: z.enum(["nao_veio", "cobrar", "veio"]), exemplo: z.string().trim().max(300).optional() }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      let missionId: string;
      try {
        missionId = (await db.execute<{ id: string }>(sql`SELECT app.responder_alerta(${data.fireId}::uuid, ${data.opcao}, ${data.exemplo ?? null}) AS id`)).rows[0]!.id;
      } catch (error) {
        const msg = String((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
        throw new ErroParaTela(/Conte como/.test(msg) ? "Conte como estava escrito no RDO." : /respondido/.test(msg) ? "Este alerta já foi respondido." : "Você não pode responder a este alerta.");
      }
      // "Vou cobrar o líder de campo": vira tarefa de quem respondeu, no projeto da missão.
      if (data.opcao === "cobrar") {
        const [a] = await db
          .select({ spec: schema.aiAlerts.spec })
          .from(schema.aiAlertFires)
          .innerJoin(schema.aiAlerts, eq(schema.aiAlerts.id, schema.aiAlertFires.alertId))
          .where(eq(schema.aiAlertFires.id, data.fireId));
        try {
          const projeto = (await db.execute<{ id: string }>(sql`SELECT app.projeto_da_missao(${missionId}) AS id`)).rows[0]!.id;
          await db.insert(schema.tasks).values({
            content: `Cobrar o líder de campo: ${(a?.spec as RegraAlertaIA | undefined)?.oQue ?? "informação do alerta"} nos RDOs`,
            description: "Criada pela resposta a um alerta pedido à IA.",
            projectId: projeto,
            assigneePersonId: personId,
            dueDate: hojeSaoPaulo(),
            createdBy: personId,
          });
        } catch {
          // Sem acesso ao projeto da missão (ex.: alerta do Gerencial): a resposta vale do mesmo jeito.
        }
      }
      return { ok: true };
    });
  });

export type AlertaDaMissao = { id: string; canal: "interno" | "gerencial"; regra: RegraAlertaIA; quem: string; status: string; disparos: number; pedidoPor: string; exemplos: number; podeMudar: boolean };

export const alertasDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<AlertaDaMissao[]> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const [diretoria] = (await db.execute<{ ok: boolean }>(sql`SELECT app.has_profile('diretoria') AS ok`)).rows;
      const linhas = await db
        .select({ a: schema.aiAlerts, nome: schema.people.displayName })
        .from(schema.aiAlerts)
        .innerJoin(schema.people, eq(schema.people.id, schema.aiAlerts.createdBy))
        .where(and(eq(schema.aiAlerts.missionId, data.missionId), sql`${schema.aiAlerts.status} <> 'cancelado'`))
        .orderBy(desc(schema.aiAlerts.createdAt));
      return linhas.map(({ a, nome }) => ({
        id: a.id,
        canal: a.channel,
        regra: a.spec as RegraAlertaIA,
        quem: QUEM_MARCAR[(a.spec as RegraAlertaIA).marcar],
        status: a.status,
        disparos: a.fires,
        pedidoPor: nome,
        exemplos: a.examples.length,
        podeMudar: a.createdBy === personId || Boolean(diretoria?.ok),
      }));
    });
  });
