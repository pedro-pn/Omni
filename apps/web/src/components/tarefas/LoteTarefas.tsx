import { addDays, parseBatchTasks, type BatchTaskDraft } from "@omni/core";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { criarTarefa, type ContextoTarefas } from "../../lib/tarefas-fns.ts";

/**
 * Tarefas em lote — porta do BatchTaskDialog do Foco, com o mesmo parser
 * (@omni/core parseBatchTasks) e as mesmas regras: todo item precisa de
 * projeto, responsável membro do projeto e data. Cada linha tem um id fixo,
 * então repetir depois de uma falha não duplica.
 */

type Linha = BatchTaskDraft & { id: string; incluida: boolean; status: "pronta" | "salvando" | "criada" | "falhou" };

const LIMITE = 200;

export function LoteTarefas({ ctx, projetoAtivo, onFechar }: { ctx: ContextoTarefas; projetoAtivo: string | null; onFechar: () => void }) {
  const queryClient = useQueryClient();
  const dialogo = useRef<HTMLDialogElement>(null);
  const [texto, setTexto] = useState("");
  const [projetoPadrao, setProjetoPadrao] = useState(projetoAtivo ?? "");
  const [dataBase, setDataBase] = useState(ctx.hoje);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [avisos, setAvisos] = useState<string[]>([]);
  const [revisando, setRevisando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const enviando = useRef(false);

  useEffect(() => {
    dialogo.current?.showModal();
  }, []);

  const pessoas = ctx.pessoas.map((p) => ({ name: p.nome, email: p.email }));
  const projetos = ctx.projetos.map((p) => ({ id: p.id, name: p.nome }));
  const secoes = ctx.projetos.flatMap((p) => p.secoes.map((s) => ({ id: s.id, name: s.nome, projectId: p.id })));
  const membrosDe = (projetoId: string | null) => ctx.projetos.find((p) => p.id === projetoId)?.membros ?? [];

  const pendentes = linhas.filter((l) => l.incluida && l.status !== "criada");
  const criadas = linhas.filter((l) => l.status === "criada").length;
  const tentou = linhas.some((l) => l.status !== "pronta");

  const problema = (l: Linha) => {
    if (!l.content.trim()) return "Escreva o texto da tarefa.";
    if (!ctx.projetos.some((p) => p.id === l.projectId)) return `Escolha o projeto${l.projectHint ? ` (${l.projectHint})` : ""}.`;
    if (!l.assigneeEmail) return `Escolha o responsável${l.personHint ? ` (${l.personHint})` : ""}.`;
    if (!membrosDe(l.projectId).some((m) => m.email === l.assigneeEmail))
      return "O responsável não é membro deste projeto. Adicione-o em Membros ou escolha outra pessoa.";
    if (!l.dueDate) return "Escolha a data.";
    return "";
  };
  const comProblema = pendentes.filter((l) => problema(l)).length;

  function revisar() {
    const r = parseBatchTasks({
      text: texto,
      projects: projetos,
      people: pessoas,
      sections: secoes,
      defaultProjectId: projetoPadrao,
      today: dataBase,
      tomorrow: addDays(dataBase, 1),
    });
    setLinhas(r.tasks.map((t) => ({ ...t, id: crypto.randomUUID(), incluida: true, status: "pronta" })));
    setAvisos(r.warnings);
    setRevisando(true);
  }

  const atualizar = (id: string, patch: Partial<Linha>) => setLinhas((atual) => atual.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  async function criar() {
    if (enviando.current || comProblema || !pendentes.length || linhas.length > LIMITE) return;
    enviando.current = true;
    setSalvando(true);
    const fila = [...pendentes];
    try {
      // Três de cada vez, como no Foco.
      await Promise.all(
        Array.from({ length: Math.min(3, fila.length) }, async () => {
          while (fila.length) {
            const l = fila.shift()!;
            atualizar(l.id, { status: "salvando" });
            let ok = false;
            try {
              await criarTarefa({
                data: {
                  id: l.id,
                  titulo: l.content.trim(),
                  descricao: l.description,
                  projetoId: l.projectId,
                  secaoId: l.sectionId ?? null,
                  data: l.dueDate!,
                  hora: l.dueTime,
                  recorrencia: l.recurrence,
                  prioridade: l.priority,
                  etiquetas: l.labels,
                  responsavelEmail: l.assigneeEmail,
                },
              });
              ok = true;
            } catch {
              // Fica para tentar de novo, com o mesmo id.
            }
            atualizar(l.id, { status: ok ? "criada" : "falhou" });
          }
        }),
      );
    } finally {
      enviando.current = false;
      setSalvando(false);
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    }
  }

  const fechar = () => {
    if (!salvando) onFechar();
  };

  const campo = "rounded-md border border-linha bg-superficie px-2 py-1.5";

  return (
    <dialog
      ref={dialogo}
      aria-labelledby="lote-titulo"
      onCancel={(e) => {
        e.preventDefault();
        fechar();
      }}
      className="m-auto max-h-[92dvh] w-[min(56rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-linha bg-superficie p-0 text-ink backdrop:bg-black/50"
    >
      <div className="flex max-h-[92dvh] flex-col">
        <header className="flex items-start gap-3 border-b border-linha px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="lote-titulo" className="text-lg font-semibold">
              Tarefas em lote
            </h2>
            <p className="text-sm text-muted">Cole o resumo da reunião, confira responsáveis e datas e crie tudo de uma vez.</p>
          </div>
          <button type="button" onClick={fechar} disabled={salvando} aria-label="Fechar" className="rounded-md p-1 hover:bg-superficie-2">
            <X size={20} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!revisando ? (
            <div className="grid gap-3 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1">
                  Projeto padrão
                  <select value={projetoPadrao} onChange={(e) => setProjetoPadrao(e.target.value)} className={campo}>
                    <option value="">Escolher projeto</option>
                    {ctx.projetos.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1">
                  Data de referência
                  <input type="date" required value={dataBase} onChange={(e) => setDataBase(e.target.value)} className={campo} />
                </label>
              </div>
              <label className="grid gap-1">
                Resumo da reunião
                <textarea
                  autoFocus
                  rows={12}
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  placeholder={"PEDRO - quinta\n- Ajustar o cronograma.\n- Conferir os relatórios - amanhã\n\nMARIA\n- Enviar a medição - hoje"}
                  className={`${campo} font-mono text-[13px]`}
                />
              </label>
              <p className="text-muted">
                Uma tarefa por linha, com ou sem “-”. Responsável e prazo em qualquer posição (<b className="text-ink">Pedro revisar os saldos quinta</b>{" "}
                ou <b className="text-ink">Revisar os saldos - Pedro - quinta</b>), cabeçalhos com o nome da pessoa seguidos de itens, ou a tabela{" "}
                <b className="text-ink">5815 | Cliente | Responsável | Tarefa. Prazo: 13/11/2026.</b> Valem os atalhos da captura: +pessoa, #projeto,
                /seção, p1 a p4. “Hoje”, “amanhã” e os dias da semana contam a partir da data de referência. Até {LIMITE} tarefas.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 text-sm">
              <p role="status" aria-live="polite" className="rounded-md bg-superficie-2 px-3 py-2">
                <b>
                  {linhas.length} tarefas identificadas · {criadas} criadas.
                </b>{" "}
                {salvando
                  ? "Criando… acompanhe cada item abaixo."
                  : comProblema
                    ? `${comProblema} precisam de revisão.`
                    : pendentes.length
                      ? `${pendentes.length} prontas para criar.`
                      : "Nenhuma tarefa pendente selecionada."}
              </p>
              {avisos.length > 0 && (
                <details className="rounded-md border border-linha px-3 py-2">
                  <summary className="cursor-pointer">Observações da leitura ({avisos.length})</summary>
                  <ul className="mt-2 grid gap-1 text-muted">
                    {avisos.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </details>
              )}
              {linhas.length === 0 && (
                <p role="alert" className="text-vermelho">
                  Nenhuma tarefa encontrada. Volte ao texto e escreva uma atividade por linha.
                </p>
              )}
              {linhas.length > LIMITE && (
                <p role="alert" className="text-vermelho">
                  Use no máximo {LIMITE} tarefas por lote.
                </p>
              )}
              <label className="grid gap-1 sm:max-w-sm">
                Aplicar projeto a todas as pendentes
                <select
                  disabled={salvando}
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) setLinhas((atual) => atual.map((l) => (l.status === "criada" ? l : { ...l, projectId: id, sectionId: null })));
                  }}
                  className={campo}
                >
                  <option value="">Escolher projeto…</option>
                  {ctx.projetos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nome}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-muted">O responsável escolhido vale para os itens pendentes do mesmo cabeçalho. Desmarque o que não quer criar.</p>

              <ol className="grid gap-3">
                {linhas.map((l, i) => {
                  const travada = salvando || l.status === "criada";
                  const membros = membrosDe(l.projectId);
                  const foraDoProjeto = l.assigneeEmail && !membros.some((m) => m.email === l.assigneeEmail);
                  const erro = l.incluida && l.status !== "criada" ? problema(l) : "";
                  return (
                    <li key={l.id}>
                      <fieldset
                        disabled={travada}
                        className={`grid gap-2 rounded-md border px-3 py-2 ${l.status === "criada" ? "border-floresta bg-floresta-clara" : erro ? "border-vermelho" : "border-linha"}`}
                      >
                        <legend className="flex w-full items-center justify-between gap-2 px-1">
                          <label className="flex items-center gap-2 font-medium">
                            <input type="checkbox" checked={l.incluida} onChange={(e) => atualizar(l.id, { incluida: e.target.checked })} />
                            Tarefa {i + 1}
                            {l.personHint ? ` · ${l.personHint}` : ""}
                          </label>
                          <span className="text-xs text-muted">
                            {l.status === "criada" ? "✓ Criada" : l.status === "salvando" ? "Criando…" : l.status === "falhou" ? "Falhou — tente de novo" : `Linha ${l.sourceLine}`}
                          </span>
                        </legend>
                        <label className="grid gap-1">
                          <span className="sr-only">Texto da tarefa {i + 1}</span>
                          <textarea rows={2} value={l.content} onChange={(e) => atualizar(l.id, { content: e.target.value })} className={campo} />
                        </label>
                        {l.description && (
                          <label className="grid gap-1">
                            Descrição
                            <textarea rows={2} value={l.description} onChange={(e) => atualizar(l.id, { description: e.target.value })} className={campo} />
                          </label>
                        )}
                        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9.5rem_7rem]">
                          <label className="grid min-w-0 gap-1">
                            Projeto
                            <select
                              value={l.projectId ?? ""}
                              onChange={(e) => atualizar(l.id, { projectId: e.target.value || null, sectionId: null })}
                              className={campo}
                            >
                              <option value="">Escolher…</option>
                              {ctx.projetos.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.nome}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid min-w-0 gap-1">
                            Responsável
                            <select
                              value={l.assigneeEmail ?? ""}
                              onChange={(e) => {
                                const email = e.target.value || null;
                                setLinhas((atual) =>
                                  atual.map((x) =>
                                    x.status !== "criada" && (x.id === l.id || (l.assigneeGroup !== undefined && x.assigneeGroup === l.assigneeGroup))
                                      ? { ...x, assigneeEmail: email }
                                      : x,
                                  ),
                                );
                              }}
                              className={campo}
                            >
                              <option value="">Escolher…</option>
                              {foraDoProjeto && (
                                <option value={l.assigneeEmail!} disabled>
                                  {l.personHint || l.assigneeEmail} · fora do projeto
                                </option>
                              )}
                              {membros.map((m) => (
                                <option key={m.email} value={m.email}>
                                  {m.nome}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid gap-1">
                            Data
                            <input type="date" value={l.dueDate ?? ""} onChange={(e) => atualizar(l.id, { dueDate: e.target.value || null })} className={campo} />
                          </label>
                          <label className="grid gap-1">
                            Hora
                            <input type="time" value={l.dueTime ?? ""} onChange={(e) => atualizar(l.id, { dueTime: e.target.value || null })} className={campo} />
                          </label>
                        </div>
                        <p className="text-xs text-muted">
                          Prioridade P{l.priority}
                          {l.sectionId ? ` · Seção: ${secoes.find((s) => s.id === l.sectionId)?.name ?? ""}` : ""}
                          {l.recurrence ? ` · Repete` : ""}
                          {l.labels.length ? ` · Etiquetas: ${l.labels.join(", ")}` : ""}
                        </p>
                        {erro && (
                          <p role="alert" className="text-vermelho">
                            {erro}
                          </p>
                        )}
                      </fieldset>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-linha px-5 py-3">
          {revisando && criadas > 0 && !pendentes.length && (
            <button
              type="button"
              onClick={() => {
                setRevisando(false);
                setTexto("");
                setLinhas([]);
              }}
              className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2"
            >
              Novo lote
            </button>
          )}
          <button
            type="button"
            disabled={salvando}
            onClick={() => (revisando && !tentou ? setRevisando(false) : fechar())}
            className="rounded-md border border-linha px-3 py-1.5 hover:bg-superficie-2"
          >
            {revisando && !tentou ? "Voltar ao texto" : "Fechar"}
          </button>
          {revisando ? (
            <button
              type="button"
              disabled={salvando || Boolean(comProblema) || !pendentes.length || linhas.length > LIMITE}
              onClick={() => void criar()}
              className="rounded-md bg-floresta px-4 py-1.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-50"
            >
              {salvando ? `Criando… ${criadas}/${linhas.filter((l) => l.incluida).length}` : `Criar ${pendentes.length} ${pendentes.length === 1 ? "tarefa" : "tarefas"}`}
            </button>
          ) : (
            <button
              type="button"
              disabled={!texto.trim() || !dataBase}
              onClick={revisar}
              className="rounded-md bg-floresta px-4 py-1.5 font-medium text-white hover:bg-floresta-escura disabled:opacity-50"
            >
              Revisar tarefas
            </button>
          )}
        </footer>
      </div>
    </dialog>
  );
}
