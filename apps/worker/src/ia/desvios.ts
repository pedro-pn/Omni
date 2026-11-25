import { fluxo, type BusinessCalendar, type Destino } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { FiltroAppError, type FiltroAppClient, type NovoRegistroQualidade } from "@omni/integrations/filtroapp";
import { and, eq, gte, isNull, lt, lte, or } from "drizzle-orm";

import { liberarFuncao, nomeDoDestino, publicarAvisoIA } from "./agenda.ts";

/**
 * Envia à Qualidade do filtroAPP os desvios abertos pelas respostas "não",
 * conforme o modo de escrita do cliente (FILTROAPP_ESCRITA):
 * - "desligada": registra e avisa só no Omni (status 'ensaio');
 * - "simulada": o filtroAPP valida com os dados reais e não grava (status 'simulado');
 * - "real": POST /qualidade/registros com a chave de idempotência do pedido
 *   (repetir após falha não duplica).
 * O responsável no filtroAPP é quem ocupa a função Qualidade no momento do envio.
 * Sempre marca no Interno a função Qualidade e o gestor de contrato, mais as
 * funções que a opção da resposta pede (ex.: Gerente comercial no saldo não
 * medido). As funções marcadas passam a ver o Interno da missão.
 */

export type FonteDesvios = Pick<FiltroAppClient, "criarRegistroQualidade" | "escrita">;

const MAX_TENTATIVAS = 5;

/** Funções a marcar além da Qualidade e do gestor, conforme a opção respondida. */
async function funcoesExtras(db: Db, questionId: string): Promise<Destino[]> {
  const [q] = await db
    .select({ flow: schema.aiQuestions.flow, answer: schema.aiQuestions.answer })
    .from(schema.aiQuestions)
    .where(eq(schema.aiQuestions.id, questionId));
  const opcao = q ? fluxo(q.flow)?.opcoes.find((o) => o.id === (q.answer as { opcao?: string } | null)?.opcao) : undefined;
  return opcao?.marcar ?? [];
}

const juntar = (nomes: string[]) => (nomes.length < 2 ? (nomes[0] ?? "") : `${nomes.slice(0, -1).join(", ")} e ${nomes.at(-1)}`);

async function emailDaQualidade(db: Db, hoje: string): Promise<string | null> {
  const [f] = await db
    .select({ email: schema.people.email })
    .from(schema.functionAssignments)
    .innerJoin(schema.people, eq(schema.people.id, schema.functionAssignments.personId))
    .where(
      and(
        eq(schema.functionAssignments.functionCode, "qualidade"),
        lte(schema.functionAssignments.startsOn, hoje),
        or(isNull(schema.functionAssignments.endsOn), gte(schema.functionAssignments.endsOn, hoje)),
        eq(schema.people.active, true),
      ),
    )
    .limit(1);
  return f?.email ?? null;
}

export async function enviarDesvios(
  db: Db,
  fonte: FonteDesvios | null,
  cal: BusinessCalendar,
  agora: Date = new Date(),
): Promise<{ enviados: number; simulados: number; ensaio: number; falhas: number }> {
  const hoje = cal.dateKeyOf(agora);
  const pendentes = await db
    .select()
    .from(schema.aiDeviations)
    .where(
      or(
        eq(schema.aiDeviations.status, "pendente"),
        and(eq(schema.aiDeviations.status, "falhou"), lt(schema.aiDeviations.attempts, MAX_TENTATIVAS)),
      ),
    )
    .limit(20);

  const resultado = { enviados: 0, simulados: 0, ensaio: 0, falhas: 0 };
  for (const d of pendentes) {
    const qualidade = await nomeDoDestino(db, d.missionId, { funcao: "qualidade" }, hoje);
    const gestor = await nomeDoDestino(db, d.missionId, { papel: "PLANNER" }, hoje);
    const extras = await funcoesExtras(db, d.questionId);
    const nomesExtras = await Promise.all(extras.map((x) => nomeDoDestino(db, d.missionId, x, hoje)));
    const marcar = juntar([qualidade, gestor, ...nomesExtras]);
    for (const x of [{ funcao: "qualidade" }, ...extras]) {
      if ("funcao" in x) await liberarFuncao(db, d.missionId, x.funcao, "desvio");
    }

    if (!fonte || fonte.escrita === "desligada") {
      await db.update(schema.aiDeviations).set({ status: "ensaio", sentAt: agora, error: null }).where(eq(schema.aiDeviations.id, d.id));
      await publicarAvisoIA(
        db,
        d.missionId,
        `${marcar}: desvio registrado a partir da resposta acima (escrita no filtroAPP desligada neste ambiente — não foi enviado à Qualidade).`,
      );
      resultado.ensaio += 1;
      continue;
    }

    const email = await emailDaQualidade(db, hoje);
    if (!email) {
      await db
        .update(schema.aiDeviations)
        .set({ status: "falhou", attempts: MAX_TENTATIVAS, error: "Função Qualidade vaga" })
        .where(eq(schema.aiDeviations.id, d.id));
      await publicarAvisoIA(
        db,
        d.missionId,
        `${gestor}: não consegui abrir o desvio na Qualidade porque a função Qualidade está vaga. Peça à diretoria para definir quem ocupa a função em Administração → Funções.`,
      );
      resultado.falhas += 1;
      continue;
    }

    try {
      const corpo = { ...(d.request as unknown as Omit<NovoRegistroQualidade, "actionOwnerEmail">), actionOwnerEmail: email };
      const r = await fonte.criarRegistroQualidade(corpo, d.idempotencyKey);
      if (r.simulado) {
        await db.update(schema.aiDeviations).set({ status: "simulado", sentAt: new Date(), error: null }).where(eq(schema.aiDeviations.id, d.id));
        await publicarAvisoIA(
          db,
          d.missionId,
          `${marcar}: simulação — o filtroAPP aceitaria este desvio na Qualidade, mas nada foi gravado (ambiente de teste).`,
        );
        resultado.simulados += 1;
        continue;
      }
      await db
        .update(schema.aiDeviations)
        .set({ status: "enviado", filtroappId: r.resultado.id, filtroappNumber: r.resultado.number, sentAt: new Date(), error: null })
        .where(eq(schema.aiDeviations.id, d.id));
      await publicarAvisoIA(db, d.missionId, `${marcar}: desvio ${r.resultado.number} aberto na Qualidade do filtroAPP a partir da resposta acima.`);
      resultado.enviados += 1;
    } catch (error) {
      // 4xx de validação não melhora repetindo; rede, 429 e 5xx sim.
      const definitivo = error instanceof FiltroAppError && error.status >= 400 && error.status < 500 && error.status !== 429;
      await db
        .update(schema.aiDeviations)
        .set({
          status: "falhou",
          attempts: definitivo ? MAX_TENTATIVAS : d.attempts + 1,
          error: String((error as Error).message).slice(0, 300),
        })
        .where(eq(schema.aiDeviations.id, d.id));
      if (definitivo || d.attempts + 1 >= MAX_TENTATIVAS) {
        await publicarAvisoIA(db, d.missionId, `${marcar}: não consegui abrir o desvio na Qualidade do filtroAPP. Registre manualmente; o detalhe ficou no Omni.`);
      }
      resultado.falhas += 1;
    }
  }
  return resultado;
}

