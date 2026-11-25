import { nationalHolidays, PERFIS, type PerfilCodigo, TERMOS } from "@omni/core";
import { novoTokenDeLink, schema, type Db } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";

import { AdminError, auditar, comoAdministrador } from "../server/admin.ts";
import { enderecoDoLink } from "../server/email-sistema.ts";

/**
 * Administração: perfis, funções da empresa, feriados e caixas de e-mail.
 * As permissões valem no banco (RLS, migration 0001); aqui só ficam as travas
 * que o banco não expressa (não se tirar o próprio admin, sempre um admin ativo)
 * e o registro na auditoria.
 */

const PERFIL_CODIGOS = Object.keys(PERFIS) as [PerfilCodigo, ...PerfilCodigo[]];
const perfilSchema = z.enum(PERFIL_CODIGOS);
const dataSchema = z.iso.date();

const hojeSaoPaulo = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

// ---------------------------------------------------------------- pessoas

export type PessoaAdmin = {
  id: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  active: boolean;
  lastLoginAt: string | null;
  perfis: PerfilCodigo[];
  /** Pelo Entra (app "Omni"): atribuída, fora do app, ou null (não veio do Entra). */
  entra: "atribuida" | "fora" | null;
  /** Quem desativou: o Entra (saiu do app) ou a Administração. */
  inativoPor: "entra" | "admin" | null;
  /** Quando aceitou a versão atual do termo de uso (0051); null = ainda não aceitou. */
  termoAceitoEm: string | null;
  /** Pode gravar as próprias ligações do WhatsApp (permissão da pessoa, 0032). */
  podeGravar: boolean;
  /** Login interno (0078). null = conta Microsoft. */
  interno: { login: string; temSenha: boolean; linkValeAte: string | null; bloqueadaAte: string | null; temEmailRecuperacao: boolean } | null;
};

export const listPessoas = createServerFn({ method: "GET" }).handler(async (): Promise<PessoaAdmin[]> =>
  comoAdministrador(async (db) => {
    const pessoas = await db.select().from(schema.people).orderBy(asc(schema.people.displayName));
    const perfis = await db.select().from(schema.personProfiles);
    const gravam = new Set((await db.select().from(schema.whatsappCallPermissions).where(eq(schema.whatsappCallPermissions.canRecord, true))).map((g) => g.personId));
    const aceites = new Map(
      (await db.select().from(schema.termsAcceptances).where(eq(schema.termsAcceptances.versao, TERMOS.versao))).map((a) => [a.personId, a.aceitoEm.toISOString()]),
    );
    const internos = new Map(
      (
        await db.execute<{ person_id: string; login: string; tem_senha: boolean; link_vale_ate: string | Date | null; locked_until: string | Date | null; tem_email_recuperacao: boolean }>(
          sql`SELECT * FROM app.logins_internos()`,
        )
      ).rows.map((x) => [
        x.person_id,
        {
          login: x.login,
          temSenha: x.tem_senha,
          linkValeAte: x.link_vale_ate ? new Date(x.link_vale_ate).toISOString() : null,
          bloqueadaAte: x.locked_until && new Date(x.locked_until) > new Date() ? new Date(x.locked_until).toISOString() : null,
          temEmailRecuperacao: x.tem_email_recuperacao,
        },
      ]),
    );
    const porPessoa = new Map<string, PerfilCodigo[]>();
    for (const p of perfis) porPessoa.set(p.personId, [...(porPessoa.get(p.personId) ?? []), p.profile]);
    return pessoas.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      email: p.email,
      jobTitle: p.jobTitle,
      active: p.active,
      lastLoginAt: p.lastLoginAt?.toISOString() ?? null,
      perfis: porPessoa.get(p.id) ?? [],
      entra: p.entraAtribuido === null ? null : p.entraAtribuido ? "atribuida" : "fora",
      inativoPor: p.active ? null : p.inativoPor,
      termoAceitoEm: aceites.get(p.id) ?? null,
      podeGravar: gravam.has(p.id),
      interno: internos.get(p.id) ?? null,
    }));
  }),
);

async function adminsAtivos(db: Db): Promise<string[]> {
  const rows = await db
    .select({ id: schema.people.id })
    .from(schema.personProfiles)
    .innerJoin(schema.people, eq(schema.people.id, schema.personProfiles.personId))
    .where(and(eq(schema.personProfiles.profile, "admin"), eq(schema.people.active, true)));
  return rows.map((r) => r.id);
}

export const definirPerfis = createServerFn({ method: "POST" })
  .validator(z.object({ personId: z.uuid(), perfis: z.array(perfilSchema).max(PERFIL_CODIGOS.length) }))
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const atuais = (
        await db.select().from(schema.personProfiles).where(eq(schema.personProfiles.personId, data.personId))
      ).map((p) => p.profile);
      const novos = new Set(data.perfis);
      const conceder = [...novos].filter((p) => !atuais.includes(p));
      const retirar = atuais.filter((p) => !novos.has(p));

      if (retirar.includes("admin")) {
        if (data.personId === meuId) throw new AdminError("Você não pode retirar o seu próprio perfil de administração.");
        const restantes = (await adminsAtivos(db)).filter((id) => id !== data.personId);
        if (restantes.length === 0) throw new AdminError("O Omni precisa de pelo menos uma pessoa com perfil de administração.");
      }

      if (retirar.length) {
        await db
          .delete(schema.personProfiles)
          .where(and(eq(schema.personProfiles.personId, data.personId), inArray(schema.personProfiles.profile, retirar)));
      }
      if (conceder.length) {
        await db
          .insert(schema.personProfiles)
          .values(conceder.map((profile) => ({ personId: data.personId, profile, grantedBy: meuId })));
      }
      for (const p of conceder) await auditar(db, meuId, "perfil.concedido", "person", data.personId, { perfil: p });
      for (const p of retirar) await auditar(db, meuId, "perfil.retirado", "person", data.personId, { perfil: p });
      return { concedidos: conceder, retirados: retirar };
    }),
  );

export const definirAtivo = createServerFn({ method: "POST" })
  .validator(z.object({ personId: z.uuid(), active: z.boolean() }))
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      if (!data.active) {
        if (data.personId === meuId) throw new AdminError("Você não pode desativar a sua própria conta.");
        const restantes = (await adminsAtivos(db)).filter((id) => id !== data.personId);
        if (restantes.length === 0) throw new AdminError("Esta é a última pessoa com perfil de administração ativa.");
      }
      const alteradas = await db
        .update(schema.people)
        // Desativada pela Administração: o Entra não reativa sozinho.
        .set({ active: data.active, inativoPor: data.active ? null : "admin" })
        .where(eq(schema.people.id, data.personId))
        .returning({ id: schema.people.id });
      if (alteradas.length === 0) throw new AdminError("Você não tem permissão para essa alteração.");
      await auditar(db, meuId, data.active ? "pessoa.reativada" : "pessoa.desativada", "person", data.personId);
      return { ok: true };
    }),
  );

// ---------------------------------------------------------------- login interno (0078)

const erroDoBanco = (error: unknown) => String((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);

/** Cria a pessoa com login interno (sem conta Microsoft) e devolve o link de uso único (7 dias) em que ela cria a senha. */
export const criarAcessoInterno = createServerFn({ method: "POST" })
  .validator(
    z.object({
      nome: z.string().trim().min(2, "Digite o nome.").max(120),
      login: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9._-]{2,39}$/, "Usuário: 3 a 40 letras minúsculas, números, ponto, hífen ou sublinhado."),
    }),
  )
  .handler(async ({ data }): Promise<{ personId: string; login: string; link: string }> =>
    comoAdministrador(async (db) => {
      const link = novoTokenDeLink();
      try {
        const [r] = (await db.execute<{ id: string }>(sql`SELECT app.criar_acesso_interno(${data.nome}, ${data.login}, ${link.hash}) AS id`)).rows;
        return { personId: r!.id, login: data.login, link: enderecoDoLink(link.token) };
      } catch (error) {
        const causa = erroDoBanco(error);
        if (/usuário já existe/.test(causa)) throw new AdminError("Esse usuário já existe. Escolha outro.");
        if (/sem permissão/.test(causa)) throw new AdminError("Só quem tem o perfil de administração cria acessos internos.");
        throw error;
      }
    }),
  );

/** Link novo para criar a senha (esqueceu sem e-mail pessoal, link venceu): a senha atual deixa de valer e as sessões saem. */
export const novoLinkDeSenha = createServerFn({ method: "POST" })
  .validator(z.object({ personId: z.uuid() }))
  .handler(async ({ data }): Promise<{ link: string }> =>
    comoAdministrador(async (db) => {
      const link = novoTokenDeLink();
      try {
        await db.execute(sql`SELECT app.novo_link_de_senha(${data.personId}::uuid, ${link.hash})`);
        return { link: enderecoDoLink(link.token) };
      } catch (error) {
        const causa = erroDoBanco(error);
        if (/sem permissão/.test(causa)) throw new AdminError("Só quem tem o perfil de administração gera links de senha.");
        if (/não é uma conta interna/.test(causa)) throw new AdminError("Essa pessoa entra pela Microsoft.");
        throw error;
      }
    }),
  );

// ---------------------------------------------------------------- funções da empresa

export type AtribuicaoFuncao = {
  id: string;
  personId: string;
  pessoa: string;
  startsOn: string;
  endsOn: string | null;
  isSubstitute: boolean;
};
export type FuncaoAdmin = { code: string; name: string; description: string | null; atribuicoes: AtribuicaoFuncao[] };

export const listFuncoes = createServerFn({ method: "GET" }).handler(async (): Promise<FuncaoAdmin[]> =>
  comoAdministrador(async (db) => {
    const hoje = hojeSaoPaulo();
    const funcoes = await db.select().from(schema.functions).orderBy(asc(schema.functions.name));
    const atribuicoes = await db
      .select({
        id: schema.functionAssignments.id,
        functionCode: schema.functionAssignments.functionCode,
        personId: schema.functionAssignments.personId,
        pessoa: schema.people.displayName,
        startsOn: schema.functionAssignments.startsOn,
        endsOn: schema.functionAssignments.endsOn,
        isSubstitute: schema.functionAssignments.isSubstitute,
      })
      .from(schema.functionAssignments)
      .innerJoin(schema.people, eq(schema.people.id, schema.functionAssignments.personId))
      .where(or(isNull(schema.functionAssignments.endsOn), gte(schema.functionAssignments.endsOn, hoje)))
      .orderBy(asc(schema.functionAssignments.startsOn));
    return funcoes.map((f) => ({
      code: f.code,
      name: f.name,
      description: f.description,
      atribuicoes: atribuicoes.filter((a) => a.functionCode === f.code).map(({ functionCode: _, ...a }) => a),
    }));
  }),
);

export const atribuirFuncao = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        functionCode: z.string().regex(/^[a-z_]+$/),
        personId: z.uuid(),
        startsOn: dataSchema,
        endsOn: dataSchema.nullable(),
        isSubstitute: z.boolean(),
      })
      .refine((d) => !d.endsOn || d.endsOn >= d.startsOn, { message: "O fim não pode ser antes do início." }),
  )
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const [criada] = await db
        .insert(schema.functionAssignments)
        .values({ ...data, createdBy: meuId })
        .returning({ id: schema.functionAssignments.id });
      await auditar(db, meuId, "funcao.atribuida", "function", data.functionCode, {
        personId: data.personId,
        startsOn: data.startsOn,
        endsOn: data.endsOn,
        isSubstitute: data.isSubstitute,
      });
      return { id: criada!.id };
    }),
  );

/** Encerra hoje; se começou hoje ou ainda nem começou, apaga. */
export const encerrarAtribuicao = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const [a] = await db.select().from(schema.functionAssignments).where(eq(schema.functionAssignments.id, data.id));
      if (!a) throw new AdminError("Atribuição não encontrada.");
      const hoje = hojeSaoPaulo();
      if (a.startsOn >= hoje) {
        await db.delete(schema.functionAssignments).where(eq(schema.functionAssignments.id, data.id));
      } else {
        await db.update(schema.functionAssignments).set({ endsOn: hoje }).where(eq(schema.functionAssignments.id, data.id));
      }
      await auditar(db, meuId, "funcao.encerrada", "function", a.functionCode, { personId: a.personId });
      return { ok: true };
    }),
  );

// ---------------------------------------------------------------- feriados

export type FeriadoAdmin = {
  id: string | null;
  date: string;
  name: string;
  scope: "nacional" | "municipal" | "empresa";
  city: string | null;
};

export const listFeriados = createServerFn({ method: "GET" })
  .validator(z.object({ ano: z.number().int().min(2020).max(2100) }))
  .handler(async ({ data }): Promise<FeriadoAdmin[]> =>
    comoAdministrador(async (db) => {
      const cadastrados = await db
        .select()
        .from(schema.holidays)
        .where(and(gte(schema.holidays.date, `${data.ano}-01-01`), lte(schema.holidays.date, `${data.ano}-12-31`)));
      const nacionais: FeriadoAdmin[] = nationalHolidays(data.ano).map((h) => ({
        id: null,
        date: h.date,
        name: h.name,
        scope: "nacional",
        city: null,
      }));
      const proprios: FeriadoAdmin[] = cadastrados.map((h) => ({ id: h.id, date: h.date, name: h.name, scope: h.scope, city: h.city }));
      return [...nacionais, ...proprios].sort((a, b) => a.date.localeCompare(b.date));
    }),
  );

export const adicionarFeriado = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        date: dataSchema,
        name: z.string().trim().min(2).max(120),
        scope: z.enum(["municipal", "empresa"]),
        city: z.string().trim().max(80).nullable(),
      })
      .refine((d) => d.scope !== "municipal" || (d.city?.length ?? 0) >= 2, { message: "Informe a cidade do feriado municipal." }),
  )
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const city = data.scope === "municipal" ? data.city : null;
      const existentes = await db
        .select({ id: schema.holidays.id })
        .from(schema.holidays)
        .where(
          and(
            eq(schema.holidays.date, data.date),
            eq(schema.holidays.scope, data.scope),
            city ? eq(schema.holidays.city, city) : sql`${schema.holidays.city} IS NULL`,
          ),
        );
      if (existentes.length) throw new AdminError("Esse feriado já está cadastrado.");
      const [criado] = await db
        .insert(schema.holidays)
        .values({ date: data.date, name: data.name, scope: data.scope, city, createdBy: meuId })
        .returning({ id: schema.holidays.id });
      await auditar(db, meuId, "feriado.adicionado", "holiday", criado!.id, { date: data.date, scope: data.scope, city });
      return { id: criado!.id };
    }),
  );

export const removerFeriado = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const removidos = await db.delete(schema.holidays).where(eq(schema.holidays.id, data.id)).returning();
      if (!removidos.length) throw new AdminError("Feriado não encontrado.");
      await auditar(db, meuId, "feriado.removido", "holiday", data.id, { date: removidos[0]!.date, name: removidos[0]!.name });
      return { ok: true };
    }),
  );

// ---------------------------------------------------------------- caixas de e-mail (Fase 4)

export type CaixaEmail = { id: string; email: string; ativa: boolean; ultimaLeitura: string | null; erro: string | null };

/** Caixas que o Omni lê. O Exchange (grupo "Omni - Caixas") é quem libera de fato; aqui só a lista. */
export const listCaixas = createServerFn({ method: "GET" }).handler(
  async (): Promise<CaixaEmail[]> =>
    comoAdministrador(async (db) =>
      (await db.select().from(schema.mailMailboxes).orderBy(asc(schema.mailMailboxes.email))).map((c) => ({
        id: c.id,
        email: c.email,
        ativa: c.active,
        ultimaLeitura: c.lastSyncAt?.toISOString() ?? null,
        erro: c.lastError,
      })),
    ),
);

export const adicionarCaixa = createServerFn({ method: "POST" })
  .validator(z.object({ email: z.email("Informe um e-mail válido.").transform((e) => e.trim().toLowerCase()) }))
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const [existente] = await db.select().from(schema.mailMailboxes).where(eq(schema.mailMailboxes.email, data.email));
      if (existente) throw new AdminError("Essa caixa já está cadastrada.");
      const [criada] = await db.insert(schema.mailMailboxes).values({ email: data.email, addedBy: meuId }).returning();
      await auditar(db, meuId, "caixa_email.adicionada", "mail_mailbox", criada!.id, { email: data.email });
      return { id: criada!.id };
    }),
  );

export const ativarCaixa = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid(), ativa: z.boolean() }))
  .handler(async ({ data }) =>
    comoAdministrador(async (db, meuId) => {
      const [c] = await db.update(schema.mailMailboxes).set({ active: data.ativa }).where(eq(schema.mailMailboxes.id, data.id)).returning();
      if (!c) throw new AdminError("Caixa não encontrada.");
      await auditar(db, meuId, data.ativa ? "caixa_email.ativada" : "caixa_email.desativada", "mail_mailbox", data.id, { email: c.email });
      return { ok: true };
    }),
  );
