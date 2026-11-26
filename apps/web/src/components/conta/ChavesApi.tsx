import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Copy, KeyRound } from "lucide-react";
import { useState } from "react";

import { criarChave, listarChaves, revogarChave } from "../../lib/api-fns.ts";
import { Carregando } from "../comum/Carregando.tsx";

/** Meu perfil → API e automações: chaves pessoais da API /api/v1 (compatível com o Foco). */

const data = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "nunca";
const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");

export function ChavesApi() {
  const queryClient = useQueryClient();
  const [nova, setNova] = useState<string | null>(null);
  const [copiada, setCopiada] = useState(false);
  const chaves = useQuery({ queryKey: ["chaves-api"], queryFn: () => listarChaves() });
  const atualizar = () => void queryClient.invalidateQueries({ queryKey: ["chaves-api"] });
  const criar = useMutation({
    mutationFn: (v: { nome: string; escrita: boolean }) => criarChave({ data: v }),
    onSuccess: ({ chave }) => {
      setNova(chave);
      setCopiada(false);
      atualizar();
    },
  });
  const revogar = useMutation({ mutationFn: (id: string) => revogarChave({ data: { id } }), onSuccess: atualizar });
  const ativas = (chaves.data ?? []).filter((c) => !c.revogadaEm);
  const campo = "rounded-md border border-linha bg-superficie px-2 py-1.5";

  return (
    <main className="min-h-dvh bg-fundo px-4 py-6 text-ink">
      <div className="mx-auto grid max-w-2xl gap-5">
        <Link to="/" className="flex items-center gap-1.5 text-sm text-floresta-texto">
          <ArrowLeft size={16} /> Voltar ao Omni
        </Link>
        <header>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <KeyRound size={22} aria-hidden /> API e automações
          </h1>
          <p className="mt-1 text-sm text-muted">
            Chaves pessoais para a API de tarefas em <code className="text-ink">/api/v1</code>, a mesma do Foco (
            <a href="/openapi.json" className="underline">
              documentação
            </a>
            ). A chave age em seu nome e vê só o que você vê.
          </p>
        </header>

        <section className="rounded-lg border border-linha bg-superficie p-4">
          <h2 className="font-semibold">Nova chave</h2>
          <form
            className="mt-3 grid gap-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              criar.mutate({ nome: String(f.get("nome")), escrita: f.get("escrita") === "on" });
              e.currentTarget.reset();
            }}
          >
            <label className="grid gap-1">
              Nome (para que serve)
              <input name="nome" required minLength={2} maxLength={80} placeholder="Ex.: Planilha de acompanhamento" className={campo} />
            </label>
            <label className="flex items-center gap-2 pb-2">
              <input type="checkbox" name="escrita" /> Permitir criar e alterar
            </label>
            <button type="submit" disabled={criar.isPending} className="rounded-md bg-floresta px-4 py-1.5 font-medium text-white hover:bg-floresta-escura">
              Criar chave
            </button>
          </form>
          {criar.isError && (
            <p role="alert" className="mt-2 text-sm text-vermelho">
              {erroDe(criar.error)}
            </p>
          )}
          {nova && (
            <div role="status" className="mt-3 grid gap-2 rounded-md bg-floresta-clara p-3 text-sm">
              <p className="font-medium text-floresta-texto">Copie agora: a chave não aparece de novo.</p>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-superficie px-2 py-1">{nova}</code>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(nova).then(() => setCopiada(true))}
                  className="flex items-center gap-1 rounded-md border border-linha px-2 hover:bg-superficie-2"
                >
                  <Copy size={14} aria-hidden /> {copiada ? "Copiada" : "Copiar"}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-linha bg-superficie p-4">
          <h2 className="font-semibold">Chaves ativas · {ativas.length}</h2>
          {chaves.isLoading && <Carregando className="mt-2" />}
          <ul className="mt-2 divide-y divide-linha text-sm">
            {ativas.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{c.nome}</span>
                  <span className="block text-xs text-muted">
                    <code>{c.prefixo}…</code> · {c.prisma ? "Prisma, só leitura das suas atividades" : c.escopos.includes("write") ? "ler e alterar" : "só leitura"} · último
                    uso: {data(c.usadaEm)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => revogar.mutate(c.id)}
                  disabled={revogar.isPending}
                  className="rounded-md border border-linha px-3 py-1 text-vermelho hover:bg-superficie-2"
                >
                  Revogar
                </button>
              </li>
            ))}
            {chaves.data && ativas.length === 0 && <li className="py-2 text-muted">Nenhuma chave ativa.</li>}
          </ul>
        </section>
      </div>
    </main>
  );
}
