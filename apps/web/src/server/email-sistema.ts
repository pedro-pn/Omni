import { getEnv, ambienteDe } from "./env.ts";
import { getGraph } from "./graph.ts";

/**
 * E-mails do sistema mandados pelo web (0078: confirmar o e-mail pessoal e recuperar a senha
 * do login interno), da caixa EMAIL_AVISOS_REMETENTE e só com EMAIL_ENVIO=real (que a
 * validação recusa fora da produção). Em ensaio não sai nada; no desenvolvimento, o link
 * aparece no console do servidor para testar.
 */
export async function enviarEmailDoSistema(para: string, e: { assunto: string; texto: string; html: string }, linkParaTeste?: string): Promise<"enviado" | "ensaio"> {
  const env = getEnv();
  const graph = getGraph();
  if (env.EMAIL_ENVIO !== "real" || !env.EMAIL_AVISOS_REMETENTE || !graph) {
    if (ambienteDe(env) === "desenvolvimento" && linkParaTeste) console.info(`[email-sistema] ensaio: "${e.assunto}" → link: ${linkParaTeste}`);
    else console.info(`[email-sistema] ensaio: "${e.assunto}" não enviado (EMAIL_ENVIO=${env.EMAIL_ENVIO})`);
    return "ensaio";
  }
  await graph.enviarEmail(env.EMAIL_AVISOS_REMETENTE, { ...e, para: [para], cc: [], cco: [] });
  return "enviado";
}

/** Endereço público de um link do login interno (o token vai no #, que o navegador não manda ao servidor nem a terceiros). */
export const enderecoDoLink = (token: string) => `${getEnv().APP_ORIGIN.replace(/\/+$/, "")}/link#${token}`;
