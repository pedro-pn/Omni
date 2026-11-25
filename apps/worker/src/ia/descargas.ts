import type { BusinessCalendar } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { FiltroAppError, type FiltroAppClient } from "@omni/integrations/filtroapp";
import { and, eq, lt, or } from "drizzle-orm";

import { publicarAvisoIA } from "./agenda.ts";

/**
 * Envia ao filtroAPP as confirmações de chegada e descarga respondidas no Omni
 * (POST /logistica/descargas, spec 034 B5), conforme FILTROAPP_ESCRITA — mesmo
 * padrão dos desvios:
 * - "desligada": registra só no Omni (status 'ensaio');
 * - "simulada": o filtroAPP valida com os dados reais e não grava ('simulado');
 * - "real": grava, com a chave de idempotência do pedido.
 * Quem confirma é quem respondeu: o e-mail precisa ser de um usuário do
 * filtroAPP com acesso à missão (senão 422, e o aviso explica como confirmar lá).
 */

export type FonteDescargas = Pick<FiltroAppClient, "criarDescarga" | "escrita">;

const MAX_TENTATIVAS = 5;

export async function enviarDescargas(
  db: Db,
  fonte: FonteDescargas | null,
  _cal: BusinessCalendar,
  agora: Date = new Date(),
): Promise<{ enviadas: number; simuladas: number; ensaio: number; falhas: number }> {
  const pendentes = await db
    .select({ d: schema.aiUnloadings, email: schema.people.email, nome: schema.people.displayName })
    .from(schema.aiUnloadings)
    .innerJoin(schema.people, eq(schema.people.id, schema.aiUnloadings.createdBy))
    .where(
      or(
        eq(schema.aiUnloadings.status, "pendente"),
        and(eq(schema.aiUnloadings.status, "falhou"), lt(schema.aiUnloadings.attempts, MAX_TENTATIVAS)),
      ),
    )
    .limit(20);

  const resultado = { enviadas: 0, simuladas: 0, ensaio: 0, falhas: 0 };
  for (const { d, email, nome } of pendentes) {
    const tipo = d.request.tipo === "TOTAL" ? "total" : "parcial";
    if (!fonte || fonte.escrita === "desligada") {
      await db.update(schema.aiUnloadings).set({ status: "ensaio", sentAt: agora, error: null }).where(eq(schema.aiUnloadings.id, d.id));
      await publicarAvisoIA(db, d.missionId, `${nome}: descarga ${tipo} registrada só no Omni (escrita no filtroAPP desligada neste ambiente).`);
      resultado.ensaio += 1;
      continue;
    }
    try {
      const r = await fonte.criarDescarga({ ...d.request, confirmadaPorEmail: String(email) }, d.idempotencyKey);
      if (r.simulado) {
        await db.update(schema.aiUnloadings).set({ status: "simulado", sentAt: new Date(), error: null }).where(eq(schema.aiUnloadings.id, d.id));
        await publicarAvisoIA(db, d.missionId, `${nome}: simulação — o filtroAPP aceitaria a descarga ${tipo}, mas nada foi gravado (ambiente de teste).`);
        resultado.simuladas += 1;
        continue;
      }
      await db
        .update(schema.aiUnloadings)
        .set({ status: "enviado", filtroappId: r.resultado.id, sentAt: new Date(), error: null })
        .where(eq(schema.aiUnloadings.id, d.id));
      await publicarAvisoIA(db, d.missionId, `${nome}: descarga ${tipo} confirmada no filtroAPP.`);
      resultado.enviadas += 1;
    } catch (error) {
      const fa = error instanceof FiltroAppError ? error : null;
      // 409: já havia descarga total para o romaneio — nada a fazer.
      if (fa?.status === 409) {
        await db
          .update(schema.aiUnloadings)
          .set({ status: "enviado", sentAt: new Date(), error: "Já havia descarga total no filtroAPP" })
          .where(eq(schema.aiUnloadings.id, d.id));
        await publicarAvisoIA(db, d.missionId, `${nome}: o filtroAPP já tinha a descarga total deste romaneio. Nada mudou.`);
        resultado.enviadas += 1;
        continue;
      }
      const definitivo = Boolean(fa && fa.status >= 400 && fa.status < 500 && fa.status !== 429);
      await db
        .update(schema.aiUnloadings)
        .set({ status: "falhou", attempts: definitivo ? MAX_TENTATIVAS : d.attempts + 1, error: String((error as Error).message).slice(0, 300) })
        .where(eq(schema.aiUnloadings.id, d.id));
      if (fa?.status === 422) {
        await publicarAvisoIA(
          db,
          d.missionId,
          `${nome}: o filtroAPP não aceitou a confirmação em seu nome (seu usuário não tem acesso a esta missão lá). Confirme pelo filtroAPP: Efetivo → missão → Ver romaneios → Chegada e descarga.`,
        );
      } else if (definitivo || d.attempts + 1 >= MAX_TENTATIVAS) {
        await publicarAvisoIA(db, d.missionId, `${nome}: não consegui registrar a descarga no filtroAPP. Confirme por lá; o detalhe ficou no Omni.`);
      }
      resultado.falhas += 1;
    }
  }
  return resultado;
}
