import { createHash } from "node:crypto";

import type pg from "pg";

import type { FonteFoco, Linha } from "./fonte.ts";
import { FocoError } from "./fonte.ts";
import { TABELAS_MIGRADAS, TABELAS_SEM_DESTINO, transformar, type Carga, type DadosFoco, type Relatorio } from "./transformar.ts";

/**
 * Carga do Foco no Omni (Fase 3, PLANEJAMENTO §3.3), repetível: lê tudo do Foco, transforma
 * e grava numa transação só, com o MESMO id de cada linha (upsert). Na carga final do corte,
 * o que sumiu do Foco desde a carga anterior sai do Omni (só as linhas que vieram do Foco,
 * `foco_id`); o que o Omni criou não é tocado.
 *
 * - Ensaio (padrão): faz tudo, confere as contagens e desfaz (ROLLBACK). Anexos: baixa e
 *   confere o tamanho, sem enviar ao SharePoint.
 * - Real: grava (COMMIT). Anexos: envia ao SharePoint do Omni (Tarefas/<tarefa>/<id>.<ext>)
 *   antes da transação, com o SHA-256 guardado.
 *
 * Os gatilhos de histórico e de avisos das tarefas ficam desligados durante a carga (sem
 * "Criou a tarefa" nem avisos em massa); o histórico do Foco vem junto. Precisa do papel
 * dono das tabelas (DATABASE_URL_OWNER).
 */

export type EnviarArquivo = (driveId: string, caminho: string, conteudo: Uint8Array) => Promise<{ id: string; tamanho: number }>;
export type OpcoesImportar = {
  real: boolean;
  /** Envio ao SharePoint (GraphClient.enviarArquivo); obrigatório no modo real se houver anexos. */
  enviarArquivo?: EnviarArquivo | null;
  driveId?: string | null;
  /** "Tarefas" na produção; "Tarefas-<ambiente>" fora dela. */
  pastaAnexos?: string;
  pularChaves?: string[];
  conversas?: string[];
  /** Uma chave `foco_live_…` para conferir se continua valendo (nunca é guardada nem mostrada). */
  conferirToken?: string | null;
  log?: (m: string) => void;
};
export type ResultadoImportacao = {
  real: boolean;
  relatorio: Relatorio;
  gravadas: Record<string, number>;
  removidas: Record<string, number>;
  conferencia: Record<string, { esperado: number; noOmni: number }>;
  anexos: { copiados: number; conferidos: number; jaEstavam: number; falharam: { focoId: string; motivo: string }[] };
  agendasEmConflito: string[];
  projetosMantidos: string[];
  /** Nome da chave migrada que tem o mesmo hash do token conferido; null = não está entre as que migram. */
  tokenConferido?: string | null;
};

/** Todas as tabelas do Foco que a carga usa (as que não existem voltam vazias). */
export async function lerFoco(fonte: FonteFoco, log: (m: string) => void = () => undefined): Promise<DadosFoco> {
  const OBRIGATORIAS = new Set(["projects", "tasks", "project_members", "sections", "comments"]);
  const d: Record<string, Linha[] | null> = {};
  for (const t of [...TABELAS_MIGRADAS, ...TABELAS_SEM_DESTINO]) {
    const linhas = await fonte.tabela(t);
    if (linhas === null && OBRIGATORIAS.has(t)) throw new FocoError(`A tabela ${t} não existe no Foco.`);
    d[t] = linhas ?? ((TABELAS_MIGRADAS as readonly string[]).includes(t) ? [] : null);
    log(`  ${t}: ${linhas === null ? "não existe" : linhas.length}`);
  }
  const usuarios = await fonte.usuarios();
  log(`  usuários: ${usuarios.length}`);
  return { ...(d as unknown as DadosFoco), usuarios };
}

const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
const extensao = (nome: string) => nome.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase() ?? "bin";

/** INSERT … SELECT FROM jsonb_populate_recordset … ON CONFLICT, em lotes. */
async function gravar(c: pg.PoolClient, tabela: string, linhas: Record<string, unknown>[], conflito: string | null, atualizar: "tudo" | "nada"): Promise<number> {
  if (!linhas.length) return 0;
  const cols = Object.keys(linhas[0]!);
  const lista = cols.map(q).join(", ");
  const chave = (conflito ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const set = atualizar === "tudo" ? cols.filter((x) => !chave.includes(x)) : [];
  const acao = set.length && chave.length ? `(${chave.map(q).join(", ")}) DO UPDATE SET ${set.map((x) => `${q(x)} = EXCLUDED.${q(x)}`).join(", ")}` : `${chave.length ? `(${chave.map(q).join(", ")})` : ""} DO NOTHING`;
  const texto = `INSERT INTO ${tabela} (${lista}) SELECT ${lista} FROM jsonb_populate_recordset(NULL::${tabela}, $1::jsonb) ON CONFLICT ${acao}`;
  let total = 0;
  for (let i = 0; i < linhas.length; i += 500) {
    const r = await c.query(texto, [JSON.stringify(linhas.slice(i, i + 500))]);
    total += r.rowCount ?? 0;
  }
  return total;
}

const COM_GATILHOS = ["tasks", "task_comments", "task_comment_mentions", "task_comment_reactions", "task_projects"];

export async function importarFoco(owner: pg.Pool, fonte: FonteFoco, op: OpcoesImportar): Promise<ResultadoImportacao> {
  const log = op.log ?? (() => undefined);
  log("Lendo o Foco…");
  const dados = await lerFoco(fonte, log);
  const pessoas = (await owner.query<{ id: string; email: string; active: boolean }>("SELECT id, email::text AS email, active FROM people")).rows;
  const missoes = (
    await owner.query<{ id: string; code: string; projeto_id: string | null }>("SELECT m.id, m.code, p.id AS projeto_id FROM missions m LEFT JOIN task_projects p ON p.mission_id = m.id")
  ).rows.map((m) => ({ id: m.id, code: m.code, projetoId: m.projeto_id }));
  const { carga, relatorio } = transformar(dados, pessoas, missoes, { pularChaves: op.pularChaves, conversas: op.conversas });

  // ---------------------------------------------------------------- anexos (fora da transação)
  const anexos: ResultadoImportacao["anexos"] = { copiados: 0, conferidos: 0, jaEstavam: 0, falharam: [] };
  const linhasDeAnexo: Record<string, unknown>[] = [];
  const jaNoOmni = new Set(
    carga.anexos.length ? (await owner.query<{ foco_id: string }>("SELECT foco_id FROM task_attachments WHERE foco_id = ANY($1::uuid[])", [carga.anexos.map((a) => a.focoId)])).rows.map((r) => r.foco_id) : [],
  );
  if (op.real && carga.anexos.some((a) => !jaNoOmni.has(a.focoId)) && (!op.enviarArquivo || !op.driveId)) {
    throw new FocoError("Os anexos precisam do SharePoint do Omni (GRAPH_ANEXOS_DRIVE_ID e o certificado do Graph).");
  }
  for (const a of carga.anexos) {
    if (jaNoOmni.has(a.focoId)) {
      anexos.jaEstavam += 1;
      continue;
    }
    try {
      const bytes = await fonte.arquivo(a.chave);
      if (a.tamanho > 0 && bytes.byteLength !== a.tamanho) throw new FocoError(`tamanho diferente (${bytes.byteLength} × ${a.tamanho})`);
      if (!bytes.byteLength) throw new FocoError("arquivo vazio");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (!op.real) {
        anexos.conferidos += 1;
        continue;
      }
      const item = await op.enviarArquivo!(op.driveId!, `${op.pastaAnexos ?? "Tarefas"}/${a.taskId}/${a.focoId}.${extensao(a.nome)}`, bytes);
      if (item.tamanho !== bytes.byteLength) throw new FocoError("o SharePoint guardou um tamanho diferente");
      linhasDeAnexo.push({ id: a.focoId, task_id: a.taskId, name: a.nome, mime: a.tipo, size: bytes.byteLength, sha256, sp_drive_id: op.driveId, sp_item_id: item.id, uploaded_by: a.autor, created_at: a.em, foco_id: a.focoId });
      anexos.copiados += 1;
    } catch (error) {
      anexos.falharam.push({ focoId: a.focoId, motivo: error instanceof Error ? error.message : "falhou" });
    }
  }

  // ---------------------------------------------------------------- transação
  const c = await owner.connect();
  const gravadas: Record<string, number> = {};
  const removidas: Record<string, number> = {};
  const conferencia: ResultadoImportacao["conferencia"] = {};
  const agendasEmConflito: string[] = [];
  const projetosMantidos: string[] = [];
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '15s'");
    await c.query("SET LOCAL statement_timeout = '10min'");
    for (const t of COM_GATILHOS) await c.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);

    gravadas.task_projects = await gravar(c, "task_projects", carga.projetos, "id", "tudo");
    gravadas.task_project_members = await gravar(c, "task_project_members", carga.membros, "project_id, person_id", "tudo");
    gravadas.task_sections = await gravar(c, "task_sections", carga.secoes, "id", "tudo");
    // Principais antes das subtarefas.
    gravadas.tasks =
      (await gravar(c, "tasks", carga.tarefas.filter((t) => !t.parent_task_id), "id", "tudo")) +
      (await gravar(c, "tasks", carga.tarefas.filter((t) => t.parent_task_id), "id", "tudo"));
    gravadas.task_comments = await gravar(c, "task_comments", carga.comentarios, "id", "tudo");
    gravadas.task_comment_mentions = await gravar(c, "task_comment_mentions", carga.mencoes, null, "nada");
    gravadas.task_comment_reactions = await gravar(c, "task_comment_reactions", carga.reacoes, null, "nada");
    gravadas.task_activity = await gravar(c, "task_activity", carga.historico, "id", "tudo");
    gravadas.task_attachments = await gravar(c, "task_attachments", linhasDeAnexo, "id", "nada");
    gravadas.task_saved_filters = await gravar(c, "task_saved_filters", carga.filtros, "id", "tudo");
    gravadas.api_keys = await gravar(c, "api_keys", carga.chaves, "id", "tudo");

    // Agenda: um link por pessoa; quem já criou o próprio link no Omni fica com o dele.
    const agendas: Record<string, unknown>[] = [];
    for (const a of carga.agendas) {
      const outro = await c.query("SELECT 1 FROM calendar_feeds WHERE person_id = $1 AND id <> $2", [a.person_id, a.id]);
      if (outro.rowCount) agendasEmConflito.push(String(a.id));
      else agendas.push(a);
    }
    gravadas.calendar_feeds = await gravar(c, "calendar_feeds", agendas, "id", "tudo");
    gravadas.email_preferences = await gravar(c, "email_preferences", carga.preferencias, "person_id", "nada");
    let vinculos = 0;
    for (const v of carga.vinculosFoco) {
      const r = await c.query("UPDATE people SET foco_user_id = $2 WHERE id = $1 AND foco_user_id IS DISTINCT FROM $2 AND NOT EXISTS (SELECT 1 FROM people o WHERE o.foco_user_id = $2 AND o.id <> $1)", [v.person_id, v.foco_user_id]);
      vinculos += r.rowCount ?? 0;
    }
    gravadas.people_foco_user_id = vinculos;

    // O que sumiu do Foco desde a carga anterior (só o que veio do Foco).
    const ids = (linhas: Record<string, unknown>[], col = "foco_id") => linhas.map((x) => x[col]).filter(Boolean) as string[];
    const remover = async (nome: string, texto: string, valores: unknown[]) => {
      removidas[nome] = (await c.query(texto, valores)).rowCount ?? 0;
    };
    await remover("task_comments", "DELETE FROM task_comments WHERE foco_id IS NOT NULL AND NOT (foco_id = ANY($1::uuid[]))", [ids(carga.comentarios)]);
    await remover("tasks", "DELETE FROM tasks WHERE foco_id IS NOT NULL AND NOT (foco_id = ANY($1::uuid[]))", [ids(carga.tarefas)]);
    await remover("task_sections", "DELETE FROM task_sections WHERE foco_id IS NOT NULL AND NOT (foco_id = ANY($1::uuid[]))", [ids(carga.secoes)]);
    await remover("task_saved_filters", "DELETE FROM task_saved_filters WHERE foco_id IS NOT NULL AND NOT (foco_id = ANY($1::uuid[]))", [ids(carga.filtros)]);
    await remover("task_attachments", "DELETE FROM task_attachments WHERE foco_id IS NOT NULL AND NOT (foco_id = ANY($1::uuid[]))", [carga.anexos.map((a) => a.focoId)]);
    await remover("api_keys (revogadas)", "UPDATE api_keys SET revoked_at = now() WHERE foco_id IS NOT NULL AND revoked_at IS NULL AND NOT (foco_id = ANY($1::uuid[]))", [ids(carga.chaves)]);
    await remover("calendar_feeds", "DELETE FROM calendar_feeds WHERE signed_subject <> person_id::text AND NOT (id = ANY($1::uuid[]))", [ids(carga.agendas, "id")]);
    const sumidos = await c.query<{ id: string; tem: boolean }>(
      "SELECT p.id, EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id AND t.foco_id IS NULL) AS tem FROM task_projects p WHERE p.foco_id IS NOT NULL AND NOT (p.foco_id = ANY($1::uuid[]))",
      [ids(carga.projetos)],
    );
    projetosMantidos.push(...sumidos.rows.filter((x) => x.tem).map((x) => x.id));
    await remover("task_projects", "DELETE FROM task_projects WHERE id = ANY($1::uuid[])", [sumidos.rows.filter((x) => !x.tem).map((x) => x.id)]);

    for (const t of COM_GATILHOS) await c.query(`ALTER TABLE ${t} ENABLE TRIGGER USER`);

    // Conferência: o que está no Omni com o id do Foco bate com o que devia ir.
    const contar = async (nome: string, tabela: string, valores: string[], col = "foco_id") => {
      const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${col} = ANY($1::uuid[])`, [valores]);
      conferencia[nome] = { esperado: new Set(valores).size, noOmni: r.rows[0]!.n };
    };
    await contar("projetos", "task_projects", ids(carga.projetos));
    await contar("seções", "task_sections", ids(carga.secoes));
    await contar("tarefas", "tasks", ids(carga.tarefas, "id"), "id");
    await contar("comentários", "task_comments", ids(carga.comentarios));
    await contar("histórico", "task_activity", ids(carga.historico));
    await contar("filtros salvos", "task_saved_filters", ids(carga.filtros));
    await contar("chaves de API", "api_keys", ids(carga.chaves));
    await contar("links de agenda", "calendar_feeds", ids(agendas, "id"), "id");
    if (op.real) await contar("anexos", "task_attachments", carga.anexos.filter((a) => !anexos.falharam.some((f) => f.focoId === a.focoId)).map((a) => a.focoId));

    await c.query(op.real ? "COMMIT" : "ROLLBACK");
  } catch (error) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    c.release();
  }
  let tokenConferido: string | null | undefined;
  if (op.conferirToken) {
    const h = `\\x${createHash("sha256").update(op.conferirToken.trim()).digest("hex")}`;
    tokenConferido = (carga.chaves.find((k) => k.key_hash === h)?.name as string | undefined) ?? null;
  }
  return { real: op.real, relatorio, gravadas, removidas, conferencia, anexos, agendasEmConflito, projetosMantidos, tokenConferido };
}

/** Relatório legível (sem conteúdo de tarefas: só contagens, e-mails das pessoas e nomes das chaves). */
export function relatorioEmTexto(r: ResultadoImportacao, carga?: Carga): string {
  const l: string[] = [];
  l.push(`# Migração do Foco — ${r.real ? "CARGA REAL" : "ENSAIO (nada foi gravado)"}`, "");
  l.push("## Lidas no Foco", ...Object.entries(r.relatorio.lidas).map(([t, n]) => `- ${t}: ${n}`), "");
  l.push("## Conferência no Omni (com o id do Foco)", ...Object.entries(r.conferencia).map(([t, c]) => `- ${t}: ${c.noOmni} de ${c.esperado}${c.noOmni === c.esperado ? "" : "  ⚠️ diferente"}`), "");
  l.push("## Gravadas", ...Object.entries(r.gravadas).map(([t, n]) => `- ${t}: ${n}`), "");
  if (Object.values(r.removidas).some(Boolean)) l.push("## Removidas (sumiram do Foco desde a carga anterior)", ...Object.entries(r.removidas).filter(([, n]) => n).map(([t, n]) => `- ${t}: ${n}`), "");
  l.push(
    "## Anexos",
    `- ${r.real ? `copiados ao SharePoint: ${r.anexos.copiados}` : `baixados e conferidos: ${r.anexos.conferidos}`}; já estavam no Omni: ${r.anexos.jaEstavam}`,
    ...r.anexos.falharam.map((f) => `- ⚠️ ${f.focoId}: ${f.motivo}`),
    "",
  );
  const semConta = r.relatorio.pessoas.filter((p) => p.situacao !== "casou");
  l.push(`## Pessoas (${r.relatorio.pessoas.length}; ${semConta.length} sem conta ativa no Omni)`, ...r.relatorio.pessoas.map((p) => `- ${p.email ?? `(sem e-mail) ${p.focoId}`}: ${p.situacao}${p.tarefas ? ` · ${p.tarefas} tarefas` : ""}`), "");
  if (r.relatorio.responsaveisSemConta.length) l.push("## Responsáveis sem conta no Omni (tarefas ficam sem responsável)", ...r.relatorio.responsaveisSemConta.map((x) => `- ${x.email}: ${x.tarefas}`), "");
  l.push("## Chaves de API que continuam valendo", ...r.relatorio.chaves.map((k) => `- ${k.nome} (${k.tipo}) · ${k.email ?? "?"} · último uso ${k.ultimoUso?.slice(0, 10) ?? "nunca"}`), "");
  if (r.tokenConferido !== undefined) l.push("## Chave de API conferida", r.tokenConferido ? `- ✅ continua valendo no Omni: "${r.tokenConferido}"` : "- ⚠️ não está entre as chaves que migram (revogada, vencida, de quem não tem conta no Omni ou deixada de fora)", "");
  if (r.agendasEmConflito.length) l.push("## Links de agenda não migrados (a pessoa já tem um link no Omni)", ...r.agendasEmConflito.map((x) => `- ${x}`), "");
  if (r.projetosMantidos.length) l.push("## Projetos que sumiram do Foco mas têm tarefas criadas no Omni (mantidos)", ...r.projetosMantidos.map((x) => `- ${x}`), "");
  l.push("## Avisos", ...Object.entries(r.relatorio.avisos).map(([t, a]) => `- ${t}: ${a.quantidade} (ex.: ${a.exemplos.join(", ")})`), "");
  if (carga) l.push(`Carga: ${carga.tarefas.length} tarefas, ${carga.projetos.length} projetos, ${carga.comentarios.length} comentários.`);
  return l.join("\n");
}
