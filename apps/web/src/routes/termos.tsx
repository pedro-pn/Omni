import { caminhoDeVolta, TERMOS } from "@omni/core";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import { z } from "zod";

import { getMe } from "../lib/session-fns.ts";
import { aceitarTermos, termoAtual } from "../lib/termos-fns.ts";
import { apagarHistoricoDoAparelho } from "../lib/whatsapp-aparelho.ts";

export const Route = createFileRoute("/termos")({
  validateSearch: z.object({ volta: z.string().max(2000).optional() }),
  beforeLoad: async ({ search }) => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar", search: { volta: `/termos${search.volta ? `?volta=${encodeURIComponent(search.volta)}` : ""}` } });
    return { me };
  },
  loader: () => termoAtual(),
  head: () => ({ meta: [{ title: "Termo de uso e privacidade · Omni" }] }),
  component: Termos,
});

const dataHora = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

function Termos() {
  const { me } = Route.useRouteContext();
  const termo = Route.useLoaderData();
  const { volta } = Route.useSearch();
  const [concordo, setConcordo] = useState(false);
  const destino = caminhoDeVolta(volta);
  const aceitar = useMutation({
    mutationFn: () => aceitarTermos({ data: { versao: termo.versao, concordo: true } }),
    // Recarrega por inteiro: a sessão passa a abrir o resto do Omni.
    onSuccess: () => window.location.assign(destino),
  });
  const pendente = !termo.aceitoEm;
  const [ano, mes, dia] = TERMOS.versao.slice(0, 10).split("-");

  return (
    <main className="min-h-dvh bg-floresta px-4 py-8">
      <div className="mx-auto w-full max-w-2xl">
        <img src="/marca/filtrovali-logo-horizontal-white.png" alt="Filtrovali" className="mx-auto mb-6 h-10 w-auto" />
        <article className="rounded-lg bg-superficie p-6 shadow-sm sm:p-8" aria-labelledby="titulo-termos">
          <h1 id="titulo-termos" className="text-xl font-semibold">
            {TERMOS.titulo}
          </h1>
          <p className="mt-1 text-xs text-muted">
            Versão de {dia}/{mes}/{ano}
          </p>
          {pendente && (
            <p className="mt-4 rounded-md bg-superficie-2 p-3 text-sm">
              Olá, {me.displayName.split(" ")[0]}. Antes do primeiro acesso, leia o termo até o fim e confirme no final da página.
            </p>
          )}
          <p className="mt-4">{TERMOS.introducao}</p>
          {TERMOS.secoes.map((s) => (
            <section key={s.titulo} className="mt-5">
              <h2 className="font-semibold">{s.titulo}</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
                {s.itens.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
          <p className="mt-5 text-sm text-muted">{TERMOS.rodape}</p>

          <div className="mt-6 border-t border-linha pt-5">
            {pendente ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (concordo) aceitar.mutate();
                }}
                className="space-y-4"
              >
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" checked={concordo} onChange={(e) => setConcordo(e.target.checked)} className="mt-0.5 size-4" />
                  <span>Li e estou de acordo com o termo de uso e privacidade do Omni.</span>
                </label>
                {aceitar.isError && (
                  <p role="alert" className="text-sm text-vermelho">
                    {aceitar.error instanceof Error ? aceitar.error.message : "Não foi possível registrar. Tente de novo."}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    disabled={!concordo || aceitar.isPending}
                    className="rounded-md bg-floresta px-4 py-2 font-medium text-white disabled:opacity-50"
                  >
                    {aceitar.isPending ? "Registrando…" : "Aceitar e continuar"}
                  </button>
                  <button type="submit" form="sair-termos" className="rounded-md px-3 py-2 text-sm text-muted hover:bg-superficie-2">
                    Sair
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex items-center gap-2 text-sm text-floresta-texto">
                  <CheckCircle2 size={18} aria-hidden /> Você aceitou esta versão em {dataHora(termo.aceitoEm!)}.
                </p>
                <a href={destino} className="rounded-md bg-floresta px-4 py-2 font-medium text-white">
                  Voltar ao Omni
                </a>
              </div>
            )}
            <form
              id="sair-termos"
              method="post"
              action="/auth/sair"
              onSubmit={(e) => {
                // O histórico do WhatsApp baixado neste aparelho sai junto.
                e.preventDefault();
                const form = e.currentTarget;
                void apagarHistoricoDoAparelho().finally(() => form.submit());
              }}
            />
          </div>
        </article>
      </div>
    </main>
  );
}
