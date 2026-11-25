import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware, createStart } from "@tanstack/react-start";
import { ZodError } from "zod";

import { ErroParaTela } from "./lib/erros.ts";

/**
 * Toda server function passa por aqui. Erros para a tela (ErroParaTela) e
 * mensagens de validação seguem; o resto vira mensagem genérica e só a causa
 * (mensagem do Postgres, sem consulta nem parâmetros) vai para o log.
 */
const errosSeguros = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof ErroParaTela || isRedirect(error) || isNotFound(error)) throw error;
    if (error instanceof ZodError) throw new ErroParaTela(error.issues[0]?.message ?? "Confira os dados e tente de novo.");
    const causa = (error as { cause?: { message?: string; code?: string } }).cause;
    console.error("[servidor] erro inesperado:", causa?.code ?? "", causa?.message ?? (error as Error)?.name ?? "erro");
    throw new ErroParaTela("Não foi possível concluir. Tente de novo.");
  }
});

export const startInstance = createStart(() => ({ functionMiddleware: [errosSeguros] }));
