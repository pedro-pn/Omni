import {
  addDays,
  entradaLeituraRdo,
  ESQUEMA_LEITURA_RDO,
  SISTEMA_LEITURA_RDO,
  textoDosPontos,
  tituloMissao,
  validarPontosDoModelo,
  verificarRegime,
  VERSAO_PROMPT_RDO,
  type BusinessCalendar,
  type PontoRdo,
} from "@omni/core";
import { schema, type Db } from "@omni/db";
import { LlmError, type Llm } from "@omni/integrations/openai";
import { sql } from "drizzle-orm";

/**
 * Leitura diária dos RDOs (Fase 8): para cada RDO recente ainda não lido, as
 * regras do regime (código) e, se o LLM estiver ligado, a leitura do texto.
 * Achou algo: pergunta `rdo_leitura` no Interno, no próximo horário útil, pelo
 * mesmo caminho das outras perguntas da IA (resposta vira tarefa ou desvio).
 * Cada chamada ao modelo fica em `llm_calls`, sem o texto.
 */

export const JANELA_LEITURA_DIAS = 3;
const SEM_CREDITO = new Set(["insufficient_quota", "credit_balance_exhausted", "billing_hard_limit_reached", "invalid_api_key"]);

export type ResultadoLeitura = { lidos: number; comPontos: number; perguntas: number; erros: number; parouSemCredito: boolean };

type Candidato = {
  id: string;
  mission_id: string;
  report_type: string;
  report_number: string | null;
  report_date: string;
  daily_description: string;
  worked_minutes: number | null;
  overtime_minutes: number | null;
  overtime_reason: string | null;
  code: string;
  client_name: string;
  includes_saturday: boolean | null;
  includes_sunday: boolean | null;
  workday_hours: string | null;
};

export async function lerRdos(
  db: Db,
  llm: Llm | null,
  cal: BusinessCalendar,
  opcoes: { modelo: string; now?: () => Date; maxPorRodada?: number },
): Promise<ResultadoLeitura> {
  const agora = (opcoes.now ?? (() => new Date()))();
  const hoje = cal.dateKeyOf(agora);
  const r: ResultadoLeitura = { lidos: 0, comPontos: 0, perguntas: 0, erros: 0, parouSemCredito: false };

  const candidatos = (
    await db.execute<Candidato>(sql`
      SELECT r.id, r.mission_id, r.report_type, r.report_number, r.report_date::text, r.daily_description,
             r.worked_minutes, r.overtime_minutes, r.overtime_reason,
             m.code, m.client_name, m.includes_saturday, m.includes_sunday, m.workday_hours
        FROM reports r JOIN missions m ON m.id = r.mission_id
       WHERE r.report_type LIKE 'RDO%'
         AND r.report_date BETWEEN ${addDays(hoje, -JANELA_LEITURA_DIAS)}::date AND ${hoje}::date
         AND length(coalesce(r.daily_description, '')) >= 30
         AND m.is_active AND m.cycle_closed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM rdo_analyses a WHERE a.report_id = r.id)
       ORDER BY r.report_date, r.id
       LIMIT ${opcoes.maxPorRodada ?? 40}`)
  ).rows;

  for (const c of candidatos) {
    const rdo = {
      data: c.report_date,
      texto: c.daily_description,
      minutosTrabalhados: c.worked_minutes,
      minutosExtras: c.overtime_minutes,
      motivoExtra: c.overtime_reason,
    };
    const regime = { trabalhaSabado: c.includes_saturday, trabalhaDomingo: c.includes_sunday, jornada: c.workday_hours };
    const pontos: PontoRdo[] = verificarRegime(rdo, regime, cal);
    let llmCallId: string | null = null;
    let modelo: string | null = null;

    if (llm) {
      try {
        const resposta = await llm.estruturado<{ pontos: unknown }>({
          modelo: opcoes.modelo,
          sistema: SISTEMA_LEITURA_RDO,
          entrada: entradaLeituraRdo(rdo, regime),
          nome: "leitura_rdo",
          esquema: ESQUEMA_LEITURA_RDO as unknown as Record<string, unknown>,
        });
        modelo = resposta.modelo;
        const [chamada] = await db
          .insert(schema.llmCalls)
          .values({
            purpose: "rdo_leitura",
            model: resposta.modelo,
            inputTokens: resposta.tokensEntrada,
            outputTokens: resposta.tokensSaida,
            durationMs: resposta.duracaoMs,
            outcome: "ok",
            missionId: c.mission_id,
            dataIds: { reportId: c.id, prompt: VERSAO_PROMPT_RDO },
          })
          .returning({ id: schema.llmCalls.id });
        llmCallId = chamada!.id;
        pontos.push(...validarPontosDoModelo(resposta.dados.pontos, c.daily_description));
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        r.erros += 1;
        await db.insert(schema.llmCalls).values({
          purpose: "rdo_leitura",
          model: opcoes.modelo,
          outcome: "erro",
          errorCode: error.code ?? String(error.status),
          missionId: c.mission_id,
          dataIds: { reportId: c.id, prompt: VERSAO_PROMPT_RDO },
        });
        // Sem crédito ou chave recusada: para a rodada sem marcar o RDO como lido (tenta de novo depois).
        if (SEM_CREDITO.has(error.code ?? "")) {
          r.parouSemCredito = true;
          break;
        }
        continue;
      }
    }

    r.lidos += 1;
    let questionId: string | null = null;
    if (pontos.length) {
      r.comPontos += 1;
      const [q] = await db
        .insert(schema.aiQuestions)
        .values({
          missionId: c.mission_id,
          flow: "rdo_leitura",
          dedupeKey: `rdo_leitura:${c.id}`,
          dueAt: cal.nextSendSlot(agora),
          addressedTo: { papel: "LEADER" },
          payload: {
            missao: { codigo: c.code, titulo: tituloMissao(c.code, c.client_name) },
            relatorio: { id: c.id, tipo: c.report_type, numero: c.report_number, data: c.report_date },
            leitura: { pontos: textoDosPontos(pontos), quantidade: pontos.length },
          },
          motivoData: "Leitura do RDO pela IA",
        })
        .onConflictDoNothing({ target: schema.aiQuestions.dedupeKey })
        .returning({ id: schema.aiQuestions.id });
      if (q) {
        questionId = q.id;
        r.perguntas += 1;
      }
    }
    await db
      .insert(schema.rdoAnalyses)
      .values({ reportId: c.id, missionId: c.mission_id, promptVersion: VERSAO_PROMPT_RDO, model: modelo, points: pontos, questionId, llmCallId })
      .onConflictDoNothing();
  }
  return r;
}
