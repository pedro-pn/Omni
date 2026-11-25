import { descreverVencimento } from "@omni/core";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { verificarPrisma } from "../../../lib/prisma-fns.ts";
import { getMe } from "../../../lib/session-fns.ts";

/**
 * Retorno da autorização no Prisma: `#code=…&state=…` ou `#error=access_denied&state=…`.
 * URI cadastrada no Prisma por comparação exata (PRISMA_RETORNO_PATH).
 */
export const Route = createFileRoute("/integracoes/prisma/retorno")({
  beforeLoad: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar" });
    if (me.senhaPendente) throw redirect({ to: "/conta/senha" });
    if (me.termosPendentes) throw redirect({ to: "/termos" });
  },
  head: () => ({ meta: [{ title: "Conectando ao Prisma · Omni" }] }),
  component: Retorno,
});

type Estado =
  | { fase: "trocando" }
  | { fase: "ok"; ambiente: string; expiraEm: string; escopos: string[]; confirmado: boolean | null }
  | { fase: "erro"; mensagem: string };

const MENSAGENS: Record<string, string> = {
  access_denied: "Você não autorizou o Omni no Prisma.",
  "fluxo-invalido": "A autorização expirou ou não foi iniciada por este navegador. Tente de novo.",
  "sessao-expirada": "Sua sessão no Omni expirou. Entre de novo e reconecte.",
  "ambiente-divergente": "O Prisma respondeu de um ambiente diferente do configurado no Omni.",
  "troca-recusada": "O Prisma recusou a autorização. Tente de novo.",
};

const ESCOPOS: Record<string, string> = {
  "contacts.write": "contatos",
  "companies.write": "empresas",
  "feedback.write": "feedbacks e históricos",
  "missions.participants.write": "participantes das missões",
};

function Retorno() {
  const [estado, setEstado] = useState<Estado>({ fase: "trocando" });
  const iniciado = useRef(false);

  useEffect(() => {
    if (iniciado.current) return;
    iniciado.current = true;
    // Lê e apaga o fragmento na hora: o código é de uso único e não deve ficar no histórico.
    const fragmento = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname);
    const erro = fragmento.get("error");
    const code = fragmento.get("code");
    const state = fragmento.get("state");
    if (erro || !code || !state) {
      setEstado({ fase: "erro", mensagem: MENSAGENS[erro ?? ""] ?? "Não recebemos a autorização do Prisma. Tente de novo." });
      return;
    }
    void (async () => {
      const resposta = await fetch("/integracoes/prisma/troca", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      });
      const corpo = (await resposta.json().catch(() => ({}))) as {
        ok?: boolean;
        erro?: string;
        environment?: string;
        expiresAt?: string;
        scopes?: string[];
      };
      if (!resposta.ok || !corpo.ok) {
        setEstado({ fase: "erro", mensagem: MENSAGENS[corpo.erro ?? ""] ?? "Não foi possível concluir a conexão." });
        return;
      }
      const base = { fase: "ok" as const, ambiente: corpo.environment!, expiraEm: corpo.expiresAt!, escopos: corpo.scopes ?? [] };
      setEstado({ ...base, confirmado: null });
      const verificacao = await verificarPrisma();
      setEstado({ ...base, confirmado: verificacao.ok });
    })();
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-fundo px-4">
      <div className="w-full max-w-md rounded-lg border border-linha bg-superficie p-6">
        <h1 className="text-lg font-semibold">Prisma CRM</h1>
        {estado.fase === "trocando" && <p className="mt-2 text-muted">Concluindo a conexão…</p>}
        {estado.fase === "erro" && (
          <p role="alert" className="mt-3 flex gap-2 text-vermelho">
            <XCircle size={20} className="shrink-0" aria-hidden /> {estado.mensagem}
          </p>
        )}
        {estado.fase === "ok" && (
          <div className="mt-3 space-y-2">
            <p className="flex gap-2 text-floresta-texto">
              <CheckCircle2 size={20} className="shrink-0" aria-hidden /> Omni conectado ao Prisma
              {estado.ambiente === "sandbox" ? " (ambiente de testes)" : ""}.
            </p>
            <p className="text-sm text-muted">
              Você autorizou registrar {estado.escopos.map((e) => ESCOPOS[e] ?? e).join(", ")} em seu nome. A conexão vale
              até {descreverVencimento(estado.expiraEm).texto}; o Omni avisa quando estiver perto de vencer.
            </p>
            <p className="text-sm text-muted">
              {estado.confirmado === null
                ? "Confirmando com o Prisma…"
                : estado.confirmado
                  ? "O Prisma confirmou a credencial."
                  : "O Prisma não confirmou a credencial agora. Tente reconectar."}
            </p>
          </div>
        )}
        {estado.fase !== "trocando" && (
          <div className="mt-5 flex gap-2">
            <Link to="/" className="rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura">
              Voltar ao Omni
            </Link>
            {estado.fase === "erro" && (
              <a href="/integracoes/prisma/conectar" className="rounded-md border border-linha px-4 py-2 font-medium hover:bg-superficie-2">
                Tentar de novo
              </a>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
