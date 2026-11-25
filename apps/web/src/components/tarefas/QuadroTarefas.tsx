import { addDays } from "@omni/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, ListTree } from "lucide-react";
import { useState, type DragEvent } from "react";

import { concluirTarefa, moverTarefa, type ContextoTarefas, type Tarefa } from "../../lib/tarefas-fns.ts";

/**
 * Quadro das Tarefas — porta do `KanbanBoard` do Foco: no projeto, uma coluna
 * por seção (arrastar muda a seção); fora dele, Atrasadas, Hoje, Amanhã e
 * Próximas (arrastar muda a data; em Atrasadas não se solta). No celular e pelo
 * teclado, o "Mover para…" de cada cartão faz o mesmo.
 */

const COR_PRIORIDADE: Record<1 | 2 | 3 | 4, string> = { 1: "#d1453b", 2: "#eb8909", 3: "#246fe0", 4: "var(--color-linha)" };
const CORES_COLUNA = ["#246fe0", "#30503a", "#8a5cf6", "#eb8909"];

type Coluna = { id: string; titulo: string; cor: string; tarefas: Tarefa[]; destino: { data: string } | { secaoId: string | null } | null };

const curta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

export function QuadroTarefas({
  tarefas,
  ctx,
  projetoId,
  onAbrir,
  onAviso,
}: {
  tarefas: Tarefa[];
  ctx: ContextoTarefas;
  projetoId: string | null;
  onAbrir: (id: string) => void;
  onAviso: (msg: string) => void;
}) {
  const qc = useQueryClient();
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [alvo, setAlvo] = useState<string | null>(null);
  const projeto = projetoId ? ctx.projetos.find((p) => p.id === projetoId) : undefined;
  const depoisDeAmanha = addDays(ctx.hoje, 2);
  const colunas: Coluna[] = projeto
    ? [
        ...projeto.secoes.map((s, i) => ({ id: s.id, titulo: s.nome, cor: CORES_COLUNA[i % 4]!, tarefas: tarefas.filter((t) => t.secaoId === s.id), destino: { secaoId: s.id } })),
        { id: "sem-secao", titulo: "Sem seção", cor: "var(--color-muted)", tarefas: tarefas.filter((t) => !t.secaoId || !projeto.secoes.some((s) => s.id === t.secaoId)), destino: { secaoId: null } },
      ]
    : [
        { id: "atrasadas", titulo: "Atrasadas", cor: "#d1453b", tarefas: tarefas.filter((t) => t.data < ctx.hoje), destino: null },
        { id: "hoje", titulo: "Hoje", cor: "#30503a", tarefas: tarefas.filter((t) => t.data === ctx.hoje), destino: { data: ctx.hoje } },
        { id: "amanha", titulo: "Amanhã", cor: "#246fe0", tarefas: tarefas.filter((t) => t.data === ctx.amanha), destino: { data: ctx.amanha } },
        { id: "proximas", titulo: "Próximas", cor: "#8a5cf6", tarefas: tarefas.filter((t) => t.data > ctx.amanha), destino: { data: depoisDeAmanha } },
      ];

  const mover = useMutation({
    mutationFn: (v: { t: Tarefa; destino: { data: string } | { secaoId: string | null } }) =>
      moverTarefa({ data: { id: v.t.id, ...("data" in v.destino ? { data: v.destino.data } : { secaoId: v.destino.secaoId }) } }),
    onSuccess: (_r, v) => onAviso("data" in v.destino ? `"${v.t.titulo}" passou para ${curta(v.destino.data)}.` : "Tarefa movida."),
    onError: (e) => onAviso(e instanceof Error ? e.message : "Não foi possível mover a tarefa."),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["tarefas"] }),
  });
  const concluir = useMutation({
    mutationFn: (t: Tarefa) => concluirTarefa({ data: { id: t.id } }),
    onSuccess: (r, t) => onAviso(r.proximaData ? `"${t.titulo}" repete em ${curta(r.proximaData)}.` : `"${t.titulo}" concluída.`),
    onError: (e) => onAviso(e instanceof Error ? e.message : "Não foi possível concluir."),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["tarefas"] }),
  });

  const soltar = (c: Coluna) => (e: DragEvent) => {
    e.preventDefault();
    setAlvo(null);
    const id = e.dataTransfer.getData("text/plain") || arrastando;
    setArrastando(null);
    const t = tarefas.find((x) => x.id === id);
    if (!t || !c.destino || c.tarefas.some((x) => x.id === t.id)) return;
    mover.mutate({ t, destino: c.destino });
  };

  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3" aria-label="Quadro de tarefas">
      {colunas.map((c) => (
        <section
          key={c.id}
          aria-label={`${c.titulo} (${c.tarefas.length})`}
          onDragOver={(e) => {
            if (!c.destino) return;
            e.preventDefault();
            setAlvo(c.id);
          }}
          onDragLeave={() => setAlvo((a) => (a === c.id ? null : a))}
          onDrop={soltar(c)}
          className={`flex w-64 shrink-0 flex-col rounded-lg border bg-superficie-2 ${alvo === c.id ? "border-floresta" : "border-transparent"}`}
        >
          <header className="flex items-center gap-2 border-t-4 px-3 py-2 text-sm font-semibold" style={{ borderTopColor: c.cor, borderTopLeftRadius: 8, borderTopRightRadius: 8 }}>
            <span className="min-w-0 flex-1 truncate">{c.titulo}</span>
            <span className="text-xs font-normal text-muted">{c.tarefas.length}</span>
          </header>
          <ul className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {c.tarefas.map((t) => (
              <li
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", t.id);
                  e.dataTransfer.effectAllowed = "move";
                  setArrastando(t.id);
                }}
                onDragEnd={() => setArrastando(null)}
                className={`relative rounded-md border border-linha bg-superficie p-2 text-sm shadow-sm ${arrastando === t.id ? "opacity-50" : ""}`}
              >
                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => concluir.mutate(t)}
                    disabled={concluir.isPending}
                    aria-label={`Concluir "${t.titulo}"`}
                    className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 hover:bg-superficie-2"
                    style={{ borderColor: COR_PRIORIDADE[t.prioridade] }}
                  >
                    <Check size={10} className="opacity-0 hover:opacity-100" aria-hidden />
                  </button>
                  <button type="button" onClick={() => onAbrir(t.id)} className="min-w-0 flex-1 text-left">
                    <span className="block break-words">{t.titulo}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                      <span className={t.data < ctx.hoje ? "text-vermelho" : ""}>
                        {t.data === ctx.hoje ? "Hoje" : t.data === ctx.amanha ? "Amanhã" : curta(t.data)}
                        {t.hora ? ` · ${t.hora}` : ""}
                      </span>
                      {t.projeto && !projeto && (
                        <span className="flex items-center gap-1">
                          <i className="size-2 rounded-full" style={{ background: t.projeto.cor }} aria-hidden /> {t.projeto.nome}
                        </span>
                      )}
                      {t.responsavel && <span>{t.responsavel.nome.split(" ")[0]}</span>}
                      {t.subtarefas.total > 0 && (
                        <span className="flex items-center gap-0.5">
                          <ListTree size={12} aria-hidden /> {t.subtarefas.concluidas}/{t.subtarefas.total}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
                <label className="mt-1.5 flex items-center gap-1 text-xs text-muted">
                  <span className="sr-only">Mover "{t.titulo}" para</span>
                  <select
                    value=""
                    disabled={mover.isPending}
                    onChange={(e) => {
                      const destino = colunas.find((x) => x.id === e.target.value)?.destino;
                      if (destino) mover.mutate({ t, destino });
                    }}
                    className="w-full rounded-sm border border-linha bg-superficie px-1 py-0.5"
                  >
                    <option value="">Mover para…</option>
                    {colunas
                      .filter((x) => x.destino && x.id !== c.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.titulo}
                        </option>
                      ))}
                  </select>
                </label>
              </li>
            ))}
            {!c.tarefas.length && <li className="px-1 py-3 text-center text-xs text-muted">{c.destino ? "Solte aqui" : "Nada atrasado"}</li>}
          </ul>
        </section>
      ))}
    </div>
  );
}
