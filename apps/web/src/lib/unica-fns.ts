import { telefoneCanonico } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";
import { lerCorrespondentes, type Correspondente } from "../server/correspondentes.ts";

export type { Correspondente };
import { exigirModulo } from "../server/modulos.ts";

/**
 * Caixa única (fase 2): WhatsApp e e-mail juntos por contato.
 * - correspondentes: com quem a pessoa trocou e-mails (da própria caixa, mail_items, 0067);
 * - agenda: a qual contato da agenda da empresa pertence cada telefone e e-mail;
 * - e-mails de um contato: os cabeçalhos para a linha do tempo;
 * - vincular: liga e-mail e telefone no mesmo contato (cria o contato se preciso).
 */

const DIAS = 90;

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}


/** Endereços com quem a pessoa trocou e-mails nos últimos 90 dias (recebidos: remetente; enviados: destinatários). */
export const correspondentesDeEmail = createServerFn({ method: "GET" }).handler(async (): Promise<Correspondente[]> => {
  const personId = await pessoa();
  // Sem o módulo de e-mail, a caixa única mostra só o WhatsApp.
  if (!(await exigirModulo(personId, "emails").then(() => true, () => false))) return [];
  return withPerson(getPool(), personId, (db) => lerCorrespondentes(db, DIAS));
});

export type ContatoDaAgenda = {
  id: string;
  nome: string;
  empresa: string | null;
  telefones: string[];
  emails: string[];
  /** Vínculo automático (pela assinatura do e-mail): a tela mostra de onde veio. */
  automaticos: string[];
  noPrisma: boolean;
};

/** Contatos da agenda que têm algum destes telefones ou e-mails (com todos os telefones e e-mails deles). */
export const agendaPara = createServerFn({ method: "POST" })
  .validator(z.object({ telefones: z.array(z.string().regex(/^\d{8,15}$/)).max(3000), emails: z.array(z.string().max(254)).max(3000) }))
  .handler(async ({ data }): Promise<ContatoDaAgenda[]> => {
    const personId = await pessoa();
    const valores = [...data.telefones, ...data.emails.map((e) => e.toLowerCase())];
    if (!valores.length) return [];
    return withPerson(getPool(), personId, async (db) => {
      const ids = (
        await db.selectDistinct({ id: schema.contactIdentities.contactId }).from(schema.contactIdentities).where(inArray(schema.contactIdentities.value, valores))
      ).map((x) => x.id);
      if (!ids.length) return [];
      const contatos = await db.select().from(schema.contacts).where(inArray(schema.contacts.id, ids));
      const ident = await db.select().from(schema.contactIdentities).where(inArray(schema.contactIdentities.contactId, ids));
      return contatos.map((c) => ({
        id: c.id,
        nome: c.name,
        empresa: c.company,
        telefones: ident.filter((i) => i.contactId === c.id && i.kind === "telefone").map((i) => i.value),
        emails: ident.filter((i) => i.contactId === c.id && i.kind === "email").map((i) => i.value),
        automaticos: ident.filter((i) => i.contactId === c.id && i.source === "assinatura").map((i) => i.value),
        noPrisma: Boolean(c.prismaContactId),
      }));
    });
  });

export type EmailDoContato = {
  id: string;
  graphId: string;
  pasta: "inbox" | "sentitems";
  de: string | null;
  deEndereco: string | null;
  para: string[];
  assunto: string | null;
  previa: string | null;
  em: string;
  lido: boolean;
  anexos: boolean;
};

/** Cabeçalhos dos e-mails da própria caixa com estes endereços (linha do tempo do contato). */
export const emailsDoContato = createServerFn({ method: "POST" })
  .validator(z.object({ enderecos: z.array(z.string().max(254)).min(1).max(20) }))
  .handler(async ({ data }): Promise<EmailDoContato[]> => {
    const personId = await pessoa();
    const enderecos = data.enderecos.map((e) => e.toLowerCase());
    const linhas = await withPerson(getPool(), personId, (db) =>
      db
        .select()
        .from(schema.mailItems)
        .where(sql`${schema.mailItems.addresses} && ${`{${enderecos.map((e) => `"${e.replace(/["\\]/g, "")}"`).join(",")}}`}::text[]`)
        .orderBy(sql`coalesce(${schema.mailItems.receivedAt}, ${schema.mailItems.sentAt}) DESC`)
        .limit(200),
    );
    return linhas.map((m) => ({
      id: m.id,
      graphId: m.graphId,
      pasta: m.folder,
      de: m.fromName ?? m.fromAddress,
      deEndereco: m.fromAddress,
      para: m.toRecipients.map((r) => r.nome || r.endereco),
      assunto: m.subject,
      previa: m.preview,
      em: (m.receivedAt ?? m.sentAt ?? m.createdAt).toISOString(),
      lido: m.isRead,
      anexos: m.hasAttachments,
    }));
  });

const EMAIL = z.email("E-mail inválido.").transform((e) => e.trim().toLowerCase());
const TELEFONE = z
  .string()
  .transform((t) => telefoneCanonico(t) ?? "")
  .pipe(z.string().regex(/^\d{11,15}$/, "Telefone inválido: use o DDD e o número."));

/**
 * Liga telefones e e-mails no mesmo contato da agenda. Sem `contatoId`, usa o contato
 * que já tiver algum deles ou cria um novo com o nome. Um e-mail ou telefone que já é
 * de OUTRO contato não muda de dono sem querer: devolve o erro com o nome.
 */
export const vincularContato = createServerFn({ method: "POST" })
  .validator(
    z.object({
      contatoId: z.uuid().optional(),
      nome: z.string().trim().min(1, "Informe o nome.").max(160),
      empresa: z.string().trim().max(160).optional(),
      emails: z.array(EMAIL).max(10).default([]),
      telefones: z.array(TELEFONE).max(10).default([]),
      /** Sugestão aceita ("Mesma pessoa?") ou vinda do Prisma; o resto é manual. */
      origem: z.enum(["manual", "sugestao", "prisma"]).default("manual"),
    }),
  )
  .handler(async ({ data }): Promise<{ contatoId: string }> => {
    const personId = await pessoa();
    if (!data.emails.length && !data.telefones.length) throw new ErroParaTela("Informe um e-mail ou um telefone.");
    return withPerson(getPool(), personId, async (db) => {
      const pedidos = [...data.emails.map((v) => ({ kind: "email" as const, value: v })), ...data.telefones.map((v) => ({ kind: "telefone" as const, value: v }))];
      const existentes = await db
        .select({ contactId: schema.contactIdentities.contactId, kind: schema.contactIdentities.kind, value: schema.contactIdentities.value, nome: schema.contacts.name })
        .from(schema.contactIdentities)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.contactIdentities.contactId))
        .where(inArray(schema.contactIdentities.value, pedidos.map((p) => p.value)));
      const donos = [...new Set(existentes.map((e) => e.contactId))];
      let contatoId = data.contatoId ?? donos[0];
      const conflito = existentes.find((e) => contatoId && e.contactId !== contatoId);
      if (conflito) throw new ErroParaTela(`${conflito.kind === "email" ? "O e-mail" : "O telefone"} ${conflito.value} já está no contato "${conflito.nome}".`);
      if (!contatoId) {
        const [c] = await db
          .insert(schema.contacts)
          .values({ name: data.nome, company: data.empresa || null, createdBy: personId })
          .returning({ id: schema.contacts.id });
        contatoId = c!.id;
      } else if (data.empresa) {
        await db.update(schema.contacts).set({ company: data.empresa, updatedAt: new Date() }).where(eq(schema.contacts.id, contatoId));
      }
      const novos = pedidos.filter((p) => !existentes.some((e) => e.kind === p.kind && e.value === p.value));
      if (novos.length) await db.insert(schema.contactIdentities).values(novos.map((p) => ({ contactId: contatoId!, kind: p.kind, value: p.value, source: data.origem, createdBy: personId })));
      return { contatoId: contatoId! };
    });
  });

/** Tira um e-mail ou telefone de um contato (o contato some quando fica sem nenhum). */
export const desvincularDoContato = createServerFn({ method: "POST" })
  .validator(z.object({ contatoId: z.uuid(), valor: z.string().min(3).max(254) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, async (db) => {
      await db.delete(schema.contactIdentities).where(and(eq(schema.contactIdentities.contactId, data.contatoId), eq(schema.contactIdentities.value, data.valor.toLowerCase())));
      const [resta] = await db.select({ id: schema.contactIdentities.id }).from(schema.contactIdentities).where(eq(schema.contactIdentities.contactId, data.contatoId)).limit(1);
      if (!resta) await db.delete(schema.contacts).where(eq(schema.contacts.id, data.contatoId));
    });
    return { ok: true };
  });

/** "Não é a mesma pessoa": some a sugestão de juntar este e-mail e este telefone (só para mim). */
export const recusarSugestao = createServerFn({ method: "POST" })
  .validator(z.object({ email: EMAIL, telefone: z.string().regex(/^\d{8,15}$/) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    await withPerson(getPool(), personId, (db) =>
      db.insert(schema.contactLinkDismissals).values({ personId, email: data.email, phone: data.telefone }).onConflictDoNothing(),
    );
    return { ok: true };
  });

export const sugestoesRecusadas = createServerFn({ method: "GET" }).handler(async (): Promise<string[]> => {
  const personId = await pessoa();
  const linhas = await withPerson(getPool(), personId, (db) => db.select().from(schema.contactLinkDismissals));
  return linhas.map((l) => `${l.email}|${l.phone}`);
});

export type TelefoneDosEmails = { telefone: string; origem: "assinatura" | "corpo"; celular: boolean; endereco: string; quando: string };
export type InfoDosEmails = { cargo: string | null; empresa: string | null; telefones: TelefoneDosEmails[] };

/**
 * O que os e-mails dizem do contato (0076): cargo e empresa da assinatura e os telefones
 * encontrados — o da assinatura (inclusive fixo, que não é vinculado sozinho) e os citados
 * no corpo —, menos os que já estão na agenda. Só de quem troca e-mails com a pessoa.
 */
export const telefonesDosEmails = createServerFn({ method: "POST" })
  .validator(z.object({ enderecos: z.array(z.string().max(254)).min(1).max(20) }))
  .handler(async ({ data }): Promise<InfoDosEmails> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      const linhas = (
        await db.execute<{ endereco: string; telefone: string | null; origem: "assinatura" | "corpo"; cargo: string | null; empresa: string | null; quando: string | Date }>(
          sql`SELECT * FROM app.telefones_do_correspondente(${`{${data.enderecos.map((e) => `"${e.toLowerCase().replace(/["\\]/g, "")}"`).join(",")}}`}::text[])`,
        )
      ).rows;
      const assinatura = linhas.find((l) => l.origem === "assinatura");
      const candidatos = new Map<string, TelefoneDosEmails>();
      for (const l of linhas) {
        const t = telefoneCanonico(l.telefone);
        if (!t || (candidatos.has(t) && candidatos.get(t)!.origem === "assinatura")) continue;
        candidatos.set(t, { telefone: t, origem: l.origem, celular: /^55[1-9][1-9]9\d{8}$/.test(t), endereco: l.endereco, quando: new Date(l.quando).toISOString() });
      }
      const ja = candidatos.size
        ? new Set(
            (await db.select({ v: schema.contactIdentities.value }).from(schema.contactIdentities).where(inArray(schema.contactIdentities.value, [...candidatos.keys()]))).map((x) => x.v),
          )
        : new Set<string>();
      return {
        cargo: assinatura?.cargo ?? null,
        empresa: assinatura?.empresa ?? null,
        telefones: [...candidatos.values()].filter((c) => !ja.has(c.telefone)),
      };
    });
  });

