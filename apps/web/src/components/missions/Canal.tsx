import { comandoDeAlerta, parseQuickInput } from "@omni/core";
import type { Canal as CanalTipo } from "@omni/db";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileText, Lock, Paperclip, SendHorizontal, Shield, UserMinus, Users, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";

import {
  adicionarMembro,
  enviarMensagem,
  listMembros,
  listMensagens,
  listPessoasParaCanal,
  marcarLido,
  removerMembro,
  verComo,
  type Mensagem,
} from "../../lib/canais-fns.ts";
import { criarTarefa } from "../../lib/tarefas-fns.ts";
import { LoteTarefas } from "../tarefas/LoteTarefas.tsx";
import { dadosDoParser, useContextoTarefas } from "../tarefas/Tarefas.tsx";
import { useProjetoDaMissao } from "../tarefas/TarefasDaMissao.tsx";
import { CartaoIA } from "./CartaoIA.tsx";
import { criarAlertaPorComando } from "../../lib/alertas-fns.ts";
import { AvisoNaoLidas, SetaParaBaixo, useRolagemDoChat } from "../comum/RolagemDoChat.tsx";
import { ImagemComPrevia } from "../comum/ImagemComPrevia.tsx";

const ESTILO: Record<CanalTipo, { nome: string; aviso: string; bolha: string; icone: typeof Lock }> = {
  interno: {
    nome: "Interno",
    aviso: "Só no Omni, para a equipe interna da missão. Nunca vai para o WhatsApp.",
    bolha: "border border-dashed border-lilas",
    icone: Lock,
  },
  gerencial: {
    nome: "Gerencial",
    aviso: "Só quem a diretoria escolheu. Nunca vai para o WhatsApp.",
    bolha: "border border-azul/60",
    icone: Shield,
  },
};

const horario = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

function erroTexto(e: unknown) {
  const t = e instanceof Error ? e.message : "";
  return t && !/failed query|fetch/i.test(t) ? t : "Não foi possível concluir. Tente de novo.";
}

const tamanhoLegivel = (b: number) => (b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);

/** Arquivos de uma mensagem (0063): imagem em miniatura; o resto em cartão para abrir ou baixar. */
function ArquivosDaMensagem({ arquivos }: { arquivos: NonNullable<Mensagem["arquivos"]> }) {
  return (
    <ul className="mt-1 space-y-1.5">
      {arquivos.map((a) => {
        const url = `/api/canais/arquivo/${a.id}`;
        return (
          <li key={a.id}>
            {/^image\/(jpeg|png|webp|gif)$/.test(a.tipo) ? (
              <ImagemComPrevia src={url} alt={a.nome} nome={a.nome} baixar={`${url}?baixar=1`} className="max-h-64 max-w-full rounded-md border border-linha object-contain" />
            ) : (
              <span className="flex items-center gap-2 rounded-md border border-linha bg-superficie-2 px-2.5 py-1.5">
                <FileText size={18} aria-hidden className="shrink-0 text-floresta-texto" />
                <a href={url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 hover:underline">
                  <span className="block truncate text-sm">{a.nome}</span>
                  <span className="block text-[11px] text-muted">{tamanhoLegivel(a.tamanho)}</span>
                </a>
                <a href={`${url}?baixar=1`} aria-label={`Baixar ${a.nome}`} title="Baixar" className="rounded p-1 hover:bg-superficie">
                  <Download size={16} aria-hidden />
                </a>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Linha({ m, meuId, bolha, missionId }: { m: Mensagem; meuId: string; bolha: string; missionId: string }) {
  if (m.kind === "ia") return <CartaoIA m={m} missionId={missionId} />;
  if (m.kind === "sistema") {
    return (
      <li data-msg={m.id} className="my-2 text-center">
        <span className="inline-block rounded-md bg-superficie-2 px-3 py-1 text-xs text-muted">
          {m.body} · {horario(m.createdAt)}
        </span>
      </li>
    );
  }
  const minha = m.autor?.id === meuId;
  return (
    <li data-msg={m.id} className={`flex ${minha ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-lg bg-superficie px-3 py-2 ${bolha}`}>
        {!minha && <p className="text-xs font-semibold text-floresta-texto">{m.autor?.nome ?? "Assistente do Omni"}</p>}
        {/* Mensagem só com arquivos: o texto é o nome deles; não repete. */}
        {!(m.arquivos?.length && m.body === m.arquivos.map((a) => a.nome).join(", ")) && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
        {m.arquivos && m.arquivos.length > 0 && <ArquivosDaMensagem arquivos={m.arquivos} />}
        <p className="mt-0.5 text-right text-[11px] text-muted">{horario(m.createdAt)}</p>
      </div>
    </li>
  );
}

function Membros({
  missionId,
  channel,
  podeGerenciar,
  souDiretoria,
  onVerComo,
  onFechar,
}: {
  missionId: string;
  channel: CanalTipo;
  podeGerenciar: boolean;
  souDiretoria: boolean;
  onVerComo: (p: { id: string; nome: string }) => void;
  onFechar: () => void;
}) {
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);
  const chave = ["membros", missionId, channel];
  const membros = useQuery({ queryKey: chave, queryFn: () => listMembros({ data: { missionId, channel } }) });
  const pessoas = useQuery({ queryKey: ["pessoas-canal"], queryFn: () => listPessoasParaCanal(), enabled: podeGerenciar });
  const atualizar = () => {
    void queryClient.invalidateQueries({ queryKey: chave });
    void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, channel] });
  };
  const adicionar = useMutation({
    mutationFn: (v: { personId: string; historico: "todo" | "agora" }) => adicionarMembro({ data: { missionId, channel, ...v } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(erroTexto(e)),
    onSuccess: atualizar,
  });
  const remover = useMutation({
    mutationFn: (personId: string) => removerMembro({ data: { missionId, channel, personId } }),
    onMutate: () => setErro(null),
    onError: (e) => setErro(erroTexto(e)),
    onSuccess: atualizar,
  });

  const enviar = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    adicionar.mutate(
      { personId: String(f.get("pessoa")), historico: f.get("historico") === "agora" ? "agora" : "todo" },
      { onSuccess: () => form.reset() },
    );
  };

  const jaMembros = new Set(membros.data?.map((m) => m.personId));
  return (
    <section aria-label="Membros do canal" className="border-b border-linha bg-superficie px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="rotulo text-muted">Membros · {ESTILO[channel].nome}</p>
        <button type="button" onClick={onFechar} aria-label="Fechar membros" className="rounded-md p-1 hover:bg-superficie-2">
          <X size={16} />
        </button>
      </div>
      {channel === "gerencial" && <p className="mt-1 text-xs text-muted">A diretoria vê todos os canais.</p>}
      {erro && (
        <p role="alert" className="mt-2 text-sm text-vermelho">
          {erro}
        </p>
      )}
      <ul className="mt-2 space-y-1.5">
        {membros.data?.map((m) => (
          <li key={m.personId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">{m.nome}</span>
              <span className="ml-2 text-xs text-muted">
                {m.origem === "filtroapp" ? `${m.papel} · pelo filtroAPP` : m.historico === "todo" ? "vê todo o histórico" : `vê desde ${horario(m.desde!)}`}
              </span>
            </span>
            <span className="flex gap-1">
              {souDiretoria && (
                <button
                  type="button"
                  onClick={() => onVerComo({ id: m.personId, nome: m.nome })}
                  className="flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-azul hover:bg-superficie-2"
                >
                  <Eye size={13} /> Ver como
                </button>
              )}
              {podeGerenciar && m.origem === "adicionado" && (
                <button
                  type="button"
                  onClick={() => remover.mutate(m.personId)}
                  disabled={remover.isPending}
                  aria-label={`Remover ${m.nome}`}
                  className="rounded-md p-1 text-muted hover:bg-superficie-2 hover:text-vermelho"
                >
                  <UserMinus size={15} />
                </button>
              )}
            </span>
          </li>
        ))}
        {membros.data?.length === 0 && <li className="text-sm text-muted">Ninguém além da diretoria.</li>}
      </ul>
      {podeGerenciar && (
        <form onSubmit={enviar} className="mt-3 flex flex-wrap items-end gap-2 border-t border-linha pt-3 text-sm">
          <label className="grid min-w-48 flex-1 gap-1">
            Adicionar pessoa
            <select name="pessoa" required defaultValue="" className="rounded-md border border-linha bg-superficie-2 px-2 py-1.5">
              <option value="" disabled>
                Escolha…
              </option>
              {pessoas.data
                ?.filter((p) => !jaMembros.has(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome}
                  </option>
                ))}
            </select>
          </label>
          <fieldset className="flex gap-3 pb-1.5">
            <legend className="sr-only">Histórico</legend>
            <label className="flex items-center gap-1">
              <input type="radio" name="historico" value="todo" defaultChecked /> Todo o histórico
            </label>
            <label className="flex items-center gap-1">
              <input type="radio" name="historico" value="agora" /> Só a partir de agora
            </label>
          </fieldset>
          <button type="submit" disabled={adicionar.isPending} className="rounded-md bg-floresta px-3 py-1.5 font-medium text-white hover:bg-floresta-escura">
            Adicionar
          </button>
        </form>
      )}
    </section>
  );
}

export function Canal({
  missionId,
  channel,
  meuId,
  podeGerenciar,
  souDiretoria,
}: {
  missionId: string;
  channel: CanalTipo;
  meuId: string;
  podeGerenciar: boolean;
  souDiretoria: boolean;
}) {
  const queryClient = useQueryClient();
  const estilo = ESTILO[channel];
  const [texto, setTexto] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [verMembros, setVerMembros] = useState(false);
  const [comoQuem, setComoQuem] = useState<{ id: string; nome: string } | null>(null);
  const [loteAberto, setLoteAberto] = useState(false);
  // Arquivos para a próxima mensagem: pelo clipe, arrastando para o canal ou colando (0063).
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [arrastando, setArrastando] = useState(false);
  const seletor = useRef<HTMLInputElement>(null);
  const juntarArquivos = (novos: File[]) => {
    if (!novos.length) return;
    setErro(null);
    setArquivos((atuais) => [...atuais, ...novos].slice(0, 10));
  };
  const temArquivos = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const enviarArquivos = useMutation({
    mutationFn: async () => {
      if (arquivos.some((a) => a.size > 50 * 1024 * 1024)) throw new Error("Cada arquivo pode ter até 50 MB.");
      const form = new FormData();
      form.set("missionId", missionId);
      form.set("channel", channel);
      form.set("texto", texto.trim());
      for (const a of arquivos) form.append("arquivo", a, a.name);
      const r = await fetch("/api/canais/arquivo", { method: "POST", body: form });
      const corpo = (await r.json().catch(() => ({}))) as { erro?: string };
      if (!r.ok) throw new Error(corpo.erro ?? "Não foi possível enviar o arquivo.");
    },
    onMutate: () => setErro(null),
    onSuccess: () => {
      setTexto("");
      setArquivos([]);
      if (seletor.current) seletor.current.value = "";
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, channel] });
    },
    onError: (e) => setErro(erroTexto(e)),
  });

  // Comandos do Interno (protótipo §6.6): /tarefa cria tarefa da missão; /lote abre o lote.
  // Só no Interno: a tarefa da missão é vista por todo o Interno (no Gerencial vazaria).
  const comando = channel === "interno" ? texto.match(/^\/(tarefa|lote)\b\s*([\s\S]*)$/) : null;
  const projetoMissao = useProjetoDaMissao(missionId, Boolean(comando));
  const ctxTarefas = useContextoTarefas(Boolean(comando && projetoMissao.data));
  const previa = useMemo(() => {
    if (comando?.[1] !== "tarefa" || !comando[2]?.trim() || !ctxTarefas.data || !projetoMissao.data) return null;
    const { projetos, secoes, membros } = dadosDoParser(ctxTarefas.data);
    const c = ctxTarefas.data;
    return parseQuickInput(comando[2], projetos, secoes, membros, { dueDate: c.hoje, priority: 4, projectId: projetoMissao.data.id }, c.hoje, c.amanha);
  }, [comando?.[1], comando?.[2], ctxTarefas.data, projetoMissao.data]);
  const criarDaConversa = useMutation({
    mutationFn: async () => {
      const p = previa!;
      await criarTarefa({
        data: {
          titulo: p.content,
          projetoId: p.projectId,
          secaoId: p.sectionId ?? null,
          data: p.dueDate ?? ctxTarefas.data!.hoje,
          hora: p.dueTime,
          recorrencia: p.recurrence,
          prioridade: p.priority,
          etiquetas: p.labels,
          responsavelEmail: p.assigneeEmail,
        },
      });
      const quem = p.detected.find((d) => d.type === "assignee")?.label;
      const quando = (p.dueDate ?? "").split("-").reverse().slice(0, 2).join("/");
      await enviarMensagem({
        data: { missionId, channel, body: `📋 Tarefa criada: ${p.content}${quem ? ` — para ${quem}` : ""}${quando ? ` · ${quando}` : ""}${p.dueTime ? ` às ${p.dueTime}` : ""}` },
      });
    },
    onMutate: () => setErro(null),
    onSuccess: () => {
      setTexto("");
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, channel] });
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    },
    onError: (e) => setErro(erroTexto(e)),
  });

  const mensagens = useQuery({
    queryKey: ["mensagens", missionId, channel],
    queryFn: () => listMensagens({ data: { missionId, channel } }),
  });
  const vistoComo = useQuery({
    queryKey: ["ver-como", missionId, channel, comoQuem?.id],
    queryFn: () => verComo({ data: { missionId, channel, personId: comoQuem!.id } }),
    enabled: Boolean(comoQuem),
  });

  const lido = useMutation({
    mutationFn: () => marcarLido({ data: { missionId, channel } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["nao-lidas"] });
      void queryClient.invalidateQueries({ queryKey: ["canais", missionId] });
    },
  });
  const ultima = mensagens.data?.at(-1)?.id;
  useEffect(() => {
    if (!ultima) return;
    lido.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultima]);

  // @IA / /alerta: a mensagem entra no canal e a IA responde com o cartão do alerta (ou com a dúvida).
  const [duvidaIA, setDuvidaIA] = useState<string | null>(null);
  const enviar = useMutation({
    mutationFn: async (body: string) => {
      await enviarMensagem({ data: { missionId, channel, body } });
      if (comandoDeAlerta(body) === null) return null;
      setTexto("");
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, channel] });
      return criarAlertaPorComando({ data: { missionId, channel, texto: body } });
    },
    onMutate: () => {
      setErro(null);
      setDuvidaIA(null);
    },
    onSuccess: (r) => {
      setTexto("");
      if (r && !r.criado) setDuvidaIA(r.duvida);
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, channel] });
      void queryClient.invalidateQueries({ queryKey: ["alertas", missionId] });
    },
    onError: (e) => setErro(erroTexto(e)),
  });
  const lendoPedido = enviar.isPending && comandoDeAlerta(enviar.variables ?? "") !== null;

  const submeter = () => {
    const corpo = texto.trim();
    // Com arquivos, o texto vai como legenda (sem comandos).
    if (arquivos.length) {
      if (!enviarArquivos.isPending) enviarArquivos.mutate();
      return;
    }
    if (comando?.[1] === "lote") {
      if (projetoMissao.data && ctxTarefas.data) setLoteAberto(true);
      return;
    }
    if (comando?.[1] === "tarefa") {
      if (previa?.content && !criarDaConversa.isPending) criarDaConversa.mutate();
      return;
    }
    if (corpo && !enviar.isPending) enviar.mutate(corpo);
  };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submeter();
    }
  };

  const lista = comoQuem ? vistoComo.data : mensagens.data;
  // Como no WhatsApp: abre na primeira não lida; seta para as novas ou para o fim.
  const rolagem = useRolagemDoChat(
    comoQuem ? `canal-como:${missionId}:${channel}:${comoQuem.id}` : `canal:${missionId}:${channel}`,
    lista?.map((m) => ({ id: m.id, em: m.createdAt, deMim: m.autor?.id === meuId })),
  );
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      // Arrastar arquivos para o canal anexa à próxima mensagem.
      onDragOver={(e) => {
        if (comoQuem || !temArquivos(e)) return;
        e.preventDefault();
        setArrastando(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setArrastando(false);
      }}
      onDrop={(e) => {
        if (comoQuem || !temArquivos(e)) return;
        e.preventDefault();
        setArrastando(false);
        juntarArquivos(Array.from(e.dataTransfer.files));
      }}
    >
      {arrastando && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-floresta bg-floresta-clara/80 text-floresta-texto">
          <p className="flex items-center gap-2 font-medium">
            <Paperclip size={18} aria-hidden /> Solte para anexar no {estilo.nome}
          </p>
        </div>
      )}
      <div className="flex items-center justify-between gap-2 border-b border-linha bg-superficie px-4 py-2 text-sm">
        <p className="flex items-center gap-1.5 text-muted">
          <estilo.icone size={14} aria-hidden /> {estilo.aviso}
        </p>
        <button
          type="button"
          onClick={() => setVerMembros((v) => !v)}
          aria-expanded={verMembros}
          className="flex shrink-0 items-center gap-1 rounded-md border border-linha px-2 py-1 hover:bg-superficie-2"
        >
          <Users size={14} /> Membros
        </button>
      </div>
      {verMembros && (
        <Membros
          missionId={missionId}
          channel={channel}
          podeGerenciar={podeGerenciar}
          souDiretoria={souDiretoria}
          onVerComo={(p) => setComoQuem(p)}
          onFechar={() => setVerMembros(false)}
        />
      )}
      {comoQuem && (
        <div role="status" className="flex items-center justify-between gap-2 border-y border-azul bg-superficie px-4 py-2 text-sm text-azul">
          <span className="flex items-center gap-1.5">
            <Eye size={15} /> Vendo como {comoQuem.nome}: é exatamente o que essa pessoa vê aqui.
          </span>
          <button type="button" onClick={() => setComoQuem(null)} className="rounded-md border border-azul px-2 py-0.5 hover:bg-superficie-2">
            Sair
          </button>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={rolagem.caixa} onScroll={rolagem.aoRolar} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {mensagens.isError && !comoQuem && (
          <p role="alert" className="text-vermelho">
            {erroTexto(mensagens.error)}
          </p>
        )}
        {lista && lista.length === 0 && (
          <p className="py-10 text-center text-muted">
            {comoQuem ? "Essa pessoa não vê nenhuma mensagem aqui." : `Nenhuma mensagem no ${estilo.nome} ainda.`}
          </p>
        )}
        <ul className="space-y-2">
          {lista?.map((m) => (
            <Fragment key={m.id}>
              {rolagem.divisor?.id === m.id && (
                <li>
                  <AvisoNaoLidas n={rolagem.divisor.n} />
                </li>
              )}
              <Linha m={m} meuId={meuId} bolha={estilo.bolha} missionId={missionId} />
            </Fragment>
          ))}
        </ul>
      </div>
      <SetaParaBaixo visivel={!rolagem.noFim || rolagem.naoLidasAbaixo > 0} naoLidas={rolagem.naoLidasAbaixo} onClick={rolagem.descer} />
      </div>

      {!comoQuem && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submeter();
          }}
          className="border-t border-linha bg-superficie px-4 py-3"
        >
          {erro && (
            <p role="alert" className="mb-2 text-sm text-vermelho">
              {erro}
            </p>
          )}
          {lendoPedido && <p className="mb-2 text-sm text-muted" aria-live="polite">A IA está lendo o pedido de alerta…</p>}
          {duvidaIA && (
            <p className="mb-2 text-sm" aria-live="polite">
              <b>Assistente:</b> {duvidaIA}
            </p>
          )}
          {(/^\/\S*$/.test(texto) || /^@i?a?$/i.test(texto)) && !comando && (
            <ul className="mb-2 grid gap-1 text-sm" aria-label="Comandos">
              <li>
                <button type="button" onClick={() => setTexto("/alerta ")} className="text-left hover:underline">
                  <b>/alerta</b> ou <b>@IA</b> <span className="text-muted">— pedir um alerta sobre os RDOs (ex.: me avise se não vier a metragem liberada por 2 dias)</span>
                </button>
              </li>
              {channel === "interno" && (
              <>
              <li>
                <button type="button" onClick={() => setTexto("/tarefa ")} className="text-left hover:underline">
                  <b>/tarefa</b> <span className="text-muted">— criar tarefa da missão (+pessoa, amanhã, às 15h, p1)</span>
                </button>
              </li>
              <li>
                <button type="button" onClick={() => setTexto("/lote")} className="text-left hover:underline">
                  <b>/lote</b> <span className="text-muted">— criar várias tarefas de uma vez</span>
                </button>
              </li>
              </>
              )}
            </ul>
          )}
          {comando?.[1] === "tarefa" && (
            <div className="mb-2 text-sm" aria-live="polite">
              {!previa ? (
                <p className="text-muted">
                  {projetoMissao.isError ? "Você não pode criar tarefas nesta missão." : "Escreva a tarefa: Conferir o RDO amanhã às 10h +pessoa p2"}
                </p>
              ) : (
                <ul className="flex flex-wrap gap-1.5" aria-label="Nova tarefa da missão">
                  <li className="rounded-full bg-floresta px-2 py-0.5 text-xs text-white">Tarefa: {previa.content || "…"}</li>
                  {previa.detected.map((d, i) => (
                    <li key={`${d.type}-${i}`} className="rounded-full bg-floresta-clara px-2 py-0.5 text-xs text-floresta-texto">
                      {d.label}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {comando?.[1] === "lote" && <p className="mb-2 text-sm text-muted">Enter abre o lote, já no projeto desta missão.</p>}
          {arquivos.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Arquivos para enviar">
              {arquivos.map((a, i) => (
                <li key={`${a.name}-${i}`} className="flex items-center gap-1.5 rounded-md border border-linha bg-superficie-2 px-2 py-1 text-xs">
                  <FileText size={13} aria-hidden /> <span className="max-w-48 truncate">{a.name}</span> <span className="text-muted">{tamanhoLegivel(a.size)}</span>
                  <button type="button" aria-label={`Tirar ${a.name}`} onClick={() => setArquivos((l) => l.filter((_, j) => j !== i))} className="text-muted hover:text-vermelho">
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {enviarArquivos.isPending && <p className="mb-2 text-sm text-muted" aria-live="polite">Enviando {arquivos.length === 1 ? "o arquivo" : "os arquivos"}…</p>}
          <div className="flex items-end gap-2">
            <input ref={seletor} type="file" multiple hidden onChange={(e) => juntarArquivos(Array.from(e.target.files ?? []))} />
            <button
              type="button"
              onClick={() => seletor.current?.click()}
              aria-label="Anexar arquivo"
              title="Anexar arquivo (ou arraste para o canal)"
              className="flex size-10 shrink-0 items-center justify-center rounded-md border border-linha hover:bg-superficie-2"
            >
              <Paperclip size={18} />
            </button>
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
                const colados = Array.from(e.clipboardData?.files ?? []);
                if (colados.length) {
                  e.preventDefault();
                  juntarArquivos(colados);
                }
              }}
              onKeyDown={teclas}
              rows={1}
              maxLength={8000}
              placeholder={channel === "interno" ? "Escreva no Interno… (/tarefa cria tarefa)" : `Escreva no ${estilo.nome}…`}
              aria-label={`Mensagem para o ${estilo.nome}`}
              className="max-h-40 min-h-10 flex-1 resize-y rounded-md border border-linha bg-superficie-2 px-3 py-2"
            />
            <button
              type="submit"
              disabled={
                arquivos.length
                  ? enviarArquivos.isPending
                  : !texto.trim() || enviar.isPending || criarDaConversa.isPending || (comando?.[1] === "tarefa" && !previa?.content)
              }
              aria-label={comando && !arquivos.length ? "Criar tarefa" : "Enviar"}
              className="flex size-10 items-center justify-center rounded-full bg-floresta text-white hover:bg-floresta-escura disabled:opacity-50"
            >
              <SendHorizontal size={18} />
            </button>
          </div>
        </form>
      )}
      {loteAberto && ctxTarefas.data && projetoMissao.data && (
        <LoteTarefas
          ctx={ctxTarefas.data}
          projetoAtivo={projetoMissao.data.id}
          onFechar={() => {
            setLoteAberto(false);
            setTexto("");
          }}
        />
      )}
    </div>
  );
}
