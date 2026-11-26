import { caminhoDeVolta } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

import { minhaContaInterna, pedirConfirmacaoDeEmail, tirarEmailDeRecuperacao, trocarMinhaSenha } from "../../lib/senha-fns.ts";
import { getMe } from "../../lib/session-fns.ts";

/** Senha e e-mail pessoal de recuperação do login interno (0078). */
export const Route = createFileRoute("/conta/senha")({
  validateSearch: z.object({ volta: z.string().max(2000).optional() }),
  beforeLoad: async ({ search }) => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar", search: { volta: "/conta/senha" } });
    if (me.termosPendentes) throw redirect({ to: "/termos", search: { volta: "/conta/senha" } });
    if (me.acesso !== "interno") throw redirect({ href: caminhoDeVolta(search.volta) });
    return { me };
  },
  head: () => ({ meta: [{ title: "Senha e recuperação · Omni" }] }),
  component: MinhaSenha,
});

const campo = "mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2";
const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");

function MinhaSenha() {
  const { volta } = Route.useSearch();
  // Antes de a página carregar, os botões não fazem nada (o envio é pelo JavaScript).
  const [pronta, setPronta] = useState(false);
  useEffect(() => setPronta(true), []);
  const conta = useQuery({ queryKey: ["conta-interna"], queryFn: () => minhaContaInterna() });
  return (
    <main className="min-h-screen bg-fundo px-4 py-8">
      <div className="mx-auto max-w-lg space-y-6">
        <a href={caminhoDeVolta(volta)} className="text-sm font-medium text-floresta-texto hover:underline">
          ← Voltar ao Omni
        </a>
        <h1 className="text-xl font-semibold">Senha e recuperação</h1>
        {conta.data && (
          <p className="text-muted">
            Seu usuário: <strong className="font-mono text-ink">{conta.data.login}</strong>
          </p>
        )}
        <fieldset disabled={!pronta} className="space-y-6">
          <TrocarSenha />
          <EmailDeRecuperacao email={conta.data?.emailRecuperacao ?? null} carregando={conta.isPending} />
        </fieldset>
      </div>
    </main>
  );
}

function TrocarSenha() {
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [confirma, setConfirma] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const trocar = useMutation({
    mutationFn: () => trocarMinhaSenha({ data: { atual, nova } }),
    onSuccess: () => (setAtual(""), setNova(""), setConfirma("")),
    onError: (e) => setErro(erroDe(e)),
  });
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (nova !== confirma) return setErro("A confirmação não é igual à senha nova.");
    if (nova.length < 10 || !/\d/.test(nova) || !/\D/.test(nova)) return setErro("Use pelo menos 10 caracteres, com letras e números.");
    trocar.mutate();
  };
  return (
    <form onSubmit={enviar} className="rounded-lg border border-linha bg-superficie p-5">
      <h2 className="font-semibold">Trocar a senha</h2>
      {erro && (
        <p role="alert" className="mt-3 text-sm text-vermelho">
          {erro}
        </p>
      )}
      {trocar.isSuccess && (
        <p role="status" className="mt-3 text-sm text-floresta-texto">
          Senha trocada. As outras sessões abertas foram encerradas.
        </p>
      )}
      <label className="mt-3 block">
        <span className="text-sm font-medium">Senha atual</span>
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
      <button type="submit" disabled={trocar.isPending} className="mt-4 rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
        {trocar.isPending ? "Salvando…" : "Trocar a senha"}
      </button>
    </form>
  );
}

function EmailDeRecuperacao({ email, carregando }: { email: string | null; carregando: boolean }) {
  const qc = useQueryClient();
  const [novo, setNovo] = useState("");
  const [senha, setSenha] = useState("");
  const pedir = useMutation({ mutationFn: () => pedirConfirmacaoDeEmail({ data: { email: novo, senha } }), onSuccess: () => setSenha("") });
  const tirar = useMutation({
    mutationFn: () => tirarEmailDeRecuperacao({ data: { senha } }),
    onSuccess: () => (setSenha(""), qc.invalidateQueries({ queryKey: ["conta-interna"] })),
  });
  const erro = pedir.error ?? tirar.error;
  return (
    <section className="rounded-lg border border-linha bg-superficie p-5">
      <h2 className="font-semibold">E-mail pessoal para recuperar a senha</h2>
      <p className="mt-1 text-sm text-muted">
        Sem um e-mail pessoal confirmado, "Esqueci a senha" não funciona para a sua conta: só a Administração gera um link novo. O e-mail serve só para
        isso.
      </p>
      {!carregando && (
        <p className="mt-3 text-sm">
          {email ? (
            <>
              Confirmado: <strong>{email}</strong>
            </>
          ) : (
            "Nenhum e-mail confirmado."
          )}
        </p>
      )}
      {pedir.isSuccess && (
        <p role="status" className="mt-3 text-sm text-floresta-texto">
          {pedir.data.enviado
            ? `Mandamos um link para ${novo}. Abra em até 24 horas para confirmar.`
            : "O envio de e-mail está em ensaio neste ambiente: o link não saiu."}
        </p>
      )}
      {erro && (
        <p role="alert" className="mt-3 text-sm text-vermelho">
          {erroDe(erro)}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          pedir.mutate();
        }}
      >
        <label className="mt-3 block">
          <span className="text-sm font-medium">{email ? "Trocar por" : "E-mail pessoal"}</span>
          <input type="email" required autoComplete="email" value={novo} onChange={(e) => setNovo(e.target.value)} className={campo} />
        </label>
        <label className="mt-3 block">
          <span className="text-sm font-medium">Sua senha atual</span>
          <input type="password" required autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} className={campo} />
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="submit" disabled={pedir.isPending} className="rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
            {pedir.isPending ? "Enviando…" : "Enviar o link de confirmação"}
          </button>
          {email && (
            <button
              type="button"
              disabled={tirar.isPending || !senha}
              onClick={() => confirm("Tirar o e-mail pessoal? Sem ele, só a Administração consegue gerar um link de senha.") && tirar.mutate()}
              className="rounded-md border border-linha px-4 py-2 font-medium hover:bg-superficie-2 disabled:opacity-60"
              title={senha ? undefined : "Digite a senha atual"}
            >
              Tirar o e-mail
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
