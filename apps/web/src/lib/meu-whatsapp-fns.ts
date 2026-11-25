import { schema, withPerson } from "@omni/db";
import { WhatsAppError, type EstadoConexao } from "@omni/integrations/whatsapp";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { getPool } from "../server/db.ts";
import { personIdFromRequest } from "../server/session.ts";
import { getWhatsApp } from "../server/whatsapp.ts";
import { ErroParaTela } from "./erros.ts";
import { exigirModulo } from "../server/modulos.ts";

/**
 * "Conectar meu WhatsApp" na página Conversas (0055): a própria pessoa cria o
 * número dela (já como responsável) e lê o QR code ali mesmo. O estado vem da
 * Evolution e é gravado como o webhook grava (app.whatsapp_registrar_conexao).
 */

export type MeuWhatsApp = {
  /** WhatsApp configurado neste ambiente. */
  disponivel: boolean;
  /** Pessoa sem perfil não conecta (o acesso ainda não foi liberado). */
  podeConectar: boolean;
  numero: { id: string; status: "criado" | "conectando" | "conectado" | "desconectado" | "removido"; telefone: string | null; erro: string | null } | null;
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

async function meuNumero(personId: string) {
  return withPerson(getPool(), personId, async (db) => {
    const [n] = await db
      .select()
      .from(schema.whatsappNumbers)
      .where(and(eq(schema.whatsappNumbers.ownerPersonId, personId), ne(schema.whatsappNumbers.status, "removido")))
      .orderBy(desc(sql`${schema.whatsappNumbers.status} = 'conectado'`), desc(schema.whatsappNumbers.createdAt))
      .limit(1);
    const perfis = await db.select().from(schema.personProfiles).where(eq(schema.personProfiles.personId, personId)).limit(1);
    return { numero: n ?? null, temPerfil: perfis.length > 0 };
  });
}

export const meuWhatsApp = createServerFn({ method: "GET" }).handler(async (): Promise<MeuWhatsApp> => {
  const personId = await pessoa();
  const { numero, temPerfil } = await meuNumero(personId);
  // WhatsApp não liberado para a pessoa (0071): como se não houvesse WhatsApp neste ambiente.
  const liberado = await exigirModulo(personId, "whatsapp").then(() => true, () => false);
  return {
    disponivel: Boolean(getWhatsApp()) && liberado,
    podeConectar: temPerfil,
    numero: numero ? { id: numero.id, status: numero.status, telefone: numero.phone, erro: numero.lastError } : null,
  };
});

const registrar = (instancia: string, estado: "conectando" | "conectado" | "desconectado", telefone: string | null, perfil: string | null) =>
  getPool().query("SELECT app.whatsapp_registrar_conexao($1, $2, $3, $4)", [instancia, estado, telefone, perfil]);

/**
 * Cria o número da pessoa se ainda não houver e devolve o estado e, enquanto não
 * conecta, o QR code atual. A tela chama de novo a cada poucos segundos.
 */
export const conectarMeuWhatsApp = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ estado: EstadoConexao; imagem: string | null; telefone: string | null }> => {
    const personId = await pessoa();
    await exigirModulo(personId, "whatsapp");
    const w = getWhatsApp();
    if (!w) throw new ErroParaTela("O WhatsApp ainda não foi configurado no Omni.");
    let { numero, temPerfil } = await meuNumero(personId);
    if (!temPerfil) throw new ErroParaTela("Seu acesso ainda não foi liberado. A diretoria define o seu perfil no Omni.");
    try {
      if (!numero) {
        const instancia = `omni-${randomBytes(6).toString("hex")}`;
        await withPerson(getPool(), personId, (db) => db.execute(sql`SELECT app.criar_meu_whatsapp(${instancia})`));
        numero = (await meuNumero(personId)).numero;
        if (!numero) throw new ErroParaTela("Não foi possível criar o seu número agora. Tente de novo.");
        if (numero.instanceName === instancia) await w.whatsapp.criarNumero(instancia, w.webhook);
      }
      let atual = await w.whatsapp.estado(numero.instanceName);
      if (atual.estado === "inexistente") {
        await w.whatsapp.criarNumero(numero.instanceName, w.webhook);
        atual = await w.whatsapp.estado(numero.instanceName);
      }
      if (atual.estado === "conectado") {
        await registrar(numero.instanceName, "conectado", atual.telefone, atual.nomePerfil);
        return { estado: "conectado", imagem: null, telefone: atual.telefone };
      }
      const qr = await w.whatsapp.qrCode(numero.instanceName);
      if (numero.status !== "conectando") await registrar(numero.instanceName, "conectando", null, null);
      return { estado: qr.estado, imagem: qr.imagem, telefone: null };
    } catch (error) {
      if (error instanceof ErroParaTela) throw error;
      if (error instanceof WhatsAppError) {
        throw new ErroParaTela(error.code === "indisponivel" ? "O WhatsApp do Omni está fora do ar. Tente de novo em instantes." : "Não foi possível gerar o QR code agora. Tente de novo.");
      }
      throw error;
    }
  },
);
