import { schema, type Db } from "@omni/db";
import { and, desc, eq, sql } from "drizzle-orm";
import pg from "pg";

import { enviarPush, type Enviador } from "./enviar.ts";

/**
 * Transforma os avisos que o banco já emite em notificações:
 *   omni_avisos    → o aviso do sino (tarefas, alertas e perguntas da IA, teste) para a pessoa;
 *   omni_mensagens → mensagem nova no Interno/Gerencial para quem acompanha o canal (menos o autor);
 *   omni_whatsapp  → mensagem recebida no WhatsApp para quem acompanha o número.
 *   omni_email     → e-mail novo na caixa pessoal (0067), só para o dono.
 * A mesma `tag` por missão/canal faz a notificação nova substituir a anterior no aparelho.
 */

const CANAL = { interno: "Interno", gerencial: "Gerencial" } as const;

export async function aoAviso(db: Db, enviar: Enviador, id: string) {
  const [n] = await db.select().from(schema.notifications).where(eq(schema.notifications.id, id));
  if (!n) return null;
  const url = n.kind === "chamada_perdida" ? "/?chamadas=1" : n.kind === "risco" ? "/admin?aba=seguranca" : n.taskId ? `/?tarefa=${n.taskId}` : n.missionId ? `/?missao=${n.missionId}&aba=interno` : "/";
  return enviarPush(db, enviar, [n.personId], "aviso", { titulo: n.title, corpo: n.body || n.title, url, tag: n.missionId ? `missao-${n.missionId}-interno` : `aviso-${n.id}` });
}

export async function aoMensagemDeCanal(db: Db, enviar: Enviador, aviso: { missionId: string; channel: "interno" | "gerencial"; id: string }) {
  const [m] = await db
    .select({ body: schema.missionMessages.body, kind: schema.missionMessages.kind, autorId: schema.missionMessages.authorPersonId, autor: schema.people.displayName, code: schema.missions.code })
    .from(schema.missionMessages)
    .innerJoin(schema.missions, eq(schema.missions.id, schema.missionMessages.missionId))
    .leftJoin(schema.people, eq(schema.people.id, schema.missionMessages.authorPersonId))
    .where(eq(schema.missionMessages.id, aviso.id));
  if (!m || m.kind === "sistema") return null;
  const pessoas = (await db.execute<{ id: string }>(sql`SELECT app.destinatarios_canal(${aviso.missionId}::uuid, ${aviso.channel}) AS id`)).rows
    .map((r) => r.id)
    .filter((p) => p !== m.autorId);
  const quem = m.autor ? m.autor.split(" ")[0] : "Assistente";
  return enviarPush(db, enviar, pessoas, "canal", {
    titulo: `Missão ${m.code} · ${CANAL[aviso.channel]}`,
    corpo: `${quem}: ${m.body.replace(/\s+/g, " ")}`,
    url: `/?missao=${aviso.missionId}&aba=${aviso.channel}`,
    tag: `missao-${aviso.missionId}-${aviso.channel}`,
  });
}

export async function aoWhatsApp(db: Db, enviar: Enviador, aviso: { chatId: string }) {
  const [m] = await db
    .select({ m: schema.whatsappMessages, nome: schema.whatsappChats.name, grupo: schema.whatsappChats.isGroup, telefone: schema.whatsappChats.phone })
    .from(schema.whatsappMessages)
    .innerJoin(schema.whatsappChats, eq(schema.whatsappChats.id, schema.whatsappMessages.chatId))
    .where(and(eq(schema.whatsappMessages.chatId, aviso.chatId)))
    .orderBy(desc(schema.whatsappMessages.createdAt))
    .limit(1);
  // Só o que acabou de chegar de outra pessoa (a importação do histórico e as minhas não avisam).
  if (!m || m.m.fromMe || Date.now() - m.m.createdAt.getTime() > 120_000 || Date.now() - m.m.sentAt.getTime() > 30 * 60_000) return null;
  const pessoas = (await db.execute<{ id: string }>(sql`SELECT app.destinatarios_whatsapp(${aviso.chatId}::uuid) AS id`)).rows.map((r) => r.id);
  const previa = m.m.body ?? (m.m.kind === "documento" && m.m.fileName ? `[arquivo] ${m.m.fileName}` : `[${m.m.kind}]`);
  return enviarPush(db, enviar, pessoas, "whatsapp", {
    titulo: m.nome ?? (m.grupo ? "Grupo do WhatsApp" : (m.telefone ?? "WhatsApp")),
    corpo: m.grupo && m.m.authorName ? `${m.m.authorName.split(" ")[0]}: ${previa}` : previa,
    url: `/?conversa=${aviso.chatId}`,
    tag: `whatsapp-${aviso.chatId}`,
  });
}

/** E-mail novo na caixa pessoal (0067): só o dono, como o WhatsApp. */
export async function aoEmail(db: Db, enviar: Enviador, aviso: { personId: string; itemId: string }) {
  const [e] = await db
    .select({ de: schema.mailItems.fromName, endereco: schema.mailItems.fromAddress, assunto: schema.mailItems.subject, previa: schema.mailItems.preview, dono: schema.mailItems.ownerPersonId })
    .from(schema.mailItems)
    .where(eq(schema.mailItems.id, aviso.itemId));
  if (!e || e.dono !== aviso.personId) return null;
  return enviarPush(db, enviar, [e.dono], "email", {
    titulo: e.de || e.endereco || "E-mail novo",
    corpo: e.assunto ? `${e.assunto}${e.previa ? ` — ${e.previa}` : ""}` : (e.previa ?? "(sem assunto)"),
    url: `/?email=${aviso.itemId}`,
    tag: `email-${aviso.itemId}`,
  });
}

/** Conexão dedicada que escuta os avisos e dispara as notificações (reconecta sozinha). */
export function ouvirEventosDePush(url: string, db: Db, enviar: Enviador, log: (msg: string) => void): () => Promise<void> {
  let client: pg.Client | null = null;
  let parado = false;
  const conectar = async () => {
    if (parado) return;
    client = new pg.Client({ connectionString: url, application_name: "omni-worker-push" });
    client.on("notification", (msg) => {
      if (!msg.payload) return;
      let dados: Record<string, string>;
      try {
        dados = JSON.parse(msg.payload) as Record<string, string>;
      } catch {
        return;
      }
      const tarefa =
        msg.channel === "omni_avisos" && dados.id
          ? aoAviso(db, enviar, dados.id)
          : msg.channel === "omni_mensagens" && dados.missionId && dados.id
            ? aoMensagemDeCanal(db, enviar, dados as { missionId: string; channel: "interno" | "gerencial"; id: string })
            : // Mudança de status (entregue/lida, 0061) só atualiza a tela; não vira notificação.
              msg.channel === "omni_whatsapp" && dados.chatId && !dados.status
              ? aoWhatsApp(db, enviar, { chatId: dados.chatId })
              : msg.channel === "omni_email" && dados.personId && dados.itemId
                ? aoEmail(db, enviar, { personId: dados.personId, itemId: dados.itemId })
                : null;
      void tarefa?.catch((error: unknown) => log(`[push] falhou: ${(error as Error).name}`));
    });
    client.on("error", () => {
      log("[push] conexão caiu; reconectando em 5 s");
      client = null;
      setTimeout(() => void conectar(), 5000);
    });
    try {
      await client.connect();
      for (const canal of ["omni_avisos", "omni_mensagens", "omni_whatsapp", "omni_email"]) await client.query(`LISTEN ${canal}`);
    } catch {
      client = null;
      setTimeout(() => void conectar(), 5000);
    }
  };
  void conectar();
  return async () => {
    parado = true;
    await client?.end().catch(() => {});
  };
}
