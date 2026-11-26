import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { pedirRecuperacaoDeSenha } from "../lib/senha-fns.ts";

/**
 * "Esqueci a senha" do login interno (0078): o link chega no e-mail pessoal confirmado da
 * conta. Sem e-mail pessoal, não há recuperação: a Administração gera um link novo. A
 * resposta é sempre a mesma (não revela quem existe ou tem e-mail).
 */
export const Route = createFileRoute("/recuperar-senha")({
  validateSearch: z.object({ usuario: z.string().max(60).optional() }),
  head: () => ({ meta: [{ title: "Esqueci a senha · Omni" }] }),
  component: RecuperarSenha,
});

function RecuperarSenha() {
  const { usuario } = Route.useSearch();
  const [login, setLogin] = useState(usuario ?? "");
  const pedir = useMutation({ mutationFn: () => pedirRecuperacaoDeSenha({ data: { login } }) });
  // Antes de a página carregar, o botão não faz nada (o envio é pelo JavaScript).
  const [pronta, setPronta] = useState(false);
  useEffect(() => setPronta(true), []);
  return (
    <main className="flex min-h-screen items-center justify-center bg-floresta px-4 py-10">
      <div className="w-full max-w-sm">
        <img src="/marca/filtrovali-logo-horizontal-white.png" alt="Filtrovali" className="mx-auto mb-8 h-12 w-auto" />
        <div className="rounded-lg bg-superficie p-6 shadow-sm">
          <h1 className="text-lg font-semibold">Esqueci a senha</h1>
          {pedir.isSuccess ? (
            <p role="status" className="mt-3 text-muted">
              Se este usuário tiver um e-mail pessoal confirmado, o link para criar uma senha nova chegou nele (vale 1 hora). Se não chegar, peça um link
              novo à Administração do Omni.
            </p>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                pedir.mutate();
              }}
            >
              <p className="mt-1 text-muted">
                Para quem entra com usuário e senha. O link chega no e-mail pessoal que você cadastrou e confirmou no Omni; sem ele, peça um link novo à
                Administração.
              </p>
              <label className="mt-4 block">
                <span className="text-sm font-medium">Usuário</span>
                <input
                  required
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2"
                />
              </label>
              {pedir.isError && (
                <p role="alert" className="mt-3 text-sm text-vermelho">
                  Não foi possível pedir agora. Tente de novo.
                </p>
              )}
              <button type="submit" disabled={!pronta || pedir.isPending} className="mt-5 w-full rounded-md bg-floresta px-4 py-2.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
                {pedir.isPending ? "Enviando…" : "Enviar o link"}
              </button>
            </form>
          )}
          <a href="/entrar" className="mt-4 block text-center text-sm font-medium text-floresta-texto hover:underline">
            Voltar para entrar
          </a>
        </div>
      </div>
    </main>
  );
}
