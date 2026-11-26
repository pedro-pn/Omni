import { formatRecurrence, matchBatchPeople, parseQuickInput, type SmartToken } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, CalendarDays, CalendarRange, Check, Columns3, Filter, List, FolderPlus, Inbox, ListPlus, ListTree, Pencil, Plus, Repeat, Send, Star, Tag, Trash2, UserCheck, UserPlus, Users } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  adicionarMembro,
  alterarSecao,
  concluirTarefa,
  criarSecao,
  contextoTarefas,
  criarProjeto,
  criarTarefa,
  delegarTarefas,
  excluirFiltro,
  listarTarefas,
  salvarFiltro,
  reabrirTarefa,
  type ContextoTarefas,
  type Tarefa,
  type VistaTarefas,
} from "../../lib/tarefas-fns.ts";
import { MesTarefas, SemanaTarefas, type LayoutTarefas } from "./CalendarioTarefas.tsx";
import { QuadroTarefas } from "./QuadroTarefas.tsx";
import { DetalheTarefa } from "./DetalheTarefa.tsx";
import { LoteTarefas } from "./LoteTarefas.tsx";
import { Carregando } from "../comum/Carregando.tsx";

/**
 * Tarefas (Fase 3): o Foco dentro do Omni. Captura rápida com a mesma sintaxe
 * do Foco (parser portado em @omni/core): +pessoa, #projeto, /seção, @etiqueta,
 * datas em português, "às 15h", p1–p4 e repetições ("toda segunda").
 */

export const CHAVE_CONTEXTO = ["tarefas", "contexto"] as const;
const chaveLista = (vista: VistaTarefas, concluidas: boolean) => ["tarefas", "lista", vista, concluidas] as const;

// Cores de prioridade do Foco (e do protótipo).
const COR_PRIORIDADE: Record<1 | 2 | 3 | 4, string> = { 1: "#d1453b", 2: "#eb8909", 3: "#246fe0", 4: "var(--lilas)" };

const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");

function nomeDaVista(vista: VistaTarefas, ctx: ContextoTarefas | undefined) {
  if (vista.tipo === "minhas") return "Minhas tarefas";
  if (vista.tipo === "delegadas") return "Delegadas por mim";
  if (vista.tipo === "filtro") return ctx?.filtros.find((f) => f.id === vista.id)?.nome ?? "Filtro";
  if (vista.tipo === "etiqueta") return `@${vista.nome}`;
  return ctx?.projetos.find((p) => p.id === vista.id)?.nome ?? "Projeto";
}

const idDaVista = (v: VistaTarefas) => (v.tipo === "projeto" || v.tipo === "filtro" ? v.id : v.tipo === "etiqueta" ? `@${v.nome.toLocaleLowerCase("pt-BR")}` : null);
const mesmaVista = (a: VistaTarefas, b: VistaTarefas) => a.tipo === b.tipo && idDaVista(a) === idDaVista(b);

// ---------------------------------------------------------------- coluna da lista

export function TarefasNav({
  ctx,
  vista,
  onVista,
  busca,
}: {
  ctx: ContextoTarefas;
  vista: VistaTarefas | null;
  onVista: (v: VistaTarefas) => void;
  busca: string;
}) {
  const termo = busca.trim().toLowerCase();
  const filtrados = termo ? ctx.projetos.filter((p) => p.nome.toLowerCase().includes(termo)) : ctx.projetos;
  const projetos = filtrados.filter((p) => !p.missionId);
  // Projeto de missão só aparece aqui quando tem tarefa aberta (ou está aberto); o caminho natural é a aba Tarefas da missão.
  const etiquetas = termo ? ctx.etiquetas.filter((e) => e.nome.toLowerCase().includes(termo.replace(/^@/, ""))) : ctx.etiquetas;
  const missoes = filtrados.filter((p) => p.missionId && (p.abertas > 0 || (vista?.tipo === "projeto" && vista.id === p.id)));
  const item = (v: VistaTarefas, rotulo: string, extra: ReactNode, icone: ReactNode) => {
    const ativa = vista !== null && mesmaVista(vista, v);
    return (
      <li key={idDaVista(v) ?? v.tipo}>
        <button
          type="button"
          onClick={() => onVista(v)}
          aria-current={ativa ? "true" : undefined}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-superficie-2 ${ativa ? "bg-floresta-clara" : ""}`}
        >
          {icone}
          <span className="min-w-0 flex-1 truncate">{rotulo}</span>
          {extra}
        </button>
      </li>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ul className="flex-1 overflow-y-auto pb-4">
        {item(
          { tipo: "minhas" },
          "Minhas tarefas",
          <span className="flex items-center gap-1.5 text-sm">
            {ctx.atrasadas > 0 && (
              <span className="rounded-full bg-vermelho px-1.5 text-xs font-semibold text-white" title="Atrasadas">
                {ctx.atrasadas}
              </span>
            )}
            <span className="text-muted">{ctx.minhas}</span>
          </span>,
          <Inbox size={18} className="text-floresta-texto" aria-hidden />,
        )}
        {item({ tipo: "delegadas" }, "Delegadas por mim", null, <Send size={18} className="text-floresta-texto" aria-hidden />)}
        {[...ctx.filtros]
          .sort((a, b) => Number(b.favorito) - Number(a.favorito))
          .filter((f) => !termo || f.nome.toLowerCase().includes(termo))
          .map((f) =>
            item(
              { tipo: "filtro", id: f.id },
              f.nome,
              f.favorito ? <Star size={14} className="text-muted" aria-label="Favorito" /> : null,
              <Filter size={18} className="text-floresta-texto" aria-hidden />,
            ),
          )}
        <li>
          <NovoFiltro ctx={ctx} onCriado={(id) => onVista({ tipo: "filtro", id })} />
        </li>
        {etiquetas.length > 0 && (
          <li>
            <p className="rotulo px-4 pb-1 pt-4 text-muted" title="Cada @etiqueta das suas tarefas abertas vira uma pasta">
              Etiquetas
            </p>
          </li>
        )}
        {etiquetas.map((e) =>
          item(
            { tipo: "etiqueta", nome: e.nome },
            `@${e.nome}`,
            <span className="text-sm text-muted">{e.abertas}</span>,
            <Tag size={18} className="text-floresta-texto" aria-hidden />,
          ),
        )}
        <li>
          <p className="rotulo px-4 pb-1 pt-4 text-muted">Projetos</p>
        </li>
        {projetos.map((p) =>
          item(
            { tipo: "projeto", id: p.id },
            p.nome,
            <span className="text-sm text-muted">{p.abertas || ""}</span>,
            <span className="ml-1 size-2.5 shrink-0 rounded-full" style={{ background: p.cor }} aria-hidden />,
          ),
        )}
        {projetos.length === 0 && (
          <li className="px-4 py-2 text-sm text-muted">{termo ? "Nenhum projeto encontrado." : "Nenhum projeto ainda."}</li>
        )}
        {missoes.length > 0 && (
          <li>
            <p className="rotulo px-4 pb-1 pt-4 text-muted">Missões</p>
          </li>
        )}
        {missoes.map((p) =>
          item(
            { tipo: "projeto", id: p.id },
            p.nome,
            <span className="text-sm text-muted">{p.abertas || ""}</span>,
            <span className="ml-1 size-2.5 shrink-0 rounded-full" style={{ background: p.cor }} aria-hidden />,
          ),
        )}
      </ul>
      <NovoProjeto onCriado={(id) => onVista({ tipo: "projeto", id })} />
    </div>
  );
}

// ---------------------------------------------------------------- filtros salvos (como no Foco)

/** Monta a consulta como o Foco: cada campo escolhido vira uma condição, juntas com "&". */
function NovoFiltro({ ctx, onCriado }: { ctx: ContextoTarefas; onCriado: (id: string) => void }) {
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [campos, setCampos] = useState({ nome: "", prazo: "", prioridade: "", projeto: "", pessoa: "", etiqueta: "", texto: "", favorito: false });
  const projeto = ctx.projetos.find((p) => p.id === campos.projeto);
  const pessoa = ctx.pessoas.find((p) => p.id === campos.pessoa);
  const consulta = [campos.prazo, campos.prioridade, projeto ? `#${projeto.nome}` : "", pessoa ? `+${pessoa.email}` : "", campos.etiqueta.trim() ? `@${campos.etiqueta.trim().replace(/^@/, "")}` : "", campos.texto.trim()]
    .filter(Boolean)
    .join(" & ");
  const salvar = useMutation({
    mutationFn: () => salvarFiltro({ data: { nome: campos.nome, consulta, favorito: campos.favorito } }),
    onSuccess: async ({ id }) => {
      await qc.invalidateQueries({ queryKey: CHAVE_CONTEXTO });
      setAberto(false);
      setCampos({ nome: "", prazo: "", prioridade: "", projeto: "", pessoa: "", etiqueta: "", texto: "", favorito: false });
      onCriado(id);
    },
  });
  if (!aberto) {
    return (
      <button type="button" onClick={() => setAberto(true)} className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-muted hover:bg-superficie-2 hover:text-ink">
        <Plus size={16} aria-hidden /> Novo filtro
      </button>
    );
  }
  const campo = "rounded-md border border-linha bg-superficie px-2 py-1.5";
  const muda = (k: keyof typeof campos) => (e: { target: { value: string } }) => setCampos((c) => ({ ...c, [k]: e.target.value }));
  return (
    <form
      className="mx-3 my-2 grid gap-2 rounded-md border border-linha p-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        salvar.mutate();
      }}
    >
      <label className="grid gap-1">
        Nome do filtro
        <input value={campos.nome} onChange={muda("nome")} required maxLength={80} autoFocus placeholder="Ex.: Prioridades de hoje" className={campo} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1">
          Prazo
          <select value={campos.prazo} onChange={muda("prazo")} className={campo}>
            <option value="">Qualquer prazo</option>
            <option value="hoje">Hoje</option>
            <option value="atrasada">Atrasadas</option>
            <option value="7 dias">Próximos 7 dias</option>
          </select>
        </label>
        <label className="grid gap-1">
          Prioridade
          <select value={campos.prioridade} onChange={muda("prioridade")} className={campo}>
            <option value="">Todas</option>
            <option value="p1">Prioridade 1</option>
            <option value="p2">Prioridade 2</option>
            <option value="p3">Prioridade 3</option>
            <option value="p4">Prioridade 4</option>
          </select>
        </label>
        <label className="grid gap-1">
          Projeto
          <select value={campos.projeto} onChange={muda("projeto")} className={campo}>
            <option value="">Todos</option>
            {ctx.projetos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          Responsável
          <select value={campos.pessoa} onChange={muda("pessoa")} className={campo}>
            <option value="">Qualquer pessoa</option>
            {ctx.pessoas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          Etiqueta
          <input value={campos.etiqueta} onChange={muda("etiqueta")} maxLength={60} placeholder="Ex.: campo" className={campo} />
        </label>
        <label className="grid gap-1">
          Texto
          <input value={campos.texto} onChange={muda("texto")} maxLength={120} placeholder="No título ou na descrição" className={campo} />
        </label>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={campos.favorito} onChange={(e) => setCampos((c) => ({ ...c, favorito: e.target.checked }))} /> Mostrar no topo
      </label>
      {consulta && <p className="break-words text-xs text-muted">Condições: {consulta}</p>}
      {salvar.isError && (
        <p role="alert" className="text-vermelho">
          {erroDe(salvar.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={!campos.nome.trim() || !consulta || salvar.isPending} className="rounded-md bg-floresta px-3 py-1.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-50">
          Salvar filtro
        </button>
        <button type="button" onClick={() => setAberto(false)} className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2">
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** Na visão do filtro: mostra as condições e permite apagar. */
function CabecalhoFiltro({ ctx, id, aoApagar }: { ctx: ContextoTarefas; id: string; aoApagar: () => void }) {
  const qc = useQueryClient();
  const f = ctx.filtros.find((x) => x.id === id);
  const apagar = useMutation({
    mutationFn: () => excluirFiltro({ data: { id } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: CHAVE_CONTEXTO });
      aoApagar();
    },
  });
  if (!f) return null;
  return (
    <div className="flex items-center gap-2 border-b border-linha bg-superficie px-4 py-2 text-sm">
      <Filter size={14} aria-hidden className="shrink-0 text-muted" />
      <code className="min-w-0 flex-1 truncate text-muted" title={f.consulta}>
        {f.consulta}
      </code>
      <button type="button" disabled={apagar.isPending} onClick={() => confirm(`Apagar o filtro "${f.nome}"?`) && apagar.mutate()} className="shrink-0 text-vermelho hover:underline">
        Apagar filtro
      </button>
    </div>
  );
}

function NovoProjeto({ onCriado }: { onCriado: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const criar = useMutation({
    mutationFn: (nome: string) => criarProjeto({ data: { nome } }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: CHAVE_CONTEXTO });
      setAberto(false);
      onCriado(id);
    },
  });
  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="m-3 flex items-center justify-center gap-2 rounded-md border border-linha px-3 py-2 text-sm hover:bg-superficie-2"
      >
        <FolderPlus size={16} aria-hidden /> Novo projeto
      </button>
    );
  }
  return (
    <form
      className="m-3 grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        criar.mutate(String(new FormData(e.currentTarget).get("nome")));
      }}
    >
      <label className="grid gap-1 text-sm">
        Nome do projeto
        <input name="nome" required maxLength={120} autoFocus className="rounded-md border border-linha bg-superficie px-2 py-1.5" />
      </label>
      {criar.isError && (
        <p role="alert" className="text-sm text-vermelho">
          {erroDe(criar.error)}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={criar.isPending} className="rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white hover:bg-floresta-escura">
          Criar projeto
        </button>
        <button type="button" onClick={() => setAberto(false)} className="rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2">
          Cancelar
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- centro

/** Projetos, seções e pessoas no formato do parser do Foco (smart-parse). */
export function dadosDoParser(ctx: ContextoTarefas) {
  const vistos = new Map<string, { name: string; email: string }>();
  for (const p of ctx.projetos) for (const m of p.membros) vistos.set(m.email, { name: m.nome, email: m.email });
  return {
    projetos: ctx.projetos.map((p) => ({ id: p.id, name: p.nome })),
    secoes: ctx.projetos.flatMap((p) => p.secoes.map((s) => ({ id: s.id, name: s.nome, projectId: p.id }))),
    membros: [...vistos.values()],
  };
}

function CapturaRapida({ ctx, vista }: { ctx: ContextoTarefas; vista: VistaTarefas }) {
  const queryClient = useQueryClient();
  const [texto, setTexto] = useState("");
  const projetoPadrao = vista.tipo === "projeto" ? vista.id : "";

  const { projetos, secoes, membros } = useMemo(() => dadosDoParser(ctx), [ctx]);

  const previa = useMemo(
    () =>
      texto.trim()
        ? parseQuickInput(texto, projetos, secoes, membros, { dueDate: ctx.hoje, priority: 4, projectId: projetoPadrao }, ctx.hoje, ctx.amanha)
        : null,
    [texto, projetos, secoes, membros, ctx.hoje, ctx.amanha, projetoPadrao],
  );

  // "+nome" de alguém do Omni que não é membro: o parser (como no Foco) só
  // reconhece membros, e a tarefa ficaria com quem escreveu sem aviso.
  const naoMembro = useMemo(() => {
    if (!previa || previa.assigneeEmail) return null;
    const depois = previa.content.match(/(?:^|\s)\+([\p{L}.-]+(?:\s+[\p{L}.-]+){0,2})/u)?.[1];
    if (!depois) return null;
    const palavras = depois.split(/\s+/);
    const pessoas = ctx.pessoas.map((p) => ({ name: p.nome, email: p.email }));
    // A mais longa sequência de até 3 palavras que aponta uma pessoa só.
    for (let n = palavras.length; n >= 1; n -= 1) {
      const achados = matchBatchPeople(pessoas, palavras.slice(0, n).join(" "));
      if (achados.length === 1) return achados[0]!.name;
    }
    return `+${palavras[0]}`;
  }, [previa, ctx.pessoas]);

  const criar = useMutation({
    mutationFn: () => {
      const p = previa!;
      return criarTarefa({
        data: {
          titulo: p.content,
          projetoId: p.projectId,
          secaoId: p.sectionId ?? null,
          data: p.dueDate ?? ctx.hoje,
          hora: p.dueTime,
          recorrencia: p.recurrence,
          prioridade: p.priority,
          // Na pasta de uma etiqueta, a tarefa nova já entra nela.
          etiquetas:
            vista.tipo === "etiqueta" && !p.labels.some((l) => l.toLocaleLowerCase("pt-BR") === vista.nome.toLocaleLowerCase("pt-BR"))
              ? [...p.labels, vista.nome]
              : p.labels,
          responsavelEmail: p.assigneeEmail,
        },
      });
    },
    onSuccess: () => {
      setTexto("");
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });

  const enviar = (e: FormEvent) => {
    e.preventDefault();
    if (previa?.content && !naoMembro) criar.mutate();
  };

  return (
    <form onSubmit={enviar} className="border-b border-linha bg-superficie px-4 py-3">
      <label htmlFor="captura" className="sr-only">
        Nova tarefa
      </label>
      <div className="flex gap-2">
        <input
          id="captura"
          value={texto}
          onChange={(e) => {
            setTexto(e.target.value);
            if (criar.isError) criar.reset();
          }}
          placeholder="Nova tarefa: Ligar para o cliente amanhã às 10h p2 #projeto +pessoa"
          maxLength={600}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-linha bg-fundo px-3 py-2"
        />
        <button
          type="submit"
          disabled={!previa?.content || Boolean(naoMembro) || criar.isPending}
          className="rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura disabled:opacity-50"
        >
          Adicionar
        </button>
      </div>
      {previa && previa.detected.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="O que foi entendido">
          {previa.detected.map((d, i) => (
            <li key={`${d.type}-${i}`} className="rounded-full bg-floresta-clara px-2 py-0.5 text-xs text-floresta-texto">
              {ROTULO_TOKEN[d.type]} {d.label}
            </li>
          ))}
        </ul>
      )}
      {naoMembro && (
        <p role="alert" className="mt-2 text-sm text-vermelho">
          {vista.tipo === "projeto"
            ? `${naoMembro} não é membro deste projeto. Adicione em Membros ou tire o +.`
            : `Para delegar a ${naoMembro}, abra um projeto em que essa pessoa seja membro (ou use #projeto).`}
        </p>
      )}
      {criar.isError && (
        <p role="alert" className="mt-2 text-sm text-vermelho">
          {erroDe(criar.error)}
        </p>
      )}
    </form>
  );
}

const ROTULO_TOKEN: Record<SmartToken["type"], string> = {
  date: "Data:",
  recurrence: "Repete:",
  project: "Projeto:",
  section: "Seção:",
  assignee: "Para:",
  priority: "Prioridade:",
  label: "Etiqueta:",
  time: "Hora:",
};

function dataCurta(iso: string, ctx: ContextoTarefas) {
  if (iso === ctx.hoje) return "Hoje";
  if (iso === ctx.amanha) return "Amanhã";
  const [a, m, d] = iso.split("-");
  return a === ctx.hoje.slice(0, 4) ? `${d}/${m}` : `${d}/${m}/${a}`;
}

function LinhaTarefa({
  t,
  ctx,
  meuId,
  vista,
  onAviso,
  selecao,
  onAbrir,
}: {
  t: Tarefa;
  ctx: ContextoTarefas;
  meuId: string;
  vista: VistaTarefas;
  onAviso: (s: string) => void;
  selecao?: { marcada: boolean; alternar: () => void };
  onAbrir: () => void;
}) {
  const queryClient = useQueryClient();
  const concluir = useMutation({
    mutationFn: () => concluirTarefa({ data: { id: t.id } }),
    onSuccess: ({ proximaData }) => {
      onAviso(proximaData ? `“${t.titulo}” repete ${dataCurta(proximaData, ctx).toLowerCase()}.` : `“${t.titulo}” concluída.`);
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
    onError: (e) => onAviso(erroDe(e)),
  });
  const reabrir = useMutation({
    mutationFn: () => reabrirTarefa({ data: { id: t.id } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tarefas"] }),
    onError: (e) => onAviso(erroDe(e)),
  });
  const atrasada = !t.concluida && t.data < ctx.hoje;

  return (
    <li className="flex gap-3 border-b border-linha px-4 py-2.5">
      {selecao && (
        <input
          type="checkbox"
          checked={selecao.marcada}
          onChange={selecao.alternar}
          aria-label={`Selecionar: ${t.titulo}`}
          className="mt-1 size-4 shrink-0 accent-[var(--floresta)]"
        />
      )}
      {t.concluida ? (
        <button
          type="button"
          onClick={() => reabrir.mutate()}
          disabled={reabrir.isPending}
          aria-label={`Reabrir: ${t.titulo}`}
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-floresta text-white"
        >
          <Check size={13} aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => concluir.mutate()}
          disabled={concluir.isPending}
          aria-label={`Concluir: ${t.titulo}`}
          title={`Concluir (prioridade ${t.prioridade})`}
          className="group mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2"
          style={{ borderColor: COR_PRIORIDADE[t.prioridade] }}
        >
          <Check size={12} className="opacity-0 group-hover:opacity-60" style={{ color: COR_PRIORIDADE[t.prioridade] }} aria-hidden />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onAbrir}
          className={`block w-full break-words text-left hover:underline ${t.concluida ? "text-muted line-through" : ""}`}
        >
          {t.titulo}
        </button>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
          <span className={atrasada ? "font-medium text-vermelho" : ""}>
            {dataCurta(t.data, ctx)}
            {t.hora ? ` · ${t.hora}` : ""}
          </span>
          {t.recorrencia && (
            <span className="inline-flex items-center gap-1">
              <Repeat size={12} aria-hidden /> {formatRecurrence(t.recorrencia)}
            </span>
          )}
          {t.projeto && vista.tipo !== "projeto" && (
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: t.projeto.cor }} aria-hidden />
              {t.projeto.nome}
            </span>
          )}
          {t.responsavel && t.responsavel.id !== meuId && <span>Para {t.responsavel.nome.split(" ").slice(0, 2).join(" ")}</span>}
          {t.etiquetas.map((e) => (
            <span key={e}>@{e}</span>
          ))}
          {t.subtarefas.total > 0 && (
            <span className="inline-flex items-center gap-1" title="Subtarefas concluídas">
              <ListTree size={12} aria-hidden /> {t.subtarefas.concluidas}/{t.subtarefas.total}
            </span>
          )}
          {t.pai && <span className="truncate">↳ {t.pai.titulo}</span>}
        </p>
      </div>
    </li>
  );
}

function agrupar(lista: Tarefa[], ctx: ContextoTarefas): Array<[string, Tarefa[]]> {
  const grupos: Array<[string, Tarefa[]]> = [
    ["Atrasadas", lista.filter((t) => t.data < ctx.hoje)],
    ["Hoje", lista.filter((t) => t.data === ctx.hoje)],
    ["Amanhã", lista.filter((t) => t.data === ctx.amanha)],
    ["Próximas", lista.filter((t) => t.data > ctx.amanha)],
  ];
  return grupos.filter(([, l]) => l.length > 0);
}

export function TarefasPainel({
  ctx,
  vista,
  meuId,
  onVoltar,
  embutido = false,
}: {
  ctx: ContextoTarefas;
  vista: VistaTarefas;
  meuId: string;
  onVoltar?: () => void;
  /** Dentro de outra tela (aba Tarefas da missão): sem título nem "voltar". */
  embutido?: boolean;
}) {
  const [verConcluidas, setVerConcluidas] = useState(false);
  // Lista, semana ou mês (como no Foco); a escolha fica no navegador.
  const [layout, setLayoutEstado] = useState<LayoutTarefas>(() => {
    try {
      const salvo = localStorage.getItem("omni-tarefas-layout");
      return salvo === "quadro" || salvo === "semana" || salvo === "mes" ? salvo : "lista";
    } catch {
      return "lista";
    }
  });
  const setLayout = (l: LayoutTarefas) => {
    setLayoutEstado(l);
    try {
      localStorage.setItem("omni-tarefas-layout", l);
    } catch {
      // sem armazenamento: vale só nesta tela
    }
  };
  const [verMembros, setVerMembros] = useState(false);
  const [loteAberto, setLoteAberto] = useState(false);
  const [selecionadas, setSelecionadas] = useState<Set<string> | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const projeto = vista.tipo === "projeto" ? ctx.projetos.find((p) => p.id === vista.id) : undefined;
  const abertas = useQuery({ queryKey: chaveLista(vista, false), queryFn: () => listarTarefas({ data: { vista, concluidas: false } }) });
  const concluidas = useQuery({
    queryKey: chaveLista(vista, true),
    queryFn: () => listarTarefas({ data: { vista, concluidas: true } }),
    enabled: verConcluidas,
  });

  const linha = (t: Tarefa) => (
    <LinhaTarefa
      key={t.id}
      t={t}
      ctx={ctx}
      meuId={meuId}
      vista={vista}
      onAviso={setAviso}
      onAbrir={() => setAberta(t.id)}
      selecao={
        selecionadas
          ? {
              marcada: selecionadas.has(t.id),
              alternar: () =>
                setSelecionadas((atual) => {
                  const nova = new Set(atual);
                  if (nova.has(t.id)) nova.delete(t.id);
                  else nova.add(t.id);
                  return nova;
                }),
            }
          : undefined
      }
    />
  );

  // No projeto com seções, agrupa por seção (como no Foco); senão, por prazo.
  type Grupo = { chave: string; titulo: string; lista: Tarefa[]; secao?: { id: string; nome: string }; primeira?: boolean; ultima?: boolean };
  const grupos = (lista: Tarefa[]): Grupo[] => {
    const secoes = projeto?.secoes ?? [];
    if (!secoes.length) return agrupar(lista, ctx).map(([titulo, l]) => ({ chave: titulo, titulo, lista: l }));
    const conhecidas = new Set(secoes.map((x) => x.id));
    const semSecao = lista.filter((t) => !t.secaoId || !conhecidas.has(t.secaoId));
    return [
      ...(semSecao.length ? [{ chave: "sem-secao", titulo: "Sem seção", lista: semSecao }] : []),
      ...secoes.map((sec, i) => ({
        chave: sec.id,
        titulo: sec.nome,
        lista: lista.filter((t) => t.secaoId === sec.id),
        secao: sec,
        primeira: i === 0,
        ultima: i === secoes.length - 1,
      })),
    ];
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-linha bg-superficie px-4 py-3">
        {!embutido && (
          <button type="button" onClick={onVoltar} aria-label="Voltar" className="rounded-md p-1 hover:bg-superficie-2 md:hidden">
            <ArrowLeft size={20} />
          </button>
        )}
        {embutido ? (
          <span className="flex-1" />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{nomeDaVista(vista, ctx)}</h2>
        )}
        <div className="flex rounded-md border border-linha" role="group" aria-label="Ver como">
          {(
            [
              ["lista", "Lista", List],
              ["quadro", "Quadro", Columns3],
              ["semana", "Semana", CalendarRange],
              ["mes", "Mês", CalendarDays],
            ] as const
          ).map(([l, rotulo, Icone]) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              aria-pressed={layout === l}
              title={rotulo}
              className={`flex items-center gap-1 px-2 py-1 text-sm first:rounded-l-md last:rounded-r-md ${layout === l ? "bg-floresta-clara text-floresta-texto" : "hover:bg-superficie-2"}`}
            >
              <Icone size={16} aria-hidden /> <span className="sr-only 2xl:not-sr-only">{rotulo}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setLoteAberto(true)}
          aria-label="Tarefas em lote"
          className="flex items-center gap-1.5 rounded-md border border-linha px-2.5 py-1 text-sm hover:bg-superficie-2"
        >
          <ListPlus size={16} aria-hidden /> <span className="hidden sm:inline">Em lote</span>
        </button>
        <button
          type="button"
          onClick={() => setSelecionadas((s) => (s ? null : new Set()))}
          aria-pressed={selecionadas !== null}
          aria-label={selecionadas ? "Cancelar seleção" : "Delegar em lote"}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm hover:bg-superficie-2 ${selecionadas ? "border-floresta text-floresta-texto" : "border-linha"}`}
        >
          <UserCheck size={16} aria-hidden /> <span className={selecionadas ? "" : "hidden sm:inline"}>{selecionadas ? "Cancelar" : "Delegar"}</span>
        </button>
        {projeto && (
          // Em telas largas os membros ficam no painel da direita.
          <button
            type="button"
            onClick={() => setVerMembros((v) => !v)}
            aria-expanded={verMembros}
            aria-label={`Membros (${projeto.membros.length})`}
            className={`flex items-center gap-1.5 rounded-md border border-linha px-2.5 py-1 text-sm hover:bg-superficie-2 ${embutido ? "" : "xl:hidden"}`}
          >
            <Users size={16} aria-hidden /> <span className="hidden sm:inline">Membros ·</span> {projeto.membros.length}
          </button>
        )}
      </header>
      {projeto && verMembros && (
        <div className={`border-b border-linha bg-superficie ${embutido ? "" : "xl:hidden"}`}>
          <MembrosProjeto ctx={ctx} projeto={projeto} />
        </div>
      )}
      {vista.tipo === "filtro" && <CabecalhoFiltro ctx={ctx} id={vista.id} aoApagar={() => onVoltar?.()} />}
      {vista.tipo !== "delegadas" && <CapturaRapida ctx={ctx} vista={vista} />}
      <p aria-live="polite" className={aviso ? "bg-floresta-clara px-4 py-2 text-sm text-floresta-texto" : "sr-only"}>
        {aviso}
      </p>
      {layout !== "lista" && abertas.data ? (
        layout === "quadro" ? (
          <QuadroTarefas tarefas={abertas.data} ctx={ctx} projetoId={projeto?.id ?? null} onAbrir={setAberta} onAviso={setAviso} />
        ) : layout === "semana" ? (
          <SemanaTarefas tarefas={abertas.data} hoje={ctx.hoje} onAbrir={setAberta} />
        ) : (
          <MesTarefas tarefas={abertas.data} hoje={ctx.hoje} onAbrir={setAberta} />
        )
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {abertas.isError ? (
          <p role="alert" className="px-6 py-10 text-center text-vermelho">
            Não foi possível carregar as tarefas.
          </p>
        ) : !abertas.data ? (
          <Carregando className="px-6 py-10" />
        ) : abertas.data.length === 0 && !projeto?.secoes.length ? (
          <p className="px-6 py-10 text-center text-muted">
            {vista.tipo === "delegadas" ? "Nenhuma tarefa delegada em aberto." : "Nada pendente por aqui."}
          </p>
        ) : (
          grupos(abertas.data).map((g) => (
            <section key={g.chave} aria-label={g.titulo}>
              {g.secao ? (
                <CabecalhoSecao secao={g.secao} n={g.lista.length} primeira={g.primeira} ultima={g.ultima} />
              ) : (
                <h3 className={`rotulo px-4 pb-1 pt-4 ${g.titulo === "Atrasadas" ? "text-vermelho" : "text-muted"}`}>
                  {g.titulo} · {g.lista.length}
                </h3>
              )}
              <ul>{g.lista.map(linha)}</ul>
            </section>
          ))
        )}
        {projeto && abertas.data && <NovaSecao projetoId={projeto.id} />}
        <button type="button" onClick={() => setVerConcluidas((v) => !v)} className="mx-4 mt-4 text-sm text-floresta-texto underline">
          {verConcluidas ? "Esconder concluídas" : "Ver concluídas"}
        </button>
        {verConcluidas && (
          <ul className="mt-2 opacity-90">
            {(concluidas.data ?? []).map(linha)}
            {concluidas.data?.length === 0 && <li className="px-4 py-2 text-sm text-muted">Nenhuma concluída ainda.</li>}
          </ul>
        )}
      </div>
      )}
      {selecionadas && (
        <BarraDelegar
          ctx={ctx}
          opcoes={projeto ? projeto.membros : ctx.pessoas}
          selecionadas={selecionadas}
          todas={abertas.data?.map((t) => t.id) ?? []}
          onSelecionar={setSelecionadas}
          onFeito={(msg) => {
            setAviso(msg);
            setSelecionadas(null);
          }}
        />
      )}
      {aberta && <DetalheTarefa id={aberta} ctx={ctx} meuId={meuId} onFechar={() => setAberta(null)} />}
      {loteAberto && <LoteTarefas ctx={ctx} projetoAtivo={projeto?.id ?? null} onFechar={() => setLoteAberto(false)} />}
    </div>
  );
}

function BarraDelegar({
  ctx,
  opcoes,
  selecionadas,
  todas,
  onSelecionar,
  onFeito,
}: {
  ctx: ContextoTarefas;
  opcoes: Array<{ id: string; nome: string }>;
  selecionadas: Set<string>;
  todas: string[];
  onSelecionar: (s: Set<string>) => void;
  onFeito: (mensagem: string) => void;
}) {
  const queryClient = useQueryClient();
  const [pessoaId, setPessoaId] = useState("");
  const delegar = useMutation({
    mutationFn: () => delegarTarefas({ data: { ids: [...selecionadas], pessoaId } }),
    onSuccess: ({ delegadas, recusadas }) => {
      const nome = ctx.pessoas.find((p) => p.id === pessoaId)?.nome ?? "";
      onFeito(
        `${delegadas} ${delegadas === 1 ? "tarefa delegada" : "tarefas delegadas"} para ${nome}.` +
          (recusadas
            ? ` ${recusadas} não ${recusadas === 1 ? "pôde" : "puderam"}: tarefa da caixa pessoal, pessoa fora do projeto ou sem permissão.`
            : ""),
      );
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });
  const n = selecionadas.size;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-linha bg-superficie px-4 py-3 text-sm">
      <b>
        {n} selecionada{n === 1 ? "" : "s"}
      </b>
      <button type="button" onClick={() => onSelecionar(new Set(todas))} className="text-floresta-texto underline">
        Selecionar todas
      </button>
      <label className="ml-auto flex min-w-0 items-center gap-2">
        <span className="sr-only">Responsável</span>
        <select value={pessoaId} onChange={(e) => setPessoaId(e.target.value)} className="min-w-0 rounded-md border border-linha bg-superficie px-2 py-1.5">
          <option value="">Responsável…</option>
          {opcoes.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={!n || !pessoaId || delegar.isPending}
        onClick={() => delegar.mutate()}
        className="rounded-md bg-floresta px-3 py-1.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-50"
      >
        Aplicar
      </button>
      {delegar.isError && (
        <p role="alert" className="w-full text-vermelho">
          {erroDe(delegar.error)}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- painel da direita

const PAPEL: Record<"owner" | "manager" | "member", string> = { owner: "Dono", manager: "Gerencia", member: "Membro" };

export function TarefasContexto({ ctx, vista }: { ctx: ContextoTarefas; vista: VistaTarefas }) {
  const projeto = vista.tipo === "projeto" ? ctx.projetos.find((p) => p.id === vista.id) : undefined;
  if (!projeto) {
    return (
      <div className="p-4 text-sm">
        <p className="rotulo text-muted">Como escrever</p>
        <ul className="mt-2 grid gap-1.5 text-muted">
          <li>
            <b className="text-ink">amanhã, sexta, 15/11</b> — data
          </li>
          <li>
            <b className="text-ink">às 15h</b> — hora
          </li>
          <li>
            <b className="text-ink">toda segunda, todo dia 10</b> — repete
          </li>
          <li>
            <b className="text-ink">p1 a p4</b> — prioridade
          </li>
          <li>
            <b className="text-ink">#projeto /seção</b> — onde fica
          </li>
          <li>
            <b className="text-ink">+pessoa</b> — responsável (membro do projeto)
          </li>
          <li>
            <b className="text-ink">@etiqueta</b> — etiqueta (vira uma pasta em Etiquetas)
          </li>
        </ul>
        <p className="mt-3 text-muted">Sem projeto, a tarefa fica na sua caixa pessoal, que só você vê.</p>
      </div>
    );
  }
  return <MembrosProjeto ctx={ctx} projeto={projeto} />;
}

function MembrosProjeto({ ctx, projeto }: { ctx: ContextoTarefas; projeto: ContextoTarefas["projetos"][number] }) {
  const queryClient = useQueryClient();
  const [pessoaId, setPessoaId] = useState("");
  const adicionar = useMutation({
    mutationFn: () => adicionarMembro({ data: { projetoId: projeto.id, pessoaId } }),
    onSuccess: () => {
      setPessoaId("");
      void queryClient.invalidateQueries({ queryKey: CHAVE_CONTEXTO });
    },
  });
  const fora = ctx.pessoas.filter((p) => !projeto.membros.some((m) => m.id === p.id));
  const gerencia = projeto.meuPapel === "owner" || projeto.meuPapel === "manager";

  return (
    <div className="p-4">
      <p className="rotulo text-muted">Membros · {projeto.membros.length}</p>
      <ul className="mt-2 grid gap-2">
        {projeto.membros.map((m) => (
          <li key={m.id} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate">{m.nome}</span>
            <span className="shrink-0 text-xs text-muted">{PAPEL[m.papel]}</span>
          </li>
        ))}
      </ul>
      {gerencia && (
        <form
          className="mt-4 grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pessoaId) adicionar.mutate();
          }}
        >
          <label className="grid gap-1 text-sm">
            Adicionar pessoa
            <select
              value={pessoaId}
              onChange={(e) => setPessoaId(e.target.value)}
              className="rounded-md border border-linha bg-superficie px-2 py-1.5"
            >
              <option value="">Escolha…</option>
              {fora.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome}
                </option>
              ))}
            </select>
          </label>
          {adicionar.isError && (
            <p role="alert" className="text-sm text-vermelho">
              {erroDe(adicionar.error)}
            </p>
          )}
          <button
            type="submit"
            disabled={!pessoaId || adicionar.isPending}
            className="flex items-center justify-center gap-2 rounded-md border border-floresta px-3 py-1.5 text-sm font-medium text-floresta-texto hover:bg-floresta-clara disabled:opacity-50"
          >
            <UserPlus size={16} aria-hidden /> Adicionar
          </button>
        </form>
      )}
      <p className="mt-4 text-xs text-muted">Só membros recebem tarefas deste projeto. Para delegar, use +pessoa na captura.</p>
    </div>
  );
}

export function useContextoTarefas(ativo: boolean) {
  return useQuery({ queryKey: CHAVE_CONTEXTO, queryFn: () => contextoTarefas(), enabled: ativo });
}

// ---------------------------------------------------------------- seções

function CabecalhoSecao({ secao, n, primeira, ultima }: { secao: { id: string; nome: string }; n: number; primeira?: boolean; ultima?: boolean }) {
  const queryClient = useQueryClient();
  const [renomeando, setRenomeando] = useState(false);
  const [confirmar, setConfirmar] = useState(false);
  const alterar = useMutation({
    mutationFn: (v: { nome?: string; mover?: -1 | 1; excluir?: boolean }) => alterarSecao({ data: { id: secao.id, ...v } }),
    onSuccess: () => {
      setRenomeando(false);
      setConfirmar(false);
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });
  const icone = "rounded p-1 text-muted hover:bg-superficie-2 hover:text-ink disabled:opacity-40";
  return (
    <div className="flex items-center gap-2 px-4 pb-1 pt-4">
      {renomeando ? (
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const nome = String(new FormData(e.currentTarget).get("nome") ?? "").trim();
            if (nome) alterar.mutate({ nome });
          }}
        >
          <input name="nome" defaultValue={secao.nome} autoFocus maxLength={120} aria-label="Nome da seção" className="flex-1 rounded-md border border-linha bg-superficie px-2 py-1 text-sm" />
          <button type="submit" className="rounded-md bg-floresta px-2 text-sm text-white">
            Salvar
          </button>
          <button type="button" onClick={() => setRenomeando(false)} className="rounded-md border border-linha px-2 text-sm">
            Cancelar
          </button>
        </form>
      ) : (
        <>
          <h3 className="rotulo flex-1 text-floresta-texto">
            {secao.nome} · {n}
          </h3>
          <button type="button" onClick={() => setRenomeando(true)} aria-label={`Renomear a seção ${secao.nome}`} className={icone}>
            <Pencil size={14} />
          </button>
          <button type="button" disabled={primeira || alterar.isPending} onClick={() => alterar.mutate({ mover: -1 })} aria-label={`Subir a seção ${secao.nome}`} className={icone}>
            <ArrowUp size={14} />
          </button>
          <button type="button" disabled={ultima || alterar.isPending} onClick={() => alterar.mutate({ mover: 1 })} aria-label={`Descer a seção ${secao.nome}`} className={icone}>
            <ArrowDown size={14} />
          </button>
          {confirmar ? (
            <button type="button" onClick={() => alterar.mutate({ excluir: true })} className="rounded-md bg-vermelho px-2 py-0.5 text-xs text-white">
              Excluir seção? As tarefas ficam sem seção
            </button>
          ) : (
            <button type="button" onClick={() => setConfirmar(true)} aria-label={`Excluir a seção ${secao.nome}`} className={icone}>
              <Trash2 size={14} />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function NovaSecao({ projetoId }: { projetoId: string }) {
  const queryClient = useQueryClient();
  const [aberta, setAberta] = useState(false);
  const criar = useMutation({
    mutationFn: (nome: string) => criarSecao({ data: { projetoId, nome } }),
    onSuccess: () => {
      setAberta(false);
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
  });
  if (!aberta) {
    return (
      <button type="button" onClick={() => setAberta(true)} className="mx-4 mt-4 flex items-center gap-1 text-sm text-floresta-texto">
        <Plus size={15} aria-hidden /> Nova seção
      </button>
    );
  }
  return (
    <form
      className="mx-4 mt-4 flex flex-wrap gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        const nome = String(new FormData(e.currentTarget).get("nome") ?? "").trim();
        if (nome) criar.mutate(nome);
      }}
    >
      <input name="nome" autoFocus maxLength={120} placeholder="Nome da seção (ex.: Campo, Documentação)" aria-label="Nome da nova seção" className="min-w-0 flex-1 rounded-md border border-linha bg-superficie px-2 py-1.5" />
      <button type="submit" disabled={criar.isPending} className="rounded-md bg-floresta px-3 py-1.5 text-white">
        Criar seção
      </button>
      <button type="button" onClick={() => setAberta(false)} className="rounded-md border border-linha px-3 py-1.5">
        Cancelar
      </button>
      {criar.isError && (
        <p role="alert" className="w-full text-vermelho">
          {erroDe(criar.error)}
        </p>
      )}
    </form>
  );
}

