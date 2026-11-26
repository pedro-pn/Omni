import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { adicionarCaixa, ativarCaixa, listCaixas } from "../../lib/admin-fns.ts";
import { Aviso, botaoPrimario, botaoSecundario, campo, mensagemDeErro } from "./ui.tsx";
import { Carregando } from "../comum/Carregando.tsx";

const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "ainda não lida";

/** Caixas de e-mail que o Omni lê para ligar e-mails às missões (Fase 4). */
export function Caixas() {
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const caixas = useQuery({ queryKey: ["admin", "caixas"], queryFn: () => listCaixas() });
  const atualizar = () => queryClient.invalidateQueries({ queryKey: ["admin", "caixas"] });
  const adicionar = useMutation({
    mutationFn: (email: string) => adicionarCaixa({ data: { email } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });
  const ativar = useMutation({
    mutationFn: (v: { id: string; ativa: boolean }) => ativarCaixa({ data: v }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(mensagemDeErro(e)),
    onSettled: atualizar,
  });
  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    adicionar.mutate(String(new FormData(form).get("email")), { onSuccess: () => form.reset() });
  };

  return (
    <section className="space-y-4">
      <p className="text-muted">
        O Omni lê estas caixas e guarda só os e-mails que se ligam a alguma missão (número da missão, proposta, NF ou domínio do cliente). Cada caixa
        também precisa estar no grupo <b>Omni - Caixas</b> do Exchange; sem isso, ela aparece aqui com o erro.
      </p>
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      <form onSubmit={enviar} className="flex flex-wrap items-end gap-2 rounded-lg border border-linha bg-superficie p-4">
        <label className="grid min-w-64 flex-1 gap-1 text-sm">
          E-mail da caixa
          <input type="email" name="email" required placeholder="nome@filtrovali.com.br" className={campo} />
        </label>
        <button type="submit" disabled={adicionar.isPending} className={botaoPrimario}>
          Adicionar
        </button>
      </form>
      {caixas.isPending && <Carregando rotulo="Carregando caixas" />}
      {caixas.isError && <Aviso tipo="erro">{mensagemDeErro(caixas.error)}</Aviso>}
      {caixas.data && caixas.data.length === 0 && <p className="text-muted">Nenhuma caixa cadastrada.</p>}
      {caixas.data && caixas.data.length > 0 && (
        <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
          {caixas.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
              <span className="min-w-0">
                <span className={`font-medium ${c.ativa ? "" : "text-muted line-through"}`}>{c.email}</span>
                <span className="block text-xs text-muted">
                  {c.ativa ? `Última leitura: ${quando(c.ultimaLeitura)}` : "Desativada"}
                  {c.erro && <span className="text-vermelho"> · {c.erro}</span>}
                </span>
              </span>
              <button type="button" disabled={ativar.isPending} onClick={() => ativar.mutate({ id: c.id, ativa: !c.ativa })} className={botaoSecundario}>
                {c.ativa ? "Desativar" : "Reativar"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
