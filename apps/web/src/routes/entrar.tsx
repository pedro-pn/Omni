import { caminhoDeVolta } from "@omni/core";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { getLoginOptions, getMe } from "../lib/session-fns.ts";

const ERROS: Record<string, string> = {
  "microsoft-recusou": "A Microsoft não autorizou o login.",
  "microsoft-desligado": "O login Microsoft ainda não foi configurado.",
  "login-invalido": "O login expirou. Tente de novo.",
  "conta-desativada": "Sua conta está desativada no Omni. Fale com a diretoria.",
  "dados-invalidos": "Confira o e-mail e o nome.",
  "falha-login": "Não foi possível entrar. Tente de novo.",
};

export const Route = createFileRoute("/entrar")({
  validateSearch: z.object({ erro: z.string().max(40).optional(), volta: z.string().max(2000).optional() }),
  beforeLoad: async ({ search }) => {
    if (await getMe()) throw redirect({ href: caminhoDeVolta(search.volta) });
  },
  loader: () => getLoginOptions(),
  head: () => ({ meta: [{ title: "Entrar · Omni" }] }),
  component: Entrar,
});

function Entrar() {
  const options = Route.useLoaderData();
  const { erro, volta: voltaBruta } = Route.useSearch();
  const volta = caminhoDeVolta(voltaBruta);
  const mensagem = erro ? (ERROS[erro] ?? ERROS["falha-login"]) : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-floresta px-4 py-10">
      <div className="w-full max-w-sm">
        <img
          src="/marca/filtrovali-logo-horizontal-white.png"
          alt="Filtrovali"
          className="mx-auto mb-8 h-12 w-auto"
        />
        <div className="rounded-lg bg-superficie p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Entrar no Omni</h1>
          <p className="mt-1 text-muted">Use a sua conta Microsoft da Filtrovali.</p>

          {mensagem && (
            <p role="alert" className="mt-4 rounded-md border border-vermelho/40 px-3 py-2 text-vermelho">
              {mensagem}
            </p>
          )}

          {options.microsoft ? (
            <a
              href={volta === "/" ? "/auth/microsoft" : `/auth/microsoft?volta=${encodeURIComponent(volta)}`}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-md bg-floresta px-4 py-2.5 font-medium text-white hover:bg-floresta-escura"
            >
              Entrar com a Microsoft
            </a>
          ) : (
            <p className="mt-5 text-muted">O login Microsoft ainda não está configurado neste ambiente.</p>
          )}

          {options.dev && (
            <form method="post" action="/auth/dev" className="mt-6 border-t border-linha pt-5">
              <input type="hidden" name="volta" value={volta} />
              <p className="rotulo text-muted">Só desenvolvimento</p>
              <label className="mt-3 block">
                <span className="text-sm font-medium">E-mail</span>
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  className="mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2"
                />
              </label>
              <label className="mt-3 block">
                <span className="text-sm font-medium">Nome</span>
                <input
                  name="nome"
                  required
                  minLength={2}
                  autoComplete="name"
                  className="mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2"
                />
              </label>
              <button
                type="submit"
                className="mt-4 w-full rounded-md border border-floresta px-4 py-2 font-medium text-floresta-texto hover:bg-floresta-clara"
              >
                Entrar sem Microsoft
              </button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-sm text-white/80">Qualidade que move o seu futuro.</p>
      </div>
    </main>
  );
}
