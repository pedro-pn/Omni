import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { confirmarEmailPeloLink, lerLinkInterno, usarLinkDeSenha } from "../lib/senha-fns.ts";

/**
 * Links de uso único do login interno (0078): criar a senha (vale 7 dias), criar uma nova
 * ao recuperar (1 hora) e confirmar o e-mail pessoal (24 horas). O token vem depois do "#"
 * (o navegador não o manda ao servidor nem a outros sites); a página tira o token do
 * endereço assim que lê.
 */
export const Route = createFileRoute("/link")({
  head: () => ({ meta: [{ title: "Omni" }, { name: "referrer", content: "no-referrer" }] }),
  component: PaginaDoLink,
});

const campo = "mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2";

function Moldura({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-floresta px-4 py-10">
      <div className="w-full max-w-sm">
        <img src="/marca/filtrovali-logo-horizontal-white.png" alt="Filtrovali" className="mx-auto mb-8 h-12 w-auto" />
        <div className="rounded-lg bg-superficie p-6 shadow-sm">{children}</div>
      </div>
    </main>
  );
}

function PaginaDoLink() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  // Lido uma vez só (o efeito pode rodar duas vezes no desenvolvimento): depois sai do endereço e do histórico.
  const lido = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lido.current === undefined) {
      const t = window.location.hash.slice(1);
      lido.current = /^[A-Za-z0-9_-]{20,128}$/.test(t) ? t : null;
      window.history.replaceState(null, "", "/link");
    }
    setToken(lido.current);
  }, []);
  const link = useQuery({ queryKey: ["link-interno", token], queryFn: () => lerLinkInterno({ data: { token: token! } }), enabled: Boolean(token), retry: false, staleTime: Infinity });

  if (token === undefined || (token && link.isPending)) return <Moldura><p className="text-muted">Abrindo o link…</p></Moldura>;
  const d = link.data;
  if (!token || link.isError || !d || !d.valido)
    return (
      <Moldura>
        <h1 className="text-lg font-semibold">Link inválido</h1>
        <p className="mt-2 text-muted">Este link não vale mais: ele já foi usado ou venceu. Peça um novo à Administração do Omni.</p>
        <a href="/entrar" className="mt-5 block text-center font-medium text-floresta-texto hover:underline">
          Ir para a tela de entrar
        </a>
      </Moldura>
    );
  if (d.tipo === "confirmar_email") return <ConfirmarEmail token={token} nome={d.nome ?? ""} />;
  return <CriarSenha token={token} nome={d.nome ?? ""} login={d.login ?? ""} recuperar={d.tipo === "recuperar"} />;
}

function CriarSenha({ token, nome, login, recuperar }: { token: string; nome: string; login: string; recuperar: boolean }) {
  const [senha, setSenha] = useState("");
  const [confirma, setConfirma] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const criar = useMutation({
    mutationFn: () => usarLinkDeSenha({ data: { token, senha } }),
    onSuccess: (r) => window.location.replace(`/entrar?usuario=${encodeURIComponent(r.login)}&aviso=senha-criada`),
    onError: (e) => setErro(e instanceof Error && e.message ? e.message : "Não foi possível criar a senha."),
  });
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    setErro(null);
    if (senha !== confirma) return setErro("A confirmação não é igual à senha.");
    if (senha.length < 10 || !/\d/.test(senha) || !/\D/.test(senha)) return setErro("Use pelo menos 10 caracteres, com letras e números.");
    criar.mutate();
  };
  return (
    <Moldura>
      <form onSubmit={enviar}>
        <h1 className="text-lg font-semibold">{recuperar ? "Crie uma senha nova" : "Crie a sua senha"}</h1>
        <p className="mt-1 text-muted">
          Olá, {nome}. Seu usuário no Omni é <strong className="font-mono text-ink">{login}</strong>.
        </p>
        {erro && (
          <p role="alert" className="mt-4 rounded-md border border-vermelho/40 px-3 py-2 text-vermelho">
            {erro}
          </p>
        )}
        <input type="text" name="username" autoComplete="username" value={login} readOnly hidden />
        <label className="mt-4 block">
          <span className="text-sm font-medium">Senha</span>
          <input type="password" required minLength={10} autoComplete="new-password" value={senha} onChange={(e) => setSenha(e.target.value)} className={campo} />
          <span className="mt-1 block text-xs text-muted">Pelo menos 10 caracteres, com letras e números.</span>
        </label>
        <label className="mt-3 block">
          <span className="text-sm font-medium">Repita a senha</span>
          <input type="password" required autoComplete="new-password" value={confirma} onChange={(e) => setConfirma(e.target.value)} className={campo} />
        </label>
        <button type="submit" disabled={criar.isPending} className="mt-5 w-full rounded-md bg-floresta px-4 py-2.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
          {criar.isPending ? "Salvando…" : "Salvar a senha"}
        </button>
        <p className="mt-3 text-xs text-muted">Este link vale uma vez só.</p>
      </form>
    </Moldura>
  );
}

function ConfirmarEmail({ token, nome }: { token: string; nome: string }) {
  const confirmar = useMutation({ mutationFn: () => confirmarEmailPeloLink({ data: { token } }) });
  return (
    <Moldura>
      <h1 className="text-lg font-semibold">Confirmar o e-mail pessoal</h1>
      {confirmar.isSuccess ? (
        <>
          <p className="mt-2 text-muted">Pronto, {nome}. Se esquecer a senha, o link para criar uma nova chega neste e-mail.</p>
          <a href={`/entrar?usuario=${encodeURIComponent(confirmar.data.login)}`} className="mt-5 block text-center font-medium text-floresta-texto hover:underline">
            Ir para o Omni
          </a>
        </>
      ) : (
        <>
          <p className="mt-2 text-muted">Olá, {nome}. Confirme para usar este e-mail na recuperação da senha do Omni.</p>
          {confirmar.isError && (
            <p role="alert" className="mt-4 rounded-md border border-vermelho/40 px-3 py-2 text-vermelho">
              {confirmar.error.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => confirmar.mutate()}
            disabled={confirmar.isPending}
            className="mt-5 w-full rounded-md bg-floresta px-4 py-2.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-60"
          >
            Confirmar o e-mail
          </button>
        </>
      )}
    </Moldura>
  );
}
