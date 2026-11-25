import { caminhoDeVolta } from "@omni/core";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { z } from "zod";

import { trocarMinhaSenha } from "../../lib/senha-fns.ts";
import { getMe } from "../../lib/session-fns.ts";

/** Trocar a senha do login interno (0078): obrigatória no primeiro acesso, com a senha provisória. */
export const Route = createFileRoute("/conta/senha")({
  validateSearch: z.object({ volta: z.string().max(2000).optional() }),
  beforeLoad: async ({ search }) => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar", search: { volta: "/conta/senha" } });
    if (me.acesso !== "interno") throw redirect({ href: caminhoDeVolta(search.volta) });
    return { me };
  },
  head: () => ({ meta: [{ title: "Trocar a senha · Omni" }] }),
  component: TrocarSenha,
});

const campo = "mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2";

function TrocarSenha() {
  const { me } = Route.useRouteContext();
  const { volta } = Route.useSearch();
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [confirma, setConfirma] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const trocar = useMutation({
    mutationFn: () => trocarMinhaSenha({ data: { atual, nova } }),
    // Recarrega a página inteira: a sessão agora abre o resto do Omni.
    onSuccess: () => window.location.assign(caminhoDeVolta(volta)),
    onError: (e) => setErro(e instanceof Error && e.message ? e.message : "Não foi possível trocar a senha."),
  });
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (nova !== confirma) return setErro("A confirmação não é igual à senha nova.");
    if (nova.length < 10 || !/\d/.test(nova) || !/\D/.test(nova)) return setErro("Use pelo menos 10 caracteres, com letras e números.");
    trocar.mutate();
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-floresta px-4 py-10">
      <div className="w-full max-w-sm">
        <img src="/marca/filtrovali-logo-horizontal-white.png" alt="Filtrovali" className="mx-auto mb-8 h-12 w-auto" />
        <form onSubmit={enviar} className="rounded-lg bg-superficie p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{me.senhaPendente ? "Crie a sua senha" : "Trocar a senha"}</h1>
          <p className="mt-1 text-muted">
            {me.senhaPendente ? `Olá, ${me.displayName}. Troque a senha provisória que você recebeu por uma só sua.` : "Digite a senha atual e a nova."}
          </p>
          {erro && (
            <p role="alert" className="mt-4 rounded-md border border-vermelho/40 px-3 py-2 text-vermelho">
              {erro}
            </p>
          )}
          <label className="mt-4 block">
            <span className="text-sm font-medium">{me.senhaPendente ? "Senha provisória" : "Senha atual"}</span>
            <input type="password" required autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} className={campo} />
          </label>
          <label className="mt-3 block">
            <span className="text-sm font-medium">Senha nova</span>
            <input type="password" required minLength={10} autoComplete="new-password" value={nova} onChange={(e) => setNova(e.target.value)} className={campo} />
            <span className="mt-1 block text-xs text-muted">Pelo menos 10 caracteres, com letras e números.</span>
          </label>
          <label className="mt-3 block">
            <span className="text-sm font-medium">Repita a senha nova</span>
            <input type="password" required autoComplete="new-password" value={confirma} onChange={(e) => setConfirma(e.target.value)} className={campo} />
          </label>
          <button type="submit" disabled={trocar.isPending} className="mt-5 w-full rounded-md bg-floresta px-4 py-2.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
            {trocar.isPending ? "Salvando…" : "Salvar a senha"}
          </button>
        </form>
        <form method="post" action="/auth/sair" className="mt-4 text-center">
          <button type="submit" className="text-sm text-white/80 underline-offset-2 hover:underline">
            Sair
          </button>
        </form>
      </div>
    </main>
  );
}
