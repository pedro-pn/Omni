import { formatRecurrence, parseQuickInput, parseRecurrenceInput, recurrenceSuggestions } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CornerLeftUp, SmilePlus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  comentarTarefa,
  concluirTarefa,
  criarTarefa,
  editarComentario,
  editarTarefa,
  excluirComentario,
  EMOJIS_REACAO,
  excluirTarefa,
  obterTarefa,
  reabrirTarefa,
  reagirComentario,
  type ContextoTarefas,
  type DetalheTarefa as Detalhe,
} from "../../lib/tarefas-fns.ts";
import { AnexosDaTarefa } from "./AnexosDaTarefa.tsx";
import { dadosDoParser } from "./Tarefas.tsx";
import { Carregando } from "../comum/Carregando.tsx";

/** Abrir a tarefa: editar tudo, subtarefas, comentar (com @menção), ver o histórico e excluir. */

const quando = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");
const campo = "rounded-md border border-linha bg-superficie px-2 py-1.5 disabled:opacity-70";

export function DetalheTarefa({ id, ctx, meuId, onFechar }: { id: string; ctx: ContextoTarefas; meuId: string; onFechar: () => void }) {
  const dialogo = useRef<HTMLDialogElement>(null);
  // Navega entre a tarefa principal e as subtarefas sem fechar o diálogo.
  const [atual, setAtual] = useState(id);
  const detalhe = useQuery({ queryKey: ["tarefas", "detalhe", atual], queryFn: () => obterTarefa({ data: { id: atual } }) });

  useEffect(() => {
    dialogo.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialogo}
      aria-labelledby="tarefa-titulo"
      onCancel={(e) => {
        e.preventDefault();
        onFechar();
      }}
      className="m-auto max-h-[92dvh] w-[min(46rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-linha bg-superficie p-0 text-ink backdrop:bg-black/50"
    >
      <div className="flex max-h-[92dvh] flex-col">
        <header className="flex items-center gap-3 border-b border-linha px-5 py-3">
          <h2 id="tarefa-titulo" className="min-w-0 flex-1 truncate font-semibold">
            {detalhe.data?.tarefa.projeto?.nome ?? "Caixa pessoal"}
          </h2>
          <button type="button" onClick={onFechar} aria-label="Fechar" className="rounded-md p-1 hover:bg-superficie-2">
            <X size={20} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {detalhe.isError ? (
            <p role="alert" className="text-vermelho">
              {erroDe(detalhe.error)}
            </p>
          ) : !detalhe.data ? (
            <Carregando />
          ) : (
            <>
              {detalhe.data.tarefa.pai && (
                <button
                  type="button"
                  onClick={() => setAtual(detalhe.data.tarefa.pai!.id)}
                  className="mb-3 flex items-center gap-1.5 text-sm text-floresta-texto hover:underline"
                >
                  <CornerLeftUp size={15} aria-hidden /> Subtarefa de: {detalhe.data.tarefa.pai.titulo}
                </button>
              )}
              <Formulario key={detalhe.data.tarefa.id} d={detalhe.data} ctx={ctx} meuId={meuId} onExcluida={onFechar} />
              {!detalhe.data.tarefa.pai && <Subtarefas d={detalhe.data} ctx={ctx} onAbrir={setAtual} />}
              <AnexosDaTarefa key={`a-${detalhe.data.tarefa.id}`} tarefaId={detalhe.data.tarefa.id} />
              <Comentarios key={`c-${detalhe.data.tarefa.id}`} d={detalhe.data} ctx={ctx} meuId={meuId} />
              <details className="mt-5 text-sm">
                <summary className="cursor-pointer font-medium">Histórico ({detalhe.data.historico.length})</summary>
                <ul className="mt-2 grid gap-1.5 text-muted">
                  {detalhe.data.historico.map((h) => (
                    <li key={h.id}>
                      <span className="text-ink">{h.autor ?? "Omni"}</span> · {h.resumo} · {quando(h.em)}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

function Formulario({ d, ctx, meuId, onExcluida }: { d: Detalhe; ctx: ContextoTarefas; meuId: string; onExcluida: () => void }) {
  const queryClient = useQueryClient();
  const t = d.tarefa;
  const [projetoId, setProjetoId] = useState(t.projetoId ?? "");
  const [repeticao, setRepeticao] = useState(t.recorrencia ? formatRecurrence(t.recorrencia) : "");
  const [confirmarExclusao, setConfirmarExclusao] = useState(false);
  const projeto = ctx.projetos.find((p) => p.id === projetoId);
  const leitura = parseRecurrenceInput(repeticao);
  const bloqueado = !d.podeEditar;

  const salvar = useMutation({
    mutationFn: (f: FormData) => {
      const projetoEscolhido = String(f.get("projeto") || "") || null;
      return editarTarefa({
        data: {
          id: t.id,
          titulo: String(f.get("titulo")),
          descricao: String(f.get("descricao") ?? ""),
          data: String(f.get("data")),
          hora: String(f.get("hora") || "") || null,
          recorrencia: repeticao.trim() || null,
          prioridade: Number(f.get("prioridade")),
          etiquetas: String(f.get("etiquetas") ?? "")
            .split(",")
            .map((e) => e.trim().replace(/^@/, ""))
            .filter(Boolean),
          projetoId: projetoEscolhido,
          secaoId: projetoEscolhido ? String(f.get("secao") || "") || null : null,
          responsavelId: projetoEscolhido ? String(f.get("responsavel") || "") || null : null,
          lembreteMinutos: f.get("lembrete") === "" ? null : Number(f.get("lembrete")),
        },
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tarefas"] }),
  });
  const excluir = useMutation({
    mutationFn: () => excluirTarefa({ data: { id: t.id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
      onExcluida();
    },
  });

  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    salvar.mutate(new FormData(e.currentTarget));
  };

  return (
    <form onSubmit={enviar} className="grid gap-3 text-sm">
      {bloqueado && (
        <p className="rounded-md bg-superficie-2 px-3 py-2 text-muted">
          Só quem gerencia o projeto ou o responsável edita esta tarefa. Você pode comentar.
        </p>
      )}
      <fieldset disabled={bloqueado} className="grid gap-3">
        <label className="grid gap-1">
          Tarefa
          <input name="titulo" required maxLength={500} defaultValue={t.titulo} className={`${campo} text-base font-medium`} />
        </label>
        <label className="grid gap-1">
          Descrição
          <textarea name="descricao" rows={3} maxLength={5000} defaultValue={t.descricao} className={campo} />
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1">
            Data
            <input type="date" name="data" required defaultValue={t.data} className={campo} />
          </label>
          <label className="grid gap-1">
            Hora
            <input type="time" name="hora" defaultValue={t.hora ?? ""} className={campo} />
          </label>
          <label className="grid gap-1">
            Prioridade
            <select name="prioridade" defaultValue={t.prioridade} className={campo}>
              <option value={1}>P1 · urgente</option>
              <option value={2}>P2 · alta</option>
              <option value={3}>P3 · média</option>
              <option value={4}>P4 · normal</option>
            </select>
          </label>
        </div>
        <label className="grid gap-1">
          Repetição
          <input
            list="sugestoes-repeticao"
            value={repeticao}
            onChange={(e) => setRepeticao(e.target.value)}
            placeholder="Não repetir"
            maxLength={80}
            aria-describedby="repeticao-leitura"
            className={campo}
          />
          <datalist id="sugestoes-repeticao">
            {recurrenceSuggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <span id="repeticao-leitura" className={`text-xs ${leitura.valid ? "text-muted" : "text-vermelho"}`}>
            {repeticao.trim() ? (leitura.valid ? leitura.label : leitura.message) : "A tarefa não se repete."}
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="grid gap-1">
            Projeto
            <select name="projeto" value={projetoId} onChange={(e) => setProjetoId(e.target.value)} className={campo}>
              <option value="">Caixa pessoal</option>
              {ctx.projetos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            Seção
            <select name="secao" defaultValue={t.secaoId ?? ""} disabled={!projeto?.secoes.length} className={campo}>
              <option value="">Sem seção</option>
              {projeto?.secoes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.nome}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            Responsável
            <select
              name="responsavel"
              defaultValue={t.responsavelId ?? ""}
              disabled={!projeto}
              title={projeto ? undefined : "Na caixa pessoal a tarefa é sua."}
              className={campo}
            >
              <option value="">{projeto ? "Sem responsável" : "Você"}</option>
              {projeto?.membros.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nome}
                  {m.id === meuId ? " (você)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid gap-1">
          Lembrete no sino
          <select name="lembrete" defaultValue={t.lembreteMinutos ?? ""} className={campo}>
            <option value="">Sem lembrete</option>
            <option value={0}>Na hora{t.hora ? "" : " (09:00)"}</option>
            <option value={15}>15 minutos antes</option>
            <option value={30}>30 minutos antes</option>
            <option value={60}>1 hora antes</option>
            <option value={120}>2 horas antes</option>
            <option value={1440}>1 dia antes</option>
            {t.lembreteMinutos !== null && ![0, 15, 30, 60, 120, 1440].includes(t.lembreteMinutos) && (
              <option value={t.lembreteMinutos}>{t.lembreteMinutos} minutos antes</option>
            )}
          </select>
        </label>
        <label className="grid gap-1">
          Etiquetas
          <input name="etiquetas" defaultValue={t.etiquetas.join(", ")} placeholder="separe por vírgula" className={campo} />
        </label>
      </fieldset>
      {salvar.isError && (
        <p role="alert" className="text-vermelho">
          {erroDe(salvar.error)}
        </p>
      )}
      {salvar.isSuccess && !salvar.isPending && (
        <p role="status" className="text-floresta-texto">
          Alterações salvas.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!bloqueado && (
          <button
            type="submit"
            disabled={salvar.isPending || !leitura.valid}
            className="rounded-md bg-floresta px-4 py-1.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-50"
          >
            Salvar alterações
          </button>
        )}
        {d.podeExcluir && (
          <button
            type="button"
            onClick={() => (confirmarExclusao ? excluir.mutate() : setConfirmarExclusao(true))}
            disabled={excluir.isPending}
            className={`ml-auto flex items-center gap-1.5 rounded-md border px-3 py-1.5 ${confirmarExclusao ? "border-vermelho bg-vermelho text-white" : "border-linha text-vermelho hover:bg-superficie-2"}`}
          >
            <Trash2 size={15} aria-hidden /> {confirmarExclusao ? "Confirmar exclusão" : "Excluir tarefa"}
          </button>
        )}
      </div>
      {excluir.isError && (
        <p role="alert" className="text-vermelho">
          {erroDe(excluir.error)}
        </p>
      )}
    </form>
  );
}

const normalizar = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Destaca as menções (@Nome) de quem foi marcado. */
function comMencoes(texto: string, nomes: string[]): ReactNode {
  if (!nomes.length) return texto;
  const escapar = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const partes = texto.split(new RegExp(`(@(?:${nomes.map(escapar).join("|")}))`, "g"));
  return partes.map((parte, i) =>
    i % 2 === 1 ? (
      <b key={i} className="text-floresta-texto">
        {parte}
      </b>
    ) : (
      parte
    ),
  );
}

/** Reações do comentário (como no Foco): toque no emoji para pôr ou tirar a sua. */
function Reacoes({ comentarioId, tarefaId, reacoes }: { comentarioId: string; tarefaId: string; reacoes: Detalhe["comentarios"][number]["reacoes"] }) {
  const qc = useQueryClient();
  const [escolhendo, setEscolhendo] = useState(false);
  const reagir = useMutation({
    mutationFn: (emoji: (typeof EMOJIS_REACAO)[number]) => reagirComentario({ data: { comentarioId, emoji } }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["tarefas", "detalhe", tarefaId] }),
  });
  const escolher = (emoji: (typeof EMOJIS_REACAO)[number]) => {
    setEscolhendo(false);
    reagir.mutate(emoji);
  };
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {reacoes.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => escolher(r.emoji)}
          disabled={reagir.isPending}
          title={r.pessoas.join(", ")}
          aria-pressed={r.minha}
          aria-label={`${r.emoji} ${r.pessoas.length}: ${r.pessoas.join(", ")}`}
          className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${r.minha ? "border-floresta bg-floresta-clara text-floresta-texto" : "border-linha bg-superficie"}`}
        >
          <span aria-hidden>{r.emoji}</span> {r.pessoas.length}
        </button>
      ))}
      <span className="relative">
        <button
          type="button"
          onClick={() => setEscolhendo(!escolhendo)}
          aria-label="Reagir"
          aria-expanded={escolhendo}
          className="flex size-6 items-center justify-center rounded-full text-muted hover:bg-superficie hover:text-ink"
        >
          <SmilePlus size={14} aria-hidden />
        </button>
        {escolhendo && (
          <span role="menu" className="absolute bottom-full left-0 z-10 mb-1 flex gap-0.5 rounded-full border border-linha bg-superficie p-1 shadow-md">
            {EMOJIS_REACAO.map((e) => (
              <button key={e} type="button" role="menuitem" onClick={() => escolher(e)} className="rounded-full px-1.5 py-0.5 text-base hover:bg-superficie-2" aria-label={`Reagir com ${e}`}>
                {e}
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  );
}

function Comentarios({ d, ctx, meuId }: { d: Detalhe; ctx: ContextoTarefas; meuId: string }) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");
  const [editando, setEditando] = useState<{ id: string; texto: string } | null>(null);
  const [marcados, setMarcados] = useState<Map<string, string>>(new Map());
  const [busca, setBusca] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const caixa = useRef<HTMLTextAreaElement>(null);
  // Quem pode ser marcado: quem enxerga a tarefa (membros do projeto; na caixa pessoal, ninguém).
  const candidatos = useMemo(
    () => (ctx.projetos.find((p) => p.id === d.tarefa.projetoId)?.membros ?? []).filter((m) => m.id !== meuId),
    [ctx, d.tarefa.projetoId, meuId],
  );
  const sugestoes = busca === null ? [] : candidatos.filter((m) => normalizar(m.nome).includes(normalizar(busca))).slice(0, 6);
  const atualizar = () => void queryClient.invalidateQueries({ queryKey: ["tarefas", "detalhe", d.tarefa.id] });
  const comentar = useMutation({
    mutationFn: () =>
      comentarTarefa({
        data: { tarefaId: d.tarefa.id, texto, mencoes: [...marcados].filter(([, nome]) => texto.includes(`@${nome}`)).map(([id]) => id) },
      }),
    onSuccess: ({ foraDaTarefa }) => {
      setTexto("");
      setMarcados(new Map());
      setAviso(foraDaTarefa ? `${foraDaTarefa} pessoa(s) marcada(s) não enxerga(m) esta tarefa e não foi(ram) avisada(s).` : null);
      atualizar();
    },
  });
  const digitar = (valor: string) => {
    setTexto(valor);
    const ate = valor.slice(0, caixa.current?.selectionStart ?? valor.length);
    const m = ate.match(/(?:^|\s)@([\p{L}]*)$/u);
    setBusca(m && candidatos.length ? m[1]! : null);
  };
  const escolher = (pessoa: { id: string; nome: string }) => {
    const pos = caixa.current?.selectionStart ?? texto.length;
    const antes = texto.slice(0, pos).replace(/@([\p{L}]*)$/u, `@${pessoa.nome} `);
    setTexto(antes + texto.slice(pos));
    setMarcados((m) => new Map(m).set(pessoa.id, pessoa.nome));
    setBusca(null);
    caixa.current?.focus();
  };
  const salvarEdicao = useMutation({
    mutationFn: (e: { id: string; texto: string }) => editarComentario({ data: e }),
    onSuccess: () => {
      setEditando(null);
      atualizar();
    },
  });
  const apagar = useMutation({ mutationFn: (id: string) => excluirComentario({ data: { id } }), onSuccess: atualizar });
  const erro = comentar.error ?? salvarEdicao.error ?? apagar.error;

  return (
    <section aria-labelledby="comentarios-titulo" className="mt-6 text-sm">
      <h3 id="comentarios-titulo" className="font-medium">
        Comentários ({d.comentarios.length})
      </h3>
      <ul className="mt-2 grid gap-2">
        {d.comentarios.map((c) => (
          <li key={c.id} className="rounded-md bg-superficie-2 px-3 py-2">
            <p className="text-xs text-muted">
              <span className="font-medium text-ink">{c.autor.nome}</span> · {quando(c.criadoEm)}
              {c.editadoEm ? " · editado" : ""}
            </p>
            {editando?.id === c.id ? (
              <form
                className="mt-1 grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  salvarEdicao.mutate(editando);
                }}
              >
                <textarea
                  value={editando.texto}
                  onChange={(e) => setEditando({ id: c.id, texto: e.target.value })}
                  rows={2}
                  required
                  maxLength={5000}
                  aria-label="Editar comentário"
                  className={campo}
                />
                <div className="flex gap-2">
                  <button type="submit" disabled={salvarEdicao.isPending} className="rounded-md bg-floresta px-3 py-1 text-white">
                    Salvar
                  </button>
                  <button type="button" onClick={() => setEditando(null)} className="rounded-md border border-linha px-3 py-1">
                    Cancelar
                  </button>
                </div>
              </form>
            ) : (
              <p className="mt-0.5 whitespace-pre-wrap break-words">{comMencoes(c.texto, c.mencoes.map((m) => m.nome))}</p>
            )}
            {editando?.id !== c.id && <Reacoes comentarioId={c.id} tarefaId={d.tarefa.id} reacoes={c.reacoes} />}
            {c.autor.id === meuId && editando?.id !== c.id && (
              <p className="mt-1 flex gap-3 text-xs">
                <button type="button" onClick={() => setEditando({ id: c.id, texto: c.texto })} className="text-floresta-texto underline">
                  Editar
                </button>
                <button type="button" onClick={() => apagar.mutate(c.id)} className="text-vermelho underline">
                  Apagar
                </button>
              </p>
            )}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (texto.trim()) comentar.mutate();
        }}
      >
        <label className="relative grid gap-1">
          <span className="sr-only">Novo comentário</span>
          <textarea
            ref={caixa}
            value={texto}
            onChange={(e) => digitar(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && busca !== null) {
                e.stopPropagation();
                setBusca(null);
              }
            }}
            rows={2}
            maxLength={5000}
            placeholder={candidatos.length ? "Escreva um comentário… (@ para marcar alguém)" : "Escreva um comentário…"}
            className={campo}
          />
          {sugestoes.length > 0 && (
            <ul aria-label="Marcar pessoa" className="absolute left-0 top-full z-10 mt-1 w-64 rounded-md border border-linha bg-superficie shadow-lg">
              {sugestoes.map((m) => (
                <li key={m.id}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => escolher(m)} className="w-full px-3 py-1.5 text-left hover:bg-superficie-2">
                    {m.nome}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </label>
        <button
          type="submit"
          disabled={!texto.trim() || comentar.isPending}
          className="justify-self-start rounded-md border border-floresta px-3 py-1.5 font-medium text-floresta-texto hover:bg-floresta-clara disabled:opacity-50"
        >
          Comentar
        </button>
      </form>
      {aviso && (
        <p role="status" className="mt-2 text-muted">
          {aviso}
        </p>
      )}
      {erro && (
        <p role="alert" className="mt-2 text-vermelho">
          {erroDe(erro)}
        </p>
      )}
    </section>
  );
}

function Subtarefas({ d, ctx, onAbrir }: { d: Detalhe; ctx: ContextoTarefas; onAbrir: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");
  const atualizar = () => void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
  const alternar = useMutation({
    mutationFn: async (s: { id: string; concluida: boolean }) => {
      if (s.concluida) await reabrirTarefa({ data: { id: s.id } });
      else await concluirTarefa({ data: { id: s.id } });
    },
    onSuccess: atualizar,
  });
  const criar = useMutation({
    mutationFn: () => {
      // Mesma sintaxe da captura (data, hora, +pessoa, p1–p4); o lugar é sempre o da tarefa principal.
      const { projetos, secoes, membros } = dadosDoParser(ctx);
      const p = parseQuickInput(texto, projetos, secoes, membros, { dueDate: d.tarefa.data, priority: 4, projectId: d.tarefa.projetoId ?? "" }, ctx.hoje, ctx.amanha);
      return criarTarefa({
        data: {
          paiId: d.tarefa.id,
          titulo: p.content,
          projetoId: d.tarefa.projetoId,
          secaoId: d.tarefa.secaoId,
          data: p.dueDate ?? d.tarefa.data,
          hora: p.dueTime,
          recorrencia: null,
          prioridade: p.priority,
          etiquetas: p.labels,
          responsavelEmail: p.assigneeEmail,
        },
      });
    },
    onSuccess: () => {
      setTexto("");
      atualizar();
    },
  });
  const feitas = d.subtarefas.filter((s) => s.concluida).length;

  return (
    <section aria-labelledby="subtarefas-titulo" className="mt-6 text-sm">
      <h3 id="subtarefas-titulo" className="font-medium">
        Subtarefas{d.subtarefas.length ? ` (${feitas}/${d.subtarefas.length})` : ""}
      </h3>
      <ul className="mt-2 grid gap-1">
        {d.subtarefas.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => alternar.mutate(s)}
              disabled={alternar.isPending}
              aria-label={`${s.concluida ? "Reabrir" : "Concluir"}: ${s.titulo}`}
              className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${s.concluida ? "border-floresta bg-floresta text-white" : "border-lilas"}`}
            >
              {s.concluida && <Check size={10} aria-hidden />}
            </button>
            <button type="button" onClick={() => onAbrir(s.id)} className={`min-w-0 flex-1 truncate text-left hover:underline ${s.concluida ? "text-muted line-through" : ""}`}>
              {s.titulo}
            </button>
            <span className="shrink-0 text-xs text-muted">
              {s.data.split("-").reverse().slice(0, 2).join("/")}
              {s.responsavel ? ` · ${s.responsavel.split(" ")[0]}` : ""}
            </span>
          </li>
        ))}
      </ul>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (texto.trim()) criar.mutate();
        }}
      >
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          maxLength={500}
          placeholder="Nova subtarefa (ex.: Separar as fotos amanhã +pessoa)"
          aria-label="Nova subtarefa"
          className={`${campo} min-w-0 flex-1`}
        />
        <button type="submit" disabled={!texto.trim() || criar.isPending} className="rounded-md border border-floresta px-3 font-medium text-floresta-texto hover:bg-floresta-clara disabled:opacity-50">
          Adicionar
        </button>
      </form>
      {(criar.error ?? alternar.error) && (
        <p role="alert" className="mt-2 text-vermelho">
          {erroDe(criar.error ?? alternar.error)}
        </p>
      )}
    </section>
  );
}
