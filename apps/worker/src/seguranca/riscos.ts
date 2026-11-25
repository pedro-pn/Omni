import { avaliarRiscos, enderecoDeFora, type UsoDaPessoa } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { sql } from "drizzle-orm";

/**
 * Job `riscos` (a cada 10 min; Fase 11): soma, por pessoa, os downloads registrados
 * (audit_log "arquivo.baixado") e os arquivos enviados para fora da empresa (e-mails
 * com anexo para outro domínio e arquivos pelo WhatsApp, só envios reais); passa
 * pelas regras de packages/core/src/riscos.ts; grava um alerta por pessoa, tipo e
 * hora (risk_alerts, sem repetir) e avisa no sino quem tem perfil admin ou diretoria.
 */

export type ResultadoRiscos = { pessoasAvaliadas: number; alertas: number; avisos: number };

export async function vigiarRiscos(db: Db, agora = new Date()): Promise<ResultadoRiscos> {
  const hora = new Date(agora.getTime() - 3_600_000);
  const dia = new Date(agora.getTime() - 24 * 3_600_000);
  const usos = new Map<string, UsoDaPessoa>();
  const uso = (personId: string) => {
    let u = usos.get(personId);
    if (!u) usos.set(personId, (u = { personId, downloadsHora: 0, downloadsDia: 0, origensDownload: {}, enviosHora: 0, bytesEnviadosHora: 0 }));
    return u;
  };

  // Downloads: arquivos diferentes (origem + id) na hora e no dia.
  const downloads = (
    await db.execute<{ pessoa: string; origem: string; hora: number; dia: number }>(sql`
      SELECT actor_person_id AS pessoa, entity_type AS origem,
             count(DISTINCT entity_id) FILTER (WHERE at >= ${hora})::int AS hora,
             count(DISTINCT entity_id)::int AS dia
        FROM audit_log
       WHERE action = 'arquivo.baixado' AND at >= ${dia} AND actor_person_id IS NOT NULL
       GROUP BY 1, 2`)
  ).rows;
  for (const d of downloads) {
    const u = uso(d.pessoa);
    u.downloadsHora += d.hora;
    u.downloadsDia += d.dia;
    if (d.hora) u.origensDownload[d.origem] = d.hora;
  }

  // E-mails com anexo para fora da empresa (domínio que não é o de ninguém do Omni).
  const dominios = new Set(
    (await db.execute<{ d: string }>(sql`SELECT DISTINCT lower(split_part(email, '@', 2)) AS d FROM people WHERE active AND email NOT LIKE '%.invalid'`)).rows.map((r) => r.d),
  );
  const emails = (
    await db.execute<{ pessoa: string; para: string[]; cc: string[]; cco: string[]; anexos: { tamanho?: number }[] }>(sql`
      SELECT person_id AS pessoa, to_recipients AS para, cc_recipients AS cc, bcc_recipients AS cco, attachments AS anexos
        FROM mail_outbox
       WHERE created_at >= ${hora} AND mode = 'real' AND status <> 'falhou' AND jsonb_array_length(attachments) > 0`)
  ).rows;
  for (const e of emails) {
    if (![...e.para, ...e.cc, ...e.cco].some((x) => enderecoDeFora(x, dominios))) continue;
    const u = uso(e.pessoa);
    u.enviosHora += e.anexos.length;
    u.bytesEnviadosHora += e.anexos.reduce((t, a) => t + (a.tamanho ?? 0), 0);
  }

  // Arquivos pelo WhatsApp (sempre para fora).
  const whatsapp = (
    await db.execute<{ pessoa: string; n: number; bytes: number }>(sql`
      SELECT person_id AS pessoa, count(*)::int AS n, coalesce(sum(file_size), 0)::bigint AS bytes
        FROM whatsapp_outbox
       WHERE created_at >= ${hora} AND mode = 'real' AND status <> 'erro' AND file_size IS NOT NULL
       GROUP BY 1`)
  ).rows;
  for (const w of whatsapp) {
    const u = uso(w.pessoa);
    u.enviosHora += w.n;
    u.bytesEnviadosHora += Number(w.bytes);
  }

  const r: ResultadoRiscos = { pessoasAvaliadas: usos.size, alertas: 0, avisos: 0 };
  const alertas = avaliarRiscos([...usos.values()]);
  if (!alertas.length) return r;
  const janela = new Date(Math.floor(agora.getTime() / 3_600_000) * 3_600_000);
  const quemAdministra = (
    await db.execute<{ id: string }>(sql`
      SELECT DISTINCT p.id FROM people p JOIN person_profiles pp ON pp.person_id = p.id
       WHERE p.active AND pp.profile IN ('admin', 'diretoria')`)
  ).rows.map((x) => x.id);
  for (const a of alertas) {
    const [novo] = await db
      .insert(schema.riskAlerts)
      .values({ kind: a.tipo, personId: a.personId, windowStart: janela, reason: a.motivo, details: a.detalhes })
      .onConflictDoNothing()
      .returning({ id: schema.riskAlerts.id });
    if (!novo) continue; // já avisado nesta hora
    r.alertas += 1;
    const [quem] = (await db.execute<{ nome: string }>(sql`SELECT display_name AS nome FROM people WHERE id = ${a.personId}::uuid`)).rows;
    const titulo = `${a.tipo === "downloads_em_massa" ? "Download em massa" : "Envio de arquivos para fora"}: ${quem?.nome ?? "pessoa do Omni"}`;
    for (const destino of quemAdministra) {
      const feito = await db
        .insert(schema.notifications)
        .values({ personId: destino, kind: "risco", title: titulo, body: a.motivo, dedupeKey: `risco:${novo.id}:${destino}` })
        .onConflictDoNothing()
        .returning({ id: schema.notifications.id });
      r.avisos += feito.length;
    }
  }
  return r;
}
