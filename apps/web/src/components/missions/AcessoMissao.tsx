import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, X } from "lucide-react";
import { useState } from "react";

import { acessoDaMissao, liberarMissao } from "../../lib/acesso-missao-fns.ts";

/** Diretoria e Administração: liberar a missão para quem não está associado a ela (0045). */
export function AcessoMissao({ missionId }: { missionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["acesso-missao", missionId], queryFn: () => acessoDaMissao({ data: { missionId } }) });
  const [busca, setBusca] = useState("");
  const mudar = useMutation({
    mutationFn: (v: { personId: string; liberar: boolean }) => liberarMissao({ data: { missionId, ...v } }),
    onSuccess: () => {
      setBusca("");
      void qc.invalidateQueries({ queryKey: ["acesso-missao", missionId] });
    },
  });
  if (!q.data?.podeLiberar) return null;
  const termo = busca.trim().toLowerCase();
  const ja = new Set(q.data.liberados.map((l) => l.id));
  const sugestoes = termo.length >= 2 ? q.data.pessoas.filter((p) => !ja.has(p.id) && (p.nome.toLowerCase().includes(termo) || p.email.toLowerCase().includes(termo))).slice(0, 6) : [];
  return (
    <section className="rounded-lg border border-linha bg-superficie p-5" aria-labelledby="titulo-acesso">
      <h3 id="titulo-acesso" className="flex items-center gap-2 font-semibold">
        <Eye size={16} aria-hidden className="text-floresta-texto" /> Acesso à missão
      </h3>
      <p className="mt-1 text-xs text-muted">
        Diretoria, Administração e Gerentes veem todas as missões. Os demais veem as missões a que estão associados: responsáveis e equipe no filtroAPP, membros do Interno ou do
        Gerencial e quem ocupa uma função chamada pela IA. Libere aqui quem mais precisa ver esta missão (só visualização: os canais seguem as regras deles).
      </p>
      {q.data.liberados.length > 0 && (
        <ul className="mt-3 divide-y divide-linha text-sm">
          {q.data.liberados.map((l) => (
            <li key={l.id} className="flex items-center gap-2 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{l.nome}</span>
                <span className="block truncate text-xs text-muted">
                  {l.email}
                  {l.por ? ` · liberado por ${l.por}` : ""}
                </span>
              </span>
              <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate({ personId: l.id, liberar: false })} aria-label={`Tirar o acesso de ${l.nome}`} className="rounded-md p-1 text-muted hover:bg-superficie-2 hover:text-vermelho">
                <X size={16} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="mt-3 block text-sm">
        <span className="sr-only">Liberar para</span>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Liberar para… (nome ou e-mail)" className="w-full rounded-md border border-linha bg-superficie px-2 py-1.5" />
      </label>
      {sugestoes.length > 0 && (
        <ul className="mt-1 rounded-md border border-linha text-sm">
          {sugestoes.map((p) => (
            <li key={p.id}>
              <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate({ personId: p.id, liberar: true })} className="block w-full px-3 py-1.5 text-left hover:bg-superficie-2">
                {p.nome} <span className="text-xs text-muted">· {p.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {mudar.isError && <p className="mt-2 text-sm text-vermelho">{mudar.error instanceof Error ? mudar.error.message : "Não foi possível mudar o acesso."}</p>}
    </section>
  );
}
