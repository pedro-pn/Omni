import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { atribuirFuncao, encerrarAtribuicao, listFuncoes, listPessoas, type FuncaoAdmin } from "../../lib/admin-fns.ts";
import { Aviso, botaoPrimario, botaoSecundario, campo, mensagemDeErro } from "./ui.tsx";

const dataBr = (iso: string) => iso.split("-").reverse().join("/");
const hoje = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

function NovaAtribuicao({ funcao, onSalvo }: { funcao: FuncaoAdmin; onSalvo: () => void }) {
  const pessoas = useQuery({ queryKey: ["admin", "pessoas"], queryFn: () => listPessoas() });
  const [erro, setErro] = useState<string | null>(null);
  const salvar = useMutation({
    mutationFn: (v: Parameters<typeof atribuirFuncao>[0]["data"]) => atribuirFuncao({ data: v }),
    onSuccess: onSalvo,
    onError: (e) => setErro(mensagemDeErro(e)),
  });

  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErro(null);
    const form = e.currentTarget;
    const f = new FormData(form);
    salvar.mutate(
      {
        functionCode: funcao.code,
        personId: String(f.get("pessoa")),
        startsOn: String(f.get("inicio")),
        endsOn: f.get("fim") ? String(f.get("fim")) : null,
        isSubstitute: f.get("substituto") === "on",
      },
      { onSuccess: () => form.reset() },
    );
  };

  const ativas = pessoas.data?.filter((p) => p.active && p.perfis.length > 0) ?? [];
  return (
    <form onSubmit={enviar} className="mt-3 grid gap-2 border-t border-linha pt-3 sm:grid-cols-[1fr_auto_auto_auto_auto] sm:items-end">
      <label className="grid gap-1 text-sm">
        Pessoa
        <select name="pessoa" required className={campo} defaultValue="">
          <option value="" disabled>
            Escolha…
          </option>
          {ativas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        Desde
        <input type="date" name="inicio" required defaultValue={hoje()} className={campo} />
      </label>
      <label className="grid gap-1 text-sm">
        Até (opcional)
        <input type="date" name="fim" className={campo} />
      </label>
      <label className="flex items-center gap-2 pb-2 text-sm">
        <input type="checkbox" name="substituto" /> Substituto
      </label>
      <button type="submit" disabled={salvar.isPending} className={botaoPrimario}>
        Atribuir
      </button>
      {erro && (
        <div className="sm:col-span-5">
          <Aviso tipo="erro">{erro}</Aviso>
        </div>
      )}
    </form>
  );
}

export function Funcoes() {
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const funcoes = useQuery({ queryKey: ["admin", "funcoes"], queryFn: () => listFuncoes() });
  const atualizar = () => queryClient.invalidateQueries({ queryKey: ["admin", "funcoes"] });
  const encerrar = useMutation({
    mutationFn: (id: string) => encerrarAtribuicao({ data: { id } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });

  if (funcoes.isPending) return <p className="text-muted">Carregando funções…</p>;
  if (funcoes.isError) return <Aviso tipo="erro">{mensagemDeErro(funcoes.error)}</Aviso>;

  return (
    <section className="space-y-4">
      <p className="text-muted">
        A IA e os avisos do Omni chamam funções, não pessoas. Defina quem ocupa cada função; na ausência, use um substituto
        com data de início e fim.
      </p>
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {funcoes.data.map((f) => (
        <article key={f.code} className="rounded-lg border border-linha bg-superficie p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">{f.name}</h2>
            {f.atribuicoes.length === 0 && <span className="text-sm text-vermelho">Função vaga</span>}
          </div>
          {f.description && <p className="text-sm text-muted">{f.description}</p>}
          {f.atribuicoes.length > 0 && (
            <ul className="mt-3 space-y-2">
              {f.atribuicoes.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-superficie-2 px-3 py-2">
                  <span>
                    <span className="font-medium">{a.pessoa}</span>
                    {a.isSubstitute && <span className="ml-2 text-xs text-muted">substituto</span>}
                    <span className="ml-2 text-sm text-muted">
                      desde {dataBr(a.startsOn)}
                      {a.endsOn ? ` até ${dataBr(a.endsOn)}` : ""}
                    </span>
                  </span>
                  <button type="button" onClick={() => encerrar.mutate(a.id)} disabled={encerrar.isPending} className={botaoSecundario}>
                    Encerrar
                  </button>
                </li>
              ))}
            </ul>
          )}
          <NovaAtribuicao funcao={f} onSalvo={atualizar} />
        </article>
      ))}
    </section>
  );
}
