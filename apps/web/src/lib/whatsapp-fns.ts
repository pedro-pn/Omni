import { missoesNoNomeDoGrupo, tituloMissao } from "@omni/core";
import { schema, withPerson } from "@omni/db";
import { WhatsAppError, type EstadoConexao } from "@omni/integrations/whatsapp";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { AdminError, auditar, comoAdministrador } from "../server/admin.ts";
import { getPool } from "../server/db.ts";
import { getEnv } from "../server/env.ts";
import { personIdFromRequest } from "../server/session.ts";
import { getWhatsApp } from "../server/whatsapp.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * WhatsApp (Fase 7, ADR 0004), números na Evolution própria do Omni.
 * - Cada pessoa conecta o próprio número em Conversas (0055) e cuida dele em Meu
 *   WhatsApp: parear de novo, atualizar, histórico dos grupos, reconfigurar,
 *   desconectar e remover — só o dono mexe no aparelho (0056).
 * - A Administração não tem nada a ver com os números das pessoas (0056); só a
 *   permissão de gravar ligações, que é da pessoa (Administração → Pessoas).
 * Cada ação vai para a auditoria.
 */

export type FinalidadeNumero = "operacao" | "campo" | "gestao" | "outro";
export type NumeroWhatsApp = {
  id: string;
  rotulo: string;
  finalidade: FinalidadeNumero;
  dono: { id: string; nome: string } | null;
  telefone: string | null;
  perfil: string | null;
  status: "criado" | "conectando" | "conectado" | "desconectado" | "removido";
  statusEm: string;
  erro: string | null;
  podeGravar: boolean;
};
export type EnvioWhatsApp = "desligado" | "ensaio" | "real";

function provedor() {
  const w = getWhatsApp();
  if (!w) throw new AdminError("O WhatsApp ainda não foi configurado no Omni (variáveis WHATSAPP_*).");
  return w;
}

/** Erro da Evolution → mensagem para a tela (sem detalhes internos). */
function erroDoProvedor(error: unknown): never {
  if (error instanceof WhatsAppError) {
    if (error.code === "indisponivel") throw new AdminError("A Evolution do Omni está fora do ar. Tente de novo em instantes.");
    if (error.code === "chave_recusada") throw new AdminError("A Evolution recusou a chave do Omni. Confira WHATSAPP_EVOLUTION_KEY.");
    if (error.code === "webhook_divergente") throw new AdminError("O webhook não ficou configurado na Evolution. Use \"Reconfigurar\".");
    throw new AdminError("A Evolution não conseguiu fazer isso agora.");
  }
  throw error;
}

const STATUS_DO_ESTADO: Record<EstadoConexao, "conectado" | "conectando" | "desconectado"> = {
  conectado: "conectado",
  conectando: "conectando",
  desconectado: "desconectado",
  inexistente: "desconectado",
};

export const definirPermissaoGravacao = createServerFn({ method: "POST" })
  .validator(z.object({ personId: z.uuid(), permitir: z.boolean() }))
  .handler(async ({ data }) => comoAdministrador(async (db, meuId) => {
    await db.insert(schema.whatsappCallPermissions).values({ personId: data.personId, canRecord: data.permitir, updatedBy: meuId })
      .onConflictDoUpdate({ target: schema.whatsappCallPermissions.personId, set: { canRecord: data.permitir, updatedBy: meuId, updatedAt: new Date() } });
    await auditar(db, meuId, "chamada.permissao_gravacao", "person", data.personId, { permitir: data.permitir });
    return { ok: true };
  }));

// ---------------------------------------------------------------- o próprio número (Meu WhatsApp)

async function eu(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

/** Número ativo do qual a pessoa é responsável (só o dono mexe no aparelho). */
async function numeroDoDono(id: string) {
  const me = await eu();
  const [x] = await withPerson(getPool(), me, (db) =>
    db
      .select()
      .from(schema.whatsappNumbers)
      .where(and(eq(schema.whatsappNumbers.id, id), eq(schema.whatsappNumbers.ownerPersonId, me), ne(schema.whatsappNumbers.status, "removido"))),
  );
  if (!x) throw new ErroParaTela("Este número não é seu.");
  return { x, me };
}

/** Grava o estado como o webhook grava (telefone repetido em outro número vira aviso no próprio número). */
const registrarEstado = (instancia: string, estado: EstadoConexao, telefone: string | null, perfil: string | null) =>
  getPool().query("SELECT app.whatsapp_registrar_conexao($1, $2, $3, $4)", [instancia, STATUS_DO_ESTADO[estado], telefone, perfil]);

/** Meu WhatsApp: os números de que a pessoa é responsável. */
export const meusNumeros = createServerFn({ method: "GET" }).handler(async (): Promise<{ configurado: boolean; envio: EnvioWhatsApp; numeros: NumeroWhatsApp[] }> => {
  const me = await eu();
  return withPerson(getPool(), me, async (db) => {
    const n = schema.whatsappNumbers;
    const numeros = await db.select().from(n).where(and(eq(n.ownerPersonId, me), ne(n.status, "removido"))).orderBy(asc(n.createdAt));
    const [gravacao] = await db.select().from(schema.whatsappCallPermissions).where(eq(schema.whatsappCallPermissions.personId, me));
    const [eu_] = await db.select({ nome: schema.people.displayName }).from(schema.people).where(eq(schema.people.id, me));
    return {
      configurado: Boolean(getWhatsApp()),
      envio: getEnv().WHATSAPP_ENVIO,
      numeros: numeros.map((x) => ({
        id: x.id,
        rotulo: x.label,
        finalidade: x.purpose,
        dono: { id: me, nome: eu_?.nome ?? "—" },
        telefone: x.phone,
        perfil: x.profileName,
        status: x.status,
        statusEm: x.statusAt.toISOString(),
        erro: x.lastError,
        podeGravar: Boolean(gravacao?.canRecord),
      })),
    };
  });
});

/** Para o diálogo de pareamento: o estado e, enquanto não conecta, o QR code atual (a tela chama a cada poucos segundos). */
export const parearNumero = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }): Promise<{ estado: EstadoConexao; imagem: string | null; telefone: string | null }> => {
    const { whatsapp, webhook } = provedor();
    const { x } = await numeroDoDono(data.id);
    try {
      let atual = await whatsapp.estado(x.instanceName);
      if (atual.estado === "inexistente") {
        await whatsapp.criarNumero(x.instanceName, webhook);
        atual = await whatsapp.estado(x.instanceName);
      }
      if (atual.estado === "conectado") {
        await registrarEstado(x.instanceName, "conectado", atual.telefone, atual.nomePerfil);
        return { estado: "conectado", imagem: null, telefone: atual.telefone };
      }
      const qr = await whatsapp.qrCode(x.instanceName);
      if (x.status !== "conectando") await registrarEstado(x.instanceName, "conectando", null, null);
      return { estado: qr.estado, imagem: qr.imagem, telefone: null };
    } catch (error) {
      erroDoProvedor(error);
    }
  });

/** Confere o estado na Evolution (botão "Atualizar"). */
export const atualizarEstadoNumero = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { whatsapp } = provedor();
    const { x } = await numeroDoDono(data.id);
    try {
      const atual = await whatsapp.estado(x.instanceName);
      await registrarEstado(x.instanceName, atual.estado, atual.telefone, atual.nomePerfil);
      return { estado: atual.estado };
    } catch (error) {
      erroDoProvedor(error);
    }
  });

/** Reaplica webhook e configurações na Evolution (e recria o número se ele sumiu de lá). */
export const reconfigurarNumero = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { whatsapp, webhook } = provedor();
    const { x, me } = await numeroDoDono(data.id);
    try {
      const atual = await whatsapp.estado(x.instanceName);
      if (atual.estado === "inexistente") await whatsapp.criarNumero(x.instanceName, webhook);
      else await whatsapp.configurarNumero(x.instanceName, webhook);
    } catch (error) {
      erroDoProvedor(error);
    }
    await withPerson(getPool(), me, async (db) => {
      await db.execute(sql`SELECT app.whatsapp_limpar_erro(${x.id}::uuid)`);
      await auditar(db, me, "whatsapp.numero_reconfigurado", "whatsapp_number", x.id);
    });
    return { ok: true };
  });

export const desconectarNumero = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { whatsapp } = provedor();
    const { x, me } = await numeroDoDono(data.id);
    try {
      await whatsapp.desconectar(x.instanceName);
    } catch (error) {
      erroDoProvedor(error);
    }
    await registrarEstado(x.instanceName, "desconectado", null, null);
    await withPerson(getPool(), me, (db) => auditar(db, me, "whatsapp.numero_desconectado", "whatsapp_number", x.id));
    return { ok: true };
  });

/** Remove da Evolution; no Omni o número fica como "removido" (as conversas já recebidas continuam, só para o dono). */
export const removerNumero = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { whatsapp } = provedor();
    const me = await eu();
    const [x] = await withPerson(getPool(), me, (db) =>
      db.select().from(schema.whatsappNumbers).where(and(eq(schema.whatsappNumbers.id, data.id), ne(schema.whatsappNumbers.status, "removido"))),
    );
    if (!x) throw new ErroParaTela("Número não encontrado.");
    try {
      await whatsapp.desconectar(x.instanceName).catch(() => undefined);
      await whatsapp.remover(x.instanceName);
    } catch (error) {
      if (!(error instanceof WhatsAppError && error.code === "inexistente")) erroDoProvedor(error);
    }
    const [r] = await withPerson(getPool(), me, (db) => db.execute<{ ok: boolean }>(sql`SELECT app.whatsapp_remover_numero(${x.id}::uuid) AS ok`)).then((q) => q.rows);
    if (!r?.ok) throw new ErroParaTela("Só o responsável pelo número pode removê-lo.");
    return { ok: true };
  });

// ---------------------------------------------------------------- histórico (opção A: só os grupos escolhidos)

export type GrupoDoHistorico = { jid: string; nome: string | null; ultimaEm: string | null; jaImportado: boolean; missao: string | null };
export type HistoricoDoNumero = {
  grupos: GrupoDoHistorico[];
  pedidos: { id: string; grupos: number; status: "pendente" | "importando" | "concluida" | "erro"; importadas: number; erro: string | null; em: string }[];
};

/** Aplica as configurações (histórico completo) e desconecta para parear de novo: o celular manda o histórico outra vez. */
export const prepararHistorico = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const { whatsapp, webhook } = provedor();
    const { x, me } = await numeroDoDono(data.id);
    try {
      await whatsapp.configurarNumero(x.instanceName, webhook);
      await whatsapp.desconectar(x.instanceName);
    } catch (error) {
      erroDoProvedor(error);
    }
    await registrarEstado(x.instanceName, "desconectado", null, null);
    await withPerson(getPool(), me, (db) => auditar(db, me, "whatsapp.historico_preparado", "whatsapp_number", x.id));
    return { ok: true };
  });

