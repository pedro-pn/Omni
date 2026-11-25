import { vincularEmail, type MissaoVinculavel } from "@omni/core";
import { schema, type Db } from "@omni/db";
import { GraphError, type GraphClient, type MensagemGraph } from "@omni/integrations/graph";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";

/**
 * E-mails da missão (Fase 4): lê as caixas cadastradas (`mail_mailboxes`) pelo
 * Graph, de forma incremental (delta) na Entrada e nos Enviados, e guarda só
 * os e-mails que se ligam a alguma missão — com cabeçalho, prévia e o motivo
 * do vínculo, sem o corpo (que é buscado no Graph quando alguém abre). Os
 * demais e-mails da caixa nem entram no banco do Omni.
 *
 * Caixa fora do grupo do Exchange ("Omni - Caixas") responde 403: fica com o
 * erro registrado e as outras seguem. Delta vencido (410) recomeça a janela.
 */

const FONTE = "graph";
export const DIAS_INICIAIS = 90;
const PASTAS = ["inbox", "sentitems"] as const;

export type FonteEmails = Pick<GraphClient, "mensagensDelta">;
export type ResultadoEmails = { caixas: number; lidos: number; guardados: number; removidos: number; erros: number };

/** Missões com o que serve para o vínculo: código, propostas, NFs e domínios do cliente. */
export async function missoesVinculaveis(db: Db): Promise<MissaoVinculavel[]> {
  const r = await db.execute<{ id: string; code: string; ativa: boolean; propostas: string[] | null; notas: string[] | null; dominios: string[] | null }>(sql`
    SELECT m.id, m.code, m.is_active AS ativa,
           array_remove(array_cat(
             ARRAY[m.commercial_proposal_code],
             coalesce((SELECT array_agg(x) FROM prisma_mission_links l
                         JOIN prisma_missions pm ON pm.id = l.prisma_mission_id
                         JOIN prisma_deals d ON d.id = ANY (pm.deal_ids) AND d.deleted_at IS NULL
                         CROSS JOIN LATERAL unnest(ARRAY[d.code, d.proposal_code]) x
                        WHERE l.mission_id = m.id), '{}')), NULL) AS propostas,
           (SELECT array_agg(i.numero) FROM mission_invoices i WHERE i.mission_id = m.id) AS notas,
           (SELECT array_agg(DISTINCT dom) FROM prisma_mission_links l
              JOIN prisma_missions pm ON pm.id = l.prisma_mission_id
              JOIN prisma_companies c ON c.id = ANY (pm.company_ids) AND c.deleted_at IS NULL
              CROSS JOIN LATERAL unnest(c.email_domains) dom
             WHERE l.mission_id = m.id) AS dominios
      FROM missions m`);
  return r.rows.map((x) => ({ id: x.id, code: x.code, ativa: x.ativa, propostas: x.propostas ?? [], notas: x.notas ?? [], dominios: x.dominios ?? [] }));
}

const destinatarios = (l: MensagemGraph["toRecipients"]) =>
  (l ?? [])
    .map((d) => ({ nome: d.emailAddress.name ?? null, endereco: (d.emailAddress.address ?? "").toLowerCase() }))
    .filter((d) => d.endereco);

/**
 * Caixa única (0067): o cabeçalho de todo e-mail da caixa PESSOAL vai para mail_items
 * (só o dono lê): remetente, destinatários, assunto, prévia, datas, lido. Sem o corpo.
 */
async function guardarCabecalho(db: Db, caixaId: string, dono: string, pasta: (typeof PASTAS)[number], m: MensagemGraph) {
  const para = destinatarios(m.toRecipients);
  const cc = destinatarios(m.ccRecipients);
  const de = m.from?.emailAddress.address?.toLowerCase() ?? null;
  const v = {
    ownerPersonId: dono,
    internetMessageId: m.internetMessageId ?? null,
    conversationId: m.conversationId ?? null,
    folder: pasta,
    fromName: m.from?.emailAddress.name ?? null,
    fromAddress: de,
    toRecipients: para,
    ccRecipients: cc,
    addresses: [...new Set([de, ...para.map((d) => d.endereco), ...cc.map((d) => d.endereco)].filter((x): x is string => Boolean(x)))],
    subject: m.subject ?? null,
    preview: (m.bodyPreview ?? "").slice(0, 300) || null,
    receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
    sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
    // Enviados são "lidos"; na Entrada, o que o Outlook diz.
    isRead: pasta === "sentitems" ? true : (m.isRead ?? true),
    hasAttachments: Boolean(m.hasAttachments),
  };
  await db
    .insert(schema.mailItems)
    .values({ mailboxId: caixaId, graphId: m.id, ...v })
    .onConflictDoUpdate({ target: [schema.mailItems.mailboxId, schema.mailItems.graphId], set: v });
}

/** Grava (ou atualiza) o e-mail se ele se liga a alguma missão; devolve se guardou. */
async function guardar(db: Db, caixaId: string, pasta: (typeof PASTAS)[number], m: MensagemGraph, missoes: MissaoVinculavel[]): Promise<boolean> {
  if (!m.internetMessageId) return false;
  const para = destinatarios(m.toRecipients);
  const cc = destinatarios(m.ccRecipients);
  const de = m.from?.emailAddress.address?.toLowerCase() ?? null;
  const excluidas = new Set(
    (
      await db
        .select({ missionId: schema.mailLinkExclusions.missionId })
        .from(schema.mailLinkExclusions)
        .where(eq(schema.mailLinkExclusions.internetMessageId, m.internetMessageId))
    ).map((x) => x.missionId),
  );
  // Pares desvinculados por alguém não voltam.
  const vinculos = vincularEmail(
    { assunto: m.subject ?? "", texto: m.body?.content ?? m.bodyPreview ?? "", enderecos: [de, ...para.map((d) => d.endereco), ...cc.map((d) => d.endereco)].filter((x): x is string => Boolean(x)) },
    missoes,
  ).filter((v) => !excluidas.has(v.missionId));
  if (!vinculos.length) return false;

  const t = schema.mailMessages;
  const v = {
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? null,
    fromName: m.from?.emailAddress.name ?? null,
    fromAddress: de,
    toRecipients: para,
    ccRecipients: cc,
    receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : null,
    sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
    bodyPreview: (m.bodyPreview ?? "").slice(0, 300) || null,
    hasAttachments: Boolean(m.hasAttachments),
  };
  const [linha] = await db
    .insert(t)
    .values({ internetMessageId: m.internetMessageId, ...v })
    .onConflictDoUpdate({ target: t.internetMessageId, set: v })
    .returning({ id: t.id });
  const messageId = linha!.id;
  await db
    .insert(schema.mailMessageCopies)
    .values({ mailboxId: caixaId, graphId: m.id, messageId, folder: pasta })
    .onConflictDoUpdate({ target: [schema.mailMessageCopies.mailboxId, schema.mailMessageCopies.graphId], set: { messageId, folder: pasta } });
  // Os motivos são do conteúdo: recalcula e troca.
  await db.delete(schema.mailMessageMissions).where(eq(schema.mailMessageMissions.messageId, messageId));
  await db.insert(schema.mailMessageMissions).values(vinculos.map((x) => ({ messageId, missionId: x.missionId, motivo: x.motivo, detalhe: x.detalhe })));
  return true;
}

/** Tira as cópias que sumiram da caixa e os e-mails que ficaram sem nenhuma cópia. */
async function remover(db: Db, caixaId: string, graphIds: string[]): Promise<number> {
  if (!graphIds.length) return 0;
  await db.delete(schema.mailItems).where(and(eq(schema.mailItems.mailboxId, caixaId), inArray(schema.mailItems.graphId, graphIds)));
  const c = schema.mailMessageCopies;
  const tiradas = await db
    .delete(c)
    .where(and(eq(c.mailboxId, caixaId), inArray(c.graphId, graphIds)))
    .returning({ messageId: c.messageId });
  if (!tiradas.length) return 0;
  const orfas = await db
    .delete(schema.mailMessages)
    .where(
      and(
        inArray(schema.mailMessages.id, tiradas.map((x) => x.messageId)),
        notExists(db.select({ x: sql`1` }).from(c).where(eq(c.messageId, schema.mailMessages.id))),
      ),
    )
    .returning({ id: schema.mailMessages.id });
  return orfas.length;
}

async function cursor(db: Db, recurso: string) {
  const [e] = await db
    .select({ cursor: schema.syncState.cursor })
    .from(schema.syncState)
    .where(and(eq(schema.syncState.source, FONTE), eq(schema.syncState.resource, recurso)));
  return e?.cursor ?? null;
}

async function salvarCursor(db: Db, recurso: string, valor: string | null, agora: Date) {
  await db
    .insert(schema.syncState)
    .values({ source: FONTE, resource: recurso, cursor: valor, lastSuccessAt: agora })
    .onConflictDoUpdate({ target: [schema.syncState.source, schema.syncState.resource], set: { cursor: valor, lastSuccessAt: agora } });
}

const mensagemDeErro = (e: GraphError) =>
  e.status === 403
    ? "Sem acesso a esta caixa: confira se ela está no grupo do Exchange \"Omni - Caixas\"."
    : e.status === 404
      ? "Caixa não encontrada no Microsoft 365."
      : `Microsoft 365 respondeu ${e.status}.`;

export async function syncEmails(db: Db, fonte: FonteEmails, opcoes: { now?: () => Date } = {}): Promise<ResultadoEmails> {
  const now = opcoes.now ?? (() => new Date());
  const r: ResultadoEmails = { caixas: 0, lidos: 0, guardados: 0, removidos: 0, erros: 0 };
  const caixas = await db.select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.active, true));
  if (!caixas.length) return r;
  const missoes = await missoesVinculaveis(db);
  const desde = new Date(now().getTime() - DIAS_INICIAIS * 86_400_000);
  // Dono de cada caixa pessoal (o e-mail é o de uma pessoa ativa); caixa de setor não tem.
  const donos = new Map(
    (
      await db.execute<{ caixa: string; pessoa: string }>(sql`
        SELECT b.id AS caixa, p.id AS pessoa FROM mail_mailboxes b JOIN people p ON lower(p.email) = lower(b.email) AND p.active`)
    ).rows.map((x) => [x.caixa, x.pessoa]),
  );

  for (const caixa of caixas) {
    r.caixas += 1;
    try {
      for (const pasta of PASTAS) {
        const recurso = `mail:${caixa.id}:${pasta}`;
        let link = await cursor(db, recurso);
        let pagina;
        try {
          pagina = await fonte.mensagensDelta(caixa.email, pasta, link, { desde });
        } catch (error) {
          // Delta vencido: recomeça a janela (as gravações são idempotentes).
          if (!(error instanceof GraphError && error.status === 410) || !link) throw error;
          link = null;
          pagina = await fonte.mensagensDelta(caixa.email, pasta, null, { desde });
        }
        r.lidos += pagina.mensagens.length;
        const dono = donos.get(caixa.id);
        for (const m of pagina.mensagens) {
          if (await guardar(db, caixa.id, pasta, m, missoes)) r.guardados += 1;
          if (dono) await guardarCabecalho(db, caixa.id, dono, pasta, m);
        }
        r.removidos += await remover(db, caixa.id, pagina.removidas);
        // O que sobrou da rodada (continuar) ou o marco para a próxima (deltaLink).
        await salvarCursor(db, recurso, pagina.continuar ?? pagina.deltaLink ?? link, now());
      }
      await db.update(schema.mailMailboxes).set({ lastSyncAt: now(), lastError: null }).where(eq(schema.mailMailboxes.id, caixa.id));
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      r.erros += 1;
      await db.update(schema.mailMailboxes).set({ lastError: mensagemDeErro(error) }).where(eq(schema.mailMailboxes.id, caixa.id));
    }
  }
  return r;
}
