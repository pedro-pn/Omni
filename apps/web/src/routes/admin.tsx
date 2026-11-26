import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";

import { Caixas } from "../components/admin/Caixas.tsx";
import { Feriados } from "../components/admin/Feriados.tsx";
import { Funcoes } from "../components/admin/Funcoes.tsx";
import { Pessoas } from "../components/admin/Pessoas.tsx";
import { Desempenho } from "../components/admin/Desempenho.tsx";
import { Saude } from "../components/admin/Saude.tsx";
import { ErrosDoSistema } from "../components/admin/ErrosDoSistema.tsx";
import { Seguranca } from "../components/admin/Seguranca.tsx";
import { getMe } from "../lib/session-fns.ts";
import { Modulos } from "../components/admin/Modulos.tsx";

const ABAS = [
  { id: "pessoas", rotulo: "Pessoas" },
  { id: "funcoes", rotulo: "Funções" },
  { id: "feriados", rotulo: "Feriados" },
  { id: "caixas", rotulo: "Caixas de e-mail" },
  { id: "seguranca", rotulo: "Segurança" },
  { id: "erros", rotulo: "Erros" },
  { id: "saude", rotulo: "Saúde" },
  { id: "desempenho", rotulo: "Desempenho" },
  { id: "modulos", rotulo: "Módulos" },
] as const;

export const Route = createFileRoute("/admin")({
  validateSearch: z.object({ aba: z.enum(["pessoas", "funcoes", "feriados", "caixas", "seguranca", "erros", "saude", "desempenho", "modulos"]).catch("pessoas").default("pessoas") }),
  beforeLoad: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar" });
    if (me.termosPendentes) throw redirect({ to: "/termos", search: { volta: "/admin" } });
    // A tela é só para quem administra; as permissões de verdade estão no banco (RLS).
    if (!me.profiles.includes("admin") && !me.profiles.includes("diretoria")) throw redirect({ to: "/" });
    return { me };
  },
  head: () => ({ meta: [{ title: "Administração · Omni" }] }),
  component: Admin,
});

function Admin() {
  const { me } = Route.useRouteContext();
  const { aba } = Route.useSearch();
  const souAdmin = me.profiles.includes("admin");

  return (
    <div className="min-h-dvh bg-fundo">
      <header className="flex items-center gap-3 bg-floresta px-4 py-3 text-white">
        <Link to="/" aria-label="Voltar ao Omni" className="rounded-md p-1.5 hover:bg-white/10">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-lg font-semibold">Administração</h1>
      </header>
      <nav aria-label="Seções da administração" className="border-b border-linha bg-superficie px-4">
        <ul className="flex gap-1">
          {ABAS.filter((a) => !["caixas", "erros", "saude", "desempenho"].includes(a.id) || souAdmin).map((a) => (
            <li key={a.id}>
              <Link
                to="/admin"
                search={{ aba: a.id }}
                aria-current={a.id === aba ? "page" : undefined}
                className={`inline-block border-b-2 px-3 py-2.5 font-medium ${
                  a.id === aba ? "border-floresta text-floresta-texto" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {a.rotulo}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="mx-auto max-w-5xl p-4">
        {aba === "pessoas" && <Pessoas meuId={me.id} souAdmin={souAdmin} />}
        {aba === "funcoes" && <Funcoes />}
        {aba === "feriados" && <Feriados />}
        {aba === "caixas" && souAdmin && <Caixas />}
        {aba === "seguranca" && <Seguranca />}
        {aba === "erros" && souAdmin && <ErrosDoSistema />}
        {aba === "saude" && souAdmin && <Saude />}
        {aba === "desempenho" && souAdmin && <Desempenho />}
        {aba === "modulos" && <Modulos />}
      </main>
    </div>
  );
}
