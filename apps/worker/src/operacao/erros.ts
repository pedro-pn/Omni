import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { avaliarOperacao, deveAvisarErro, resumirErro, type StatusDeBackup, type StatusDeEnsaio } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

/**
 * Erros do sistema (E09, pilar 12.1; migration 0079).
 *
 * - `registrarErroDoWorker`: grava um erro do worker (job que falhou, erro do processo) pela função
 *   `app.registrar_erro`, já limpo por `resumirErro` (sem e-mail, CPF, telefone, token).
 * - `avisarErros` (job `alertas-erros`, 5 min): erro novo, ou que voltou depois de 6 h, vira aviso
 *   `erro_sistema` no sino e no celular de quem tem o perfil admin. Apaga os já vistos com mais de 90 dias.
 * - `conferirOperacao` (job `saude-operacao`, 1 h; OPERACAO_STATUS=ligado): lê os JSON de status do
 *   backup e do ensaio de restauração (deploy/backup-prod.sh e restore-drill.sh, montados em /ops-status)
 *   e registra como erro o que estiver fora do limite (backup no B2 com mais de 26 h, ensaio com mais de 35 dias).
 */

const versao = () => (process.env.OMNI_VERSAO || "").slice(0, 12) || null;

export async function registrarErroDoWorker(db: Db, erro: unknown, local: string): Promise<void> {
  const r = resumirErro(erro, "worker", local);
  try {
    await db.execute(
      sql`SELECT app.registrar_erro(${r.assinatura}, ${r.origem}, ${r.nome}, ${r.mensagem}, ${r.detalhe}, ${r.local}, ${versao()})`,
    );
  } catch (falha) {
    // Registrar nunca pode derrubar o worker; o log continua tendo o erro.
    console.error("[erros] não foi possível registrar:", (falha as Error).message);
  }
}

async function registrarProblema(db: Db, chave: string, mensagem: string): Promise<void> {
  await db.execute(
    sql`SELECT app.registrar_erro(${`operacao|${chave}`}, 'operacao', ${chave}, ${mensagem}, NULL, 'backup', ${versao()})`,
  );
}

export type ResultadoAvisos = { erros: number; avisos: number; apagados: number };

export async function avisarErros(db: Db, agora = new Date()): Promise<ResultadoAvisos> {
  const r: ResultadoAvisos = { erros: 0, avisos: 0, apagados: 0 };
  const pendentes = await db
    .select({
      id: schema.systemErrors.id,
      origem: schema.systemErrors.source,
      local: schema.systemErrors.location,
      mensagem: schema.systemErrors.message,
      ocorrencias: schema.systemErrors.occurrences,
      ultimaVez: schema.systemErrors.lastSeen,
      avisadoEm: schema.systemErrors.alertedAt,
    })
    .from(schema.systemErrors)
    .where(sql`${schema.systemErrors.alertedAt} IS NULL OR ${schema.systemErrors.lastSeen} > ${schema.systemErrors.alertedAt}`);
  const aAvisar = pendentes.filter((e) => deveAvisarErro(e, agora));
  if (aAvisar.length) {
    const admins = (
      await db.execute<{ id: string }>(sql`
        SELECT DISTINCT p.id FROM people p JOIN person_profiles pp ON pp.person_id = p.id
         WHERE p.active AND pp.profile = 'admin'`)
    ).rows.map((x) => x.id);
    for (const e of aAvisar) {
      r.erros += 1;
      const onde = e.origem === "operacao" ? "Backup" : `${e.origem === "web" ? "Web" : "Worker"} · ${e.local}`;
      const titulo = `Erro no Omni: ${onde}`.slice(0, 200);
      const corpo = `${e.mensagem}${e.ocorrencias > 1 ? ` (${e.ocorrencias} vezes)` : ""}`.slice(0, 500);
      const janela = Math.floor(agora.getTime() / 3_600_000);
      for (const destino of admins) {
        const feito = await db
          .insert(schema.notifications)
          .values({ personId: destino, kind: "erro_sistema", title: titulo, body: corpo, dedupeKey: `erro:${e.id}:${janela}:${destino}` })
          .onConflictDoNothing()
          .returning({ id: schema.notifications.id });
        r.avisos += feito.length;
      }
      await db.update(schema.systemErrors).set({ alertedAt: agora }).where(eq(schema.systemErrors.id, e.id));
    }
  }
  const apagados = await db
    .delete(schema.systemErrors)
    .where(and(isNotNull(schema.systemErrors.reviewedAt), lt(schema.systemErrors.lastSeen, new Date(agora.getTime() - 90 * 24 * 3_600_000))))
    .returning({ id: schema.systemErrors.id });
  r.apagados = apagados.length;
  return r;
}

async function lerJson<T>(caminho: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(caminho, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function conferirOperacao(db: Db, pasta: string, agora = new Date()): Promise<{ problemas: string[] }> {
  const [ultimoBackup, backupRemoto, ensaio] = await Promise.all([
    lerJson<StatusDeBackup>(join(pasta, "backup-latest.json")),
    lerJson<StatusDeBackup>(join(pasta, "backup-remoto-latest.json")),
    lerJson<StatusDeEnsaio>(join(pasta, "restore-latest.json")),
  ]);
  const problemas = avaliarOperacao({ ultimoBackup, backupRemoto, ensaio }, agora);
  for (const p of problemas) await registrarProblema(db, p.chave, p.mensagem);
  return { problemas: problemas.map((p) => p.chave) };
}
