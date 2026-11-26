import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { getRequest, setResponseHeader, setResponseStatus } from "@tanstack/react-start/server";
import { ZodError } from "zod";

import { ErroParaTela } from "./lib/erros.ts";
import { medirFuncao } from "./server/desempenho.ts";
import { registrarErroDoWeb } from "./server/erros.ts";
import { limitarFuncao } from "./server/limites.ts";

/**
 * Toda server function passa por aqui. Erros para a tela (ErroParaTela) e
 * mensagens de validação seguem; o resto vira mensagem genérica e só a causa
 * (mensagem do Postgres, sem consulta nem parâmetros) vai para o log e para os erros do
 * sistema (Administração → Erros, com aviso a quem administra).
 */
const errosSeguros = createMiddleware({ type: "function" }).server(async ({ next, serverFnMeta }) => {
  // Ações caras (IA, envio de mensagens, Prisma, chaves): limite por pessoa (E10).
  const esperar = limitarFuncao(serverFnMeta?.name, getRequest());
  if (esperar) {
    setResponseStatus(429);
    setResponseHeader("Retry-After", String(esperar));
    throw new ErroParaTela(`Muitas tentativas seguidas. Aguarde ${esperar} segundos e tente de novo.`);
  }
  const inicio = performance.now();
  try {
    const r = await next();
    medirFuncao(serverFnMeta?.name, performance.now() - inicio, false);
    return r;
  } catch (error) {
    // Tempo por função (E19): só o erro inesperado conta como erro.
    const esperado = error instanceof ErroParaTela || isRedirect(error) || isNotFound(error) || error instanceof ZodError;
    medirFuncao(serverFnMeta?.name, performance.now() - inicio, !esperado);
    if (error instanceof ErroParaTela || isRedirect(error) || isNotFound(error)) throw error;
    if (error instanceof ZodError) throw new ErroParaTela(error.issues[0]?.message ?? "Confira os dados e tente de novo.");
    const causa = (error as { cause?: { message?: string; code?: string } }).cause;
    console.error("[servidor] erro inesperado:", causa?.code ?? "", causa?.message ?? (error as Error)?.name ?? "erro");
    // Erro do sistema (E09): registrado já limpo, com a função e o arquivo; o worker avisa quem administra.
    await registrarErroDoWeb(error, `fn ${serverFnMeta?.name ?? "?"} (${serverFnMeta?.filename ?? "?"})`);
    throw new ErroParaTela("Não foi possível concluir. Tente de novo.");
  }
});

export const startInstance = createStart(() => ({ functionMiddleware: [errosSeguros] }));
