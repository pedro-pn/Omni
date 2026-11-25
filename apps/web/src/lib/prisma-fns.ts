import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getEnv } from "../server/env.ts";
import { clientePrismaDaPessoa, conexaoPrisma, desconectarPrisma, type ConexaoPrisma } from "../server/prisma.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

async function exigirPessoa(): Promise<string> {
  const personId = await personIdFromRequest(getRequest());
  if (!personId) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return personId;
}

export const getConexaoPrisma = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ ambiente: string; conexao: ConexaoPrisma | null }> => ({
    ambiente: getEnv().PRISMA_OMNI_ENVIRONMENT,
    conexao: await conexaoPrisma(await exigirPessoa()),
  }),
);

/** Confere a credencial no próprio Prisma (`capabilities` com o token da pessoa). */
export const verificarPrisma = createServerFn({ method: "POST" }).handler(async () => {
  const cliente = await clientePrismaDaPessoa(await exigirPessoa());
  if (!cliente) return { ok: false as const, motivo: "sem-conexao" };
  try {
    const { data } = await cliente.capabilities();
    return { ok: true as const, ambiente: data.environment, finalidade: data.purpose, escopos: data.scopes };
  } catch (error) {
    console.error("[prisma] verificação falhou:", (error as Error).message);
    return { ok: false as const, motivo: "prisma-recusou" };
  }
});

export const desconectarDoPrisma = createServerFn({ method: "POST" }).handler(async () => {
  await desconectarPrisma(await exigirPessoa());
  return { ok: true };
});
