import { hashSessionToken, novoTokenDeLink, withPerson } from "@omni/db";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { enderecoDoLink, enviarEmailDoSistema } from "../server/email-sistema.ts";
import { personIdFromRequest, sessaoDoRequest, sessionTokenFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Login interno (0078): a senha da própria pessoa, o e-mail pessoal de recuperação e os
 * links de uso único (criar a senha, recuperar, confirmar o e-mail). Tudo é conferido no
 * banco; aqui só ficam as mensagens para a tela e o envio dos e-mails.
 */

const causaDe = (error: unknown) => String((error as Error & { cause?: Error }).cause?.message ?? (error as Error).message);
const LINK_INVALIDO = "Este link não vale mais: ele já foi usado ou venceu. Peça um novo à Administração do Omni.";
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/, "Link inválido.");
const traduzir = (error: unknown): never => {
  const c = causaDe(error);
  if (/link inválido/.test(c)) throw new ErroParaTela(LINK_INVALIDO);
  if (/senha atual não confere/.test(c)) throw new ErroParaTela("A senha atual não confere.");
  if (/senha fraca/.test(c)) throw new ErroParaTela("Use pelo menos 10 caracteres, com letras e números.");
  if (/senha igual/.test(c)) throw new ErroParaTela("A senha nova precisa ser diferente da atual.");
  if (/e-mail inválido/.test(c)) throw new ErroParaTela("Confira o e-mail.");
  if (/muitos pedidos/.test(c)) throw new ErroParaTela("Muitos pedidos seguidos. Tente de novo daqui a uma hora.");
  throw error;
};

async function contaInterna() {
  const request = getRequest();
  const personId = await personIdFromRequest(request);
  const s = personId ? await sessaoDoRequest(request) : null;
  if (!personId || !s) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  if (s.acesso !== "interno") throw new ErroParaTela("Esta conta entra pela Microsoft.");
  return { personId, token: sessionTokenFromRequest(request)! };
}

// ---------------------------------------------------------------- com sessão

export const minhaContaInterna = createServerFn({ method: "GET" }).handler(async (): Promise<{ login: string; emailRecuperacao: string | null }> => {
  const { personId } = await contaInterna();
  const [r] = (await withPerson(getPool(), personId, (db) => db.execute<{ login: string; email_recuperacao: string | null }>(sql`SELECT * FROM app.minha_conta_interna()`))).rows;
  return { login: r?.login ?? "", emailRecuperacao: r?.email_recuperacao ?? null };
});

export const trocarMinhaSenha = createServerFn({ method: "POST" })
  .validator(z.object({ atual: z.string().min(1).max(200), nova: z.string().min(1).max(200) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { personId, token } = await contaInterna();
    await withPerson(getPool(), personId, (db) => db.execute(sql`SELECT app.trocar_minha_senha(${data.atual}, ${data.nova}, ${hashSessionToken(token)})`)).catch(traduzir);
    return { ok: true };
  });

/** Cadastrar o e-mail pessoal: só vale depois que a pessoa abre o link que chega nele. */
export const pedirConfirmacaoDeEmail = createServerFn({ method: "POST" })
  .validator(z.object({ senha: z.string().min(1).max(200), email: z.email("Confira o e-mail.").max(200) }))
  .handler(async ({ data }): Promise<{ enviado: boolean }> => {
    const { personId } = await contaInterna();
    const link = novoTokenDeLink();
    await withPerson(getPool(), personId, (db) => db.execute(sql`SELECT app.pedir_confirmacao_de_email(${data.senha}, ${data.email}, ${link.hash})`)).catch(traduzir);
    const url = enderecoDoLink(link.token);
    const r = await enviarEmailDoSistema(
      data.email,
      {
        assunto: "Omni: confirme o seu e-mail pessoal",
        texto: `Para usar este e-mail na recuperação da senha do Omni, abra o link (vale 24 horas):\n\n${url}\n\nSe não foi você, ignore esta mensagem.`,
        html: `<p>Para usar este e-mail na recuperação da senha do Omni, abra o link (vale 24 horas):</p><p><a href="${url}">Confirmar o e-mail</a></p><p>Se não foi você, ignore esta mensagem.</p>`,
      },
      url,
    );
    return { enviado: r === "enviado" };
  });

export const tirarEmailDeRecuperacao = createServerFn({ method: "POST" })
  .validator(z.object({ senha: z.string().min(1).max(200) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { personId } = await contaInterna();
    await withPerson(getPool(), personId, (db) => db.execute(sql`SELECT app.tirar_email_de_recuperacao(${data.senha})`)).catch(traduzir);
    return { ok: true };
  });

// ---------------------------------------------------------------- sem sessão (links)

export type LinkInterno = { tipo: "senha" | "recuperar" | "confirmar_email"; nome: string | null; login: string | null; valido: boolean };

export const lerLinkInterno = createServerFn({ method: "POST" })
  .validator(z.object({ token: tokenSchema }))
  .handler(async ({ data }): Promise<LinkInterno | null> => {
    const [r] = (await getPool().query<LinkInterno>("SELECT * FROM app.link_interno($1)", [hashSessionToken(data.token)])).rows;
    return r ?? null;
  });

/** Criar a senha (ou uma nova, ao recuperar) pelo link; devolve o usuário para a tela de entrar. */
export const usarLinkDeSenha = createServerFn({ method: "POST" })
  .validator(z.object({ token: tokenSchema, senha: z.string().min(1).max(200) }))
  .handler(async ({ data }): Promise<{ login: string }> => {
    const r = await getPool()
      .query<{ login: string }>("SELECT app.usar_link_de_senha($1, $2) AS login", [hashSessionToken(data.token), data.senha])
      .catch(traduzir);
    return { login: r.rows[0]!.login };
  });

export const confirmarEmailPeloLink = createServerFn({ method: "POST" })
  .validator(z.object({ token: tokenSchema }))
  .handler(async ({ data }): Promise<{ login: string }> => {
    const r = await getPool().query<{ login: string }>("SELECT app.confirmar_email_pelo_link($1) AS login", [hashSessionToken(data.token)]).catch(traduzir);
    return { login: r.rows[0]!.login };
  });

/**
 * "Esqueci a senha": manda o link (1 hora) só se a conta tiver e-mail pessoal confirmado.
 * A resposta é sempre a mesma, para não revelar quem existe ou tem e-mail.
 */
export const pedirRecuperacaoDeSenha = createServerFn({ method: "POST" })
  .validator(z.object({ login: z.string().trim().min(1).max(60) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const link = novoTokenDeLink();
    const [r] = (await getPool().query<{ email: string | null }>("SELECT app.pedir_recuperacao($1, $2) AS email", [data.login, link.hash])).rows;
    if (r?.email) {
      const url = enderecoDoLink(link.token);
      await enviarEmailDoSistema(
        r.email,
        {
          assunto: "Omni: criar uma senha nova",
          texto: `Alguém pediu para criar uma senha nova no Omni para o usuário ${data.login.toLowerCase()}. Abra o link (vale 1 hora, uma vez só):\n\n${url}\n\nSe não foi você, ignore esta mensagem: a senha atual continua valendo.`,
          html: `<p>Alguém pediu para criar uma senha nova no Omni para o usuário <strong>${data.login.toLowerCase().replace(/[<>&"]/g, "")}</strong>.</p><p><a href="${url}">Criar uma senha nova</a> (vale 1 hora, uma vez só)</p><p>Se não foi você, ignore esta mensagem: a senha atual continua valendo.</p>`,
        },
        url,
      ).catch((e: Error) => console.error("[senha] e-mail de recuperação não saiu:", e.name));
    }
    return { ok: true };
  });
