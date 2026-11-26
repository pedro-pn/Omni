import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { adicionarFeriado, listFeriados, removerFeriado } from "../../lib/admin-fns.ts";
import { Aviso, botaoPrimario, botaoSecundario, campo, mensagemDeErro } from "./ui.tsx";
import { Carregando } from "../comum/Carregando.tsx";

const ESCOPO = { nacional: "Nacional", municipal: "Municipal", empresa: "Empresa" } as const;
const dataBr = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });

export function Feriados() {
  const queryClient = useQueryClient();
  const anoAtual = Number(new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }).slice(0, 4));
  const [ano, setAno] = useState(anoAtual);
  const [escopo, setEscopo] = useState<"municipal" | "empresa">("municipal");
  const [erro, setErro] = useState<string | null>(null);
  const feriados = useQuery({ queryKey: ["admin", "feriados", ano], queryFn: () => listFeriados({ data: { ano } }) });
  const atualizar = () => queryClient.invalidateQueries({ queryKey: ["admin", "feriados"] });

  const adicionar = useMutation({
    mutationFn: (v: Parameters<typeof adicionarFeriado>[0]["data"]) => adicionarFeriado({ data: v }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });
  const remover = useMutation({
    mutationFn: (id: string) => removerFeriado({ data: { id } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });

  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    adicionar.mutate(
      {
        date: String(f.get("data")),
        name: String(f.get("nome")),
        scope: escopo,
        city: escopo === "municipal" ? String(f.get("cidade") ?? "") : null,
      },
      { onSuccess: () => form.reset() },
    );
  };

  return (
    <section className="space-y-4">
      <p className="text-muted">
        A IA não envia mensagens em fins de semana nem em feriados. Os nacionais (inclusive Carnaval) são calculados sozinhos;
        cadastre aqui os municipais e os da empresa.
      </p>
      {erro && <Aviso tipo="erro">{erro}</Aviso>}

      <form onSubmit={enviar} className="grid gap-2 rounded-lg border border-linha bg-superficie p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,12rem)_auto] sm:items-end">
        <label className="grid gap-1 text-sm">
          Data
          <input type="date" name="data" required className={campo} />
        </label>
        <label className="grid gap-1 text-sm">
          Nome
          <input name="nome" required minLength={2} maxLength={120} className={campo} />
        </label>
        <label className="grid gap-1 text-sm">
          Tipo
          <select value={escopo} onChange={(e) => setEscopo(e.target.value as "municipal" | "empresa")} className={campo}>
            <option value="municipal">Municipal</option>
            <option value="empresa">Da empresa</option>
          </select>
        </label>
        <label className={`grid gap-1 text-sm ${escopo === "municipal" ? "" : "invisible"}`}>
          Cidade
          <input name="cidade" defaultValue="Itajaí" required={escopo === "municipal"} className={campo} />
        </label>
        <button type="submit" disabled={adicionar.isPending} className={botaoPrimario}>
          Adicionar
        </button>
      </form>

      <div className="flex items-center gap-2">
        <button type="button" className={botaoSecundario} onClick={() => setAno(ano - 1)} aria-label="Ano anterior">
          ‹
        </button>
        <span className="font-semibold tabular-nums">{ano}</span>
        <button type="button" className={botaoSecundario} onClick={() => setAno(ano + 1)} aria-label="Próximo ano">
          ›
        </button>
      </div>

      {feriados.isPending && <Carregando rotulo="Carregando feriados" />}
      {feriados.isError && <Aviso tipo="erro">{mensagemDeErro(feriados.error)}</Aviso>}
      {feriados.data && (
        <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
          {feriados.data.map((h) => (
            <li key={`${h.scope}-${h.date}-${h.city ?? ""}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <span>
                <span className="tabular-nums">{dataBr(h.date)}</span>
                <span className="ml-3 font-medium">{h.name}</span>
                <span className="ml-2 text-xs text-muted">
                  {ESCOPO[h.scope]}
                  {h.city ? ` · ${h.city}` : ""}
                </span>
              </span>
              {h.id && (
                <button type="button" onClick={() => remover.mutate(h.id!)} disabled={remover.isPending} className={botaoSecundario}>
                  Remover
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
