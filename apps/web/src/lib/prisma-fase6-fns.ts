import { PrismaError, type PrismaClient } from "@omni/integrations/prisma";
import { schema, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { chaveDeterministica, clienteLeituraPrisma, clientePrismaDaPessoa, enderecoOmniParaPrisma } from "../server/prisma.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Fase 6 do Prisma (contrato 1.67.0):
 * - "No Prisma": quem é este e-mail/telefone (contato, empresa, oportunidades
 *   abertas, últimos feedbacks), pela credencial `reader`, só para quem vê dados
 *   comerciais (app.ve_comercial).
 * - Participante do cliente → contato no Prisma + vínculo com a missão.
 * - Ligação ou e-mail → feedback no Prisma.
 * As escritas usam o token da própria pessoa (autoria dela no Prisma) e chaves de
 * idempotência fixas: repetir não duplica. Terceiros ficam só no Omni.
 */

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

const MENSAGENS: Record<string, string> = {
  company_conflict: "Este contato já está ligado a outra empresa no Prisma. Peça a revisão no Prisma (incluir a empresa no contato) e tente de novo.",
  identity_ambiguous: "Há mais de um contato no Prisma com este e-mail ou telefone. Resolva a duplicidade no Prisma e tente de novo.",
  identity_requires_review: "O Prisma tem um contato parecido que precisa de conferência antes. Revise no Prisma e tente de novo.",
  unrelated_customer: "Esta pessoa não é de uma empresa do cliente desta missão no Prisma.",
  delegated_user_required: "Conecte sua conta do Prisma (menu do perfil) para registrar em seu nome.",
  environment_disabled: "A integração com o Prisma está desligada neste ambiente.",
  invalid_token: "Sua conexão com o Prisma expirou. Conecte de novo pelo menu do perfil.",
  forbidden: "Sua conta do Prisma não tem acesso a este registro.",
};

function paraTela(error: unknown): never {
  if (error instanceof ErroParaTela) throw error;
  if (error instanceof PrismaError) {
    const msg = (error.code && MENSAGENS[error.code]) ?? (error.status === 401 ? MENSAGENS.invalid_token : null);
    throw new ErroParaTela(msg ?? "O Prisma não aceitou agora. Tente de novo em instantes.");
  }
  throw error;
}

async function clienteDaPessoa(personId: string): Promise<PrismaClient> {
  const c = await clientePrismaDaPessoa(personId);
  if (!c) throw new ErroParaTela(MENSAGENS.delegated_user_required!);
  return c;
}

/** Escreve com a revisão atual; se outra escrita passou na frente, tenta mais uma vez. */
async function comRevisao<T>(c: PrismaClient, fn: (revisao: number) => Promise<T>): Promise<T> {
  try {
    return await fn(await c.revisao());
  } catch (error) {
    if (error instanceof PrismaError && error.code === "revision_conflict") return fn(await c.revisao());
    throw error;
  }
}

/** Telefone em E.164 a partir dos dígitos (Brasil por padrão); null se não der. */
export function telefoneE164(bruto: string | null | undefined): string | null {
  const d = (bruto ?? "").replace(/\D/g, "");
  if (/^55\d{10,11}$/.test(d)) return `+${d}`;
  if (/^\d{10,11}$/.test(d)) return `+55${d}`;
  if (/^[1-9]\d{9,14}$/.test(d) && (bruto ?? "").trim().startsWith("+")) return `+${d}`;
  return null;
}

// ---------------------------------------------------------------- No Prisma

export type NoPrisma = {
  podeVer: boolean;
  ambiguo: boolean;
  contatos: Array<{
    id: string;
    nome: string | null;
    cargo: string | null;
    empresa: string | null;
    oportunidades: Array<{ id: string; titulo: string | null }>;
    feedbacks: Array<{ id: string; texto: string; canal: string | null; quando: string | null; autor: string | null }>;
  }>;
};

export const noPrisma = createServerFn({ method: "GET" })
  .validator(z.object({ email: z.string().email().max(200).optional(), telefone: z.string().max(30).optional() }))
  .handler(async ({ data }): Promise<NoPrisma> => {
    const personId = await pessoa();
    const [r] = await withPerson(getPool(), personId, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.ve_comercial() AS ok`)).then((x) => x.rows);
    const leitor = clienteLeituraPrisma();
    const telefone = telefoneE164(data.telefone);
    if (!r?.ok || !leitor || (!data.email && !telefone)) return { podeVer: false, ambiguo: false, contatos: [] };
    try {
      const res = await leitor.lookup(data.email ? { email: data.email } : { phone: telefone! }, 5);
      return {
        podeVer: true,
        ambiguo: res.ambiguous,
        contatos: res.itens.map((i) => ({
          id: i.contact.id,
          nome: i.contact.name ?? null,
          cargo: i.contact.title ?? null,
          empresa: i.company?.name ?? null,
          oportunidades: i.openDeals.map((d) => ({ id: d.id, titulo: d.title ?? null })),
          feedbacks: i.feedback.map((f) => ({ id: f.id, texto: (f.text ?? "").slice(0, 400), canal: f.source ?? null, quando: f.occurredAt ?? null, autor: f.actorName ?? null })),
        })),
      };
    } catch (error) {
      return paraTela(error);
    }
  });

// ---------------------------------------------------------------- participantes do cliente

type EmpresaDaMissao = { prisma_mission_id: string; company_id: string | null; company_name: string | null; email_domains: string[] | null };

export const enviarParticipanteAoPrisma = createServerFn({ method: "POST" })
  .validator(
    z.object({
      missionId: z.uuid(),
      chave: z.string().regex(/^(email|wa):.{3,200}$/),
      nome: z.string().trim().min(2, "Complete o nome antes de enviar.").max(120),
      email: z.string().email().max(200).nullable(),
      telefone: z.string().max(30).nullable(),
      cargo: z.string().trim().max(120).nullable(),
    }),
  )
  .handler(async ({ data }): Promise<{ contatoId: string; criado: boolean }> => {
    const personId = await pessoa();
    // A chave tem de ser a do próprio participante (e-mail ou WhatsApp informado).
    if (data.chave.startsWith("email:") && data.chave.slice(6) !== data.email?.toLowerCase()) throw new ErroParaTela("Participante inválido.");
    const telefone = telefoneE164(data.telefone);
    if (!data.email && !telefone) throw new ErroParaTela("O participante precisa de e-mail ou telefone para ir ao Prisma.");
    const empresas = await withPerson(getPool(), personId, (db) =>
      db.execute<EmpresaDaMissao>(sql`SELECT * FROM app.prisma_da_missao(${data.missionId}::uuid)`).then((r) => r.rows),
    );
    const prismaMissao = empresas[0]?.prisma_mission_id;
    if (!prismaMissao) throw new ErroParaTela("Esta missão ainda não está ligada a uma missão do Prisma.");
    const comEmpresa = empresas.filter((e) => e.company_id);
    const dominio = data.email?.split("@")[1]?.toLowerCase();
    const empresa =
      comEmpresa.find((e) => dominio && (e.email_domains ?? []).some((d) => d.toLowerCase() === dominio)) ?? (comEmpresa.length === 1 ? comEmpresa[0] : undefined);
    if (!empresa?.company_id) throw new ErroParaTela("Não encontrei a empresa do cliente para esta pessoa no Prisma. Confira o domínio do e-mail na empresa, no Prisma.");
    const c = await clienteDaPessoa(personId);
    try {
      const contato = await comRevisao(c, (revisao) =>
        c.upsertContato(
          { name: data.nome, ...(data.email ? { email: data.email } : {}), ...(telefone ? { phone: telefone } : {}), ...(data.cargo ? { title: data.cargo } : {}), companyId: empresa.company_id! },
          { chave: chaveDeterministica(`contato:${data.missionId}:${data.chave}:${empresa.company_id}`), revisao },
        ),
      );
      await comRevisao(c, (revisao) =>
        c.vincularParticipante(prismaMissao, { contactId: contato.dados.id, companyId: empresa.company_id! }, { chave: chaveDeterministica(`participante:${prismaMissao}:${contato.dados.id}`), revisao }),
      );
      const valores = { prismaContactId: contato.dados.id, prismaVinculadoEm: new Date(), updatedBy: personId, updatedAt: new Date() };
      await withPerson(getPool(), personId, (db) =>
        db
          .insert(schema.missionParticipantNotes)
          .values({ missionId: data.missionId, chave: data.chave, ...valores })
          .onConflictDoUpdate({ target: [schema.missionParticipantNotes.missionId, schema.missionParticipantNotes.chave], set: valores }),
      );
      return { contatoId: contato.dados.id, criado: contato.dados.created };
    } catch (error) {
      return paraTela(error);
    }
  });

export const tirarParticipanteDoPrisma = createServerFn({ method: "POST" })
  .validator(z.object({ missionId: z.uuid(), chave: z.string().regex(/^(email|wa):.{3,200}$/) }))
  .handler(async ({ data }) => {
    const personId = await pessoa();
    const [nota] = await withPerson(getPool(), personId, (db) =>
      db.select().from(schema.missionParticipantNotes).where(and(eq(schema.missionParticipantNotes.missionId, data.missionId), eq(schema.missionParticipantNotes.chave, data.chave))),
    );
    if (!nota?.prismaContactId) throw new ErroParaTela("Este participante não foi enviado ao Prisma.");
    const empresas = await withPerson(getPool(), personId, (db) =>
      db.execute<EmpresaDaMissao>(sql`SELECT * FROM app.prisma_da_missao(${data.missionId}::uuid)`).then((r) => r.rows),
    );
    const prismaMissao = empresas[0]?.prisma_mission_id;
    if (!prismaMissao) throw new ErroParaTela("Esta missão não está ligada a uma missão do Prisma.");
    const c = await clienteDaPessoa(personId);
    try {
      await comRevisao(c, (revisao) =>
        c.removerParticipante(prismaMissao, nota.prismaContactId!, { chave: chaveDeterministica(`remover:${prismaMissao}:${nota.prismaContactId}:${nota.prismaVinculadoEm?.toISOString() ?? ""}`), revisao }),
      );
    } catch (error) {
      return paraTela(error);
    }
    await withPerson(getPool(), personId, (db) =>
      db
        .update(schema.missionParticipantNotes)
        .set({ prismaContactId: null, prismaVinculadoEm: null, updatedBy: personId, updatedAt: new Date() })
        .where(and(eq(schema.missionParticipantNotes.missionId, data.missionId), eq(schema.missionParticipantNotes.chave, data.chave))),
    );
    return { ok: true };
  });

// ---------------------------------------------------------------- feedback

/** Contato único no Prisma para o telefone ou e-mail; senão, explica o que fazer. */
async function contatoUnico(identidade: { email: string } | { phone: string }) {
  const leitor = clienteLeituraPrisma();
  if (!leitor) throw new ErroParaTela("A leitura do Prisma não está configurada neste ambiente.");
  const r = await leitor.lookup(identidade, 1);
  if (r.itens.length === 0) throw new ErroParaTela("Este contato ainda não está no Prisma. Envie-o pelos Participantes da missão (ou cadastre no Prisma) e tente de novo.");
  if (r.itens.length > 1 || r.ambiguous) throw new ErroParaTela(MENSAGENS.identity_ambiguous!);
  return r.itens[0]!;
}

const ITEM_FEEDBACK = z.discriminatedUnion("origem", [z.object({ origem: z.literal("chamada"), id: z.uuid() }), z.object({ origem: z.literal("email"), id: z.uuid(), missionId: z.uuid() })]);
type ItemFeedback = z.infer<typeof ITEM_FEEDBACK>;

export const registrarNoPrisma = createServerFn({ method: "POST" })
  .validator(ITEM_FEEDBACK)
  .handler(async ({ data }): Promise<{ ok: true; jaRegistrado: boolean }> => {
    const personId = await pessoa();
    return registrarUm(personId, data, () => clienteDaPessoa(personId));
  });

export type ResultadoDoLote = { id: string; situacao: "registrado" | "ja_registrado" | "erro"; mensagem: string | null };

/**
 * Registro em lote (Fase 6): várias ligações ou e-mails viram feedback no Prisma, um a
 * um, em nome de quem clicou; o que já estava registrado não duplica e o erro de um
 * não para os outros (menos a conexão com o Prisma, que para tudo).
 */
export const registrarNoPrismaEmLote = createServerFn({ method: "POST" })
  .validator(z.object({ itens: z.array(ITEM_FEEDBACK).min(1).max(50) }))
  .handler(async ({ data }): Promise<ResultadoDoLote[]> => {
    const personId = await pessoa();
    const c = await clienteDaPessoa(personId);
    const resultados: ResultadoDoLote[] = [];
    for (const item of data.itens) {
      try {
        const r = await registrarUm(personId, item, async () => c);
        resultados.push({ id: item.id, situacao: r.jaRegistrado ? "ja_registrado" : "registrado", mensagem: null });
      } catch (error) {
        const mensagem = error instanceof ErroParaTela ? error.message : "Não foi possível registrar.";
        if (mensagem === MENSAGENS.invalid_token || mensagem === MENSAGENS.delegated_user_required) throw error;
        resultados.push({ id: item.id, situacao: "erro", mensagem });
      }
    }
    return resultados;
  });

async function registrarUm(personId: string, data: ItemFeedback, cliente: () => Promise<PrismaClient>): Promise<{ ok: true; jaRegistrado: boolean }> {
  const chave = chaveDeterministica(`feedback:${personId}:${data.origem}:${data.id}`);
  const [ja] = await withPerson(getPool(), personId, (db) => db.select().from(schema.prismaFeedbackLog).where(eq(schema.prismaFeedbackLog.chave, chave)));
  if (ja) return { ok: true, jaRegistrado: true };

  let feedback: { text: string; source: "call" | "email"; occurredAt: string; sourceUrl: string; identidade: { email: string } | { phone: string } };
  if (data.origem === "chamada") {
    const [ch] = await withPerson(getPool(), personId, (db) => db.select().from(schema.whatsappCalls).where(eq(schema.whatsappCalls.id, data.id)));
    if (!ch || ch.ownerPersonId !== personId) throw new ErroParaTela("Só quem fez ou recebeu a ligação registra no Prisma.");
    if (!ch.startedAt) throw new ErroParaTela("A ligação não foi atendida: nada para registrar.");
    const minutos = ch.endedAt ? Math.max(1, Math.round((ch.endedAt.getTime() - ch.startedAt.getTime()) / 60_000)) : null;
    const s = ch.summary;
    const partes = [
      `Ligação pelo WhatsApp ${ch.direction === "entrada" ? "recebida" : "feita"}${minutos ? ` (${minutos} min)` : ""}.`,
      s ? `Resumo: ${s.resumo}` : "",
      s?.decisoes.length ? `Combinado:\n${s.decisoes.map((d) => `• ${d}`).join("\n")}` : "",
      s?.pendencias.length ? `Pendências:\n${s.pendencias.map((p) => `• ${p.descricao}${p.prazo ? ` (${p.prazo})` : ""}`).join("\n")}` : "",
    ];
    feedback = { text: partes.filter(Boolean).join("\n\n"), source: "call", occurredAt: ch.startedAt.toISOString(), sourceUrl: enderecoOmniParaPrisma("/?chamadas=1"), identidade: { phone: `+${ch.peer}` } };
  } else {
    const linhas = await withPerson(getPool(), personId, async (db) => {
      const [acesso] = (await db.execute<{ ok: boolean }>(sql`SELECT app.ve_emails() AS ok`)).rows;
      if (!acesso?.ok) return [];
      return (
        await db.execute<{ id: string; subject: string | null; from_name: string | null; from_address: string | null; to_recipients: { nome: string | null; endereco: string }[]; received_at: string | Date | null; body_preview: string | null }>(
          sql`SELECT id, subject, from_name, from_address, to_recipients, received_at, body_preview FROM app.emails_da_missao(${data.missionId}::uuid) WHERE id = ${data.id}::uuid`,
        )
      ).rows;
    });
    const e = linhas[0];
    if (!e) throw new ErroParaTela("E-mail não encontrado.");
    const externo = [e.from_address, ...(e.to_recipients ?? []).map((r) => r.endereco)].find((a) => a && !/@filtrovali\.com\.br$/i.test(a));
    if (!externo) throw new ErroParaTela("Este e-mail é só entre pessoas da Filtrovali: nada para registrar no Prisma.");
    feedback = {
      text: [`E-mail: ${e.subject?.trim() || "(sem assunto)"}`, `De: ${e.from_name ? `${e.from_name} <${e.from_address}>` : (e.from_address ?? "")}`, e.body_preview ? `\n${e.body_preview}` : ""].filter(Boolean).join("\n"),
      source: "email",
      occurredAt: new Date(e.received_at ?? Date.now()).toISOString(),
      sourceUrl: enderecoOmniParaPrisma(`/?missao=${data.missionId}&aba=emails`),
      identidade: { email: externo.toLowerCase() },
    };
  }

  const c = await cliente();
  try {
    const contato = await contatoUnico(feedback.identidade);
    const r = await comRevisao(c, (revisao) =>
      c.registrarFeedback(
        { text: feedback.text.slice(0, 4500), kind: "activity", source: feedback.source, occurredAt: feedback.occurredAt, sourceUrl: feedback.sourceUrl, contactId: contato.contact.id, ...(contato.company ? { companyId: contato.company.id } : {}) },
        { chave, revisao },
      ),
    );
    await withPerson(getPool(), personId, (db) =>
      db.insert(schema.prismaFeedbackLog).values({ chave, personId, origem: data.origem, origemId: data.id, prismaId: r.dados.id }).onConflictDoNothing(),
    );
    return { ok: true, jaRegistrado: false };
  } catch (error) {
    return paraTela(error);
  }
}

// ---------------------------------------------------------------- caixa única (0068)

/**
 * O que o Prisma sabe deste e-mail ou telefone (e-mails e telefones do contato), para
 * sugerir o vínculo na agenda da empresa. Só para quem vê dados comerciais; um contato
 * só (ambíguo não sugere nada).
 */
export const identidadesNoPrisma = createServerFn({ method: "GET" })
  .validator(z.object({ email: z.string().email().max(200).optional(), telefone: z.string().max(30).optional() }))
  .handler(async ({ data }): Promise<{ podeVer: boolean; contato: { nome: string | null; empresa: string | null; emails: string[]; telefones: string[] } | null }> => {
    const personId = await pessoa();
    const [r] = await withPerson(getPool(), personId, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.ve_comercial() AS ok`)).then((x) => x.rows);
    const leitor = clienteLeituraPrisma();
    const telefone = telefoneE164(data.telefone);
    if (!r?.ok || !leitor) return { podeVer: false, contato: null };
    if (!data.email && !telefone) return { podeVer: true, contato: null };
    try {
      const res = await leitor.lookup(data.email ? { email: data.email } : { phone: telefone! }, 0);
      const [i] = res.itens;
      if (res.ambiguous || res.itens.length !== 1 || !i) return { podeVer: true, contato: null };
      return {
        podeVer: true,
        contato: {
          nome: i.contact.name ?? null,
          empresa: i.company?.name ?? null,
          emails: (i.contact.emails ?? []).map((e) => e.toLowerCase()),
          telefones: (i.contact.phones ?? []).filter(Boolean),
        },
      };
    } catch {
      return { podeVer: true, contato: null }; // sugestão: sem o Prisma, só não sugere
    }
  });

/**
 * Contato da agenda → contato no Prisma, na empresa do cliente achada pelo domínio do
 * e-mail (em nome de quem clicou). Terceiros e quem não é de empresa do Prisma ficam só no Omni.
 */
export const enviarContatoAoPrisma = createServerFn({ method: "POST" })
  .validator(z.object({ contatoId: z.uuid() }))
  .handler(async ({ data }): Promise<{ prismaId: string; empresa: string | null }> => {
    const personId = await pessoa();
    const dados = await withPerson(getPool(), personId, async (db) => {
      const [c] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, data.contatoId));
      if (!c) throw new ErroParaTela("Contato não encontrado.");
      const ids = await db.select().from(schema.contactIdentities).where(eq(schema.contactIdentities.contactId, c.id));
      const emails = ids.filter((i) => i.kind === "email").map((i) => i.value);
      let empresa: { company_id: string; company_name: string | null } | undefined;
      for (const e of emails) {
        const achadas = (await db.execute<{ company_id: string; company_name: string | null }>(sql`SELECT * FROM app.empresas_prisma_do_dominio(${e.split("@")[1] ?? ""})`)).rows;
        if (achadas.length === 1) {
          empresa = achadas[0];
          break;
        }
      }
      return { c, email: emails[0], telefone: ids.find((i) => i.kind === "telefone")?.value ?? null, empresa };
    });
    if (!dados.empresa) throw new ErroParaTela("Não achei a empresa deste contato no Prisma pelo domínio do e-mail. Confira o domínio na empresa, no Prisma.");
    const c = await clienteDaPessoa(personId);
    const telefone = telefoneE164(dados.telefone);
    try {
      const contato = await comRevisao(c, (revisao) =>
        c.upsertContato(
          {
            name: dados.c.name,
            ...(dados.email ? { email: dados.email } : {}),
            ...(telefone ? { phone: telefone } : {}),
            ...(dados.c.role ? { title: dados.c.role } : {}),
            companyId: dados.empresa!.company_id,
          },
          { chave: chaveDeterministica(`agenda:${dados.c.id}:${dados.empresa!.company_id}`), revisao },
        ),
      );
      await withPerson(getPool(), personId, (db) =>
        db.update(schema.contacts).set({ prismaContactId: contato.dados.id, company: dados.c.company ?? dados.empresa!.company_name, updatedAt: new Date() }).where(eq(schema.contacts.id, dados.c.id)),
      );
      return { prismaId: contato.dados.id, empresa: dados.empresa.company_name };
    } catch (error) {
      return paraTela(error);
    }
  });
