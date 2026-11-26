import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, CheckSquare, ChevronDown, ChevronRight, Info, Mail, MessageSquareText, Paperclip, PenLine, Reply, ReplyAll, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { enviarMensagem } from "../../lib/canais-fns.ts";
import { RegistrarNoPrisma } from "../prisma/NoPrisma.tsx";
import { registrarNoPrismaEmLote, type ResultadoDoLote } from "../../lib/prisma-fase6-fns.ts";
import {
  abrirEmail,
  contextoEnvio,
  desvincularEmail,
  enviarEmailDaMissao,
  listarEmailsDaMissao,
  salvarAssinatura,
  type ConversaEmail,
  type EmailAberto,
  type EmailResumo,
} from "../../lib/emails-fns.ts";
import { Carregando } from "../comum/Carregando.tsx";

/**
 * Aba E-mails da missão (Fase 4; INSTRUCOES §6.9): e-mails das caixas
 * autorizadas que se ligam à missão, com o motivo do vínculo. Só diretoria e
 * gerentes. Abrir um e-mail busca o texto no Microsoft 365 e fica registrado.
 */

const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "";
const tamanho = (b: number | null) => (b === null ? "" : b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);
const mensagemDeErro = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível abrir o e-mail agora.");

function Motivos({ m }: { m: EmailResumo["motivos"] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {m.map((x) => (
        <span key={`${x.motivo}-${x.detalhe}`} className="rounded-sm bg-floresta-clara px-1.5 py-0.5 text-[11px] text-floresta-texto">
          {x.detalhe}
        </span>
      ))}
    </span>
  );
}

function Comentar({ missionId, email }: { missionId: string; email: EmailAberto }) {
  const [texto, setTexto] = useState("");
  const [aberto, setAberto] = useState(false);
  const queryClient = useQueryClient();
  const enviar = useMutation({
    mutationFn: () =>
      enviarMensagem({
        data: { missionId, channel: "interno", body: `Sobre o e-mail "${email.assunto}" de ${email.de} (${quando(email.em)}):\n${texto.trim()}` },
      }),
    onSuccess: () => {
      setTexto("");
      setAberto(false);
      void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, "interno"] });
    },
  });
  if (!aberto) {
    return (
      <button type="button" onClick={() => setAberto(true)} className="flex items-center gap-1.5 text-sm text-floresta-texto hover:underline">
        <MessageSquareText size={16} aria-hidden /> Comentar no Interno
      </button>
    );
  }
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="text-muted">Comentário no Interno (o assunto e o remetente do e-mail vão junto)</span>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={3} maxLength={4000} className="mt-1 w-full rounded-md border border-linha bg-superficie p-2" />
      </label>
      {enviar.isError && <p className="text-sm text-vermelho">{mensagemDeErro(enviar.error)}</p>}
      {enviar.isSuccess && <p className="text-sm text-floresta-texto">Comentário enviado ao Interno.</p>}
      <div className="flex gap-2">
        <button type="button" disabled={!texto.trim() || enviar.isPending} onClick={() => enviar.mutate()} className="rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          Enviar ao Interno
        </button>
        <button type="button" onClick={() => setAberto(false)} className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-superficie-2">
          Cancelar
        </button>
      </div>
    </div>
  );
}

export type Rascunho = { para: string; cc: string; cco: string; assunto: string; texto: string; responderA?: string };
type AnexoEnviado = { nome: string; tipo: string; base64: string };
/** Limite do Graph por pedido (4 MB): até 3 MB de anexos no total. */
const MAX_ANEXOS = 3 * 1024 * 1024;
const kb = (b: number) => (b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);
const emBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(String(leitor.result).replace(/^data:[^,]*,/, ""));
    leitor.onerror = () => reject(leitor.error);
    leitor.readAsDataURL(f);
  });
/** "@nome" sendo digitado antes do cursor (para sugerir a pessoa). */
const mencaoNoCursor = (texto: string, cursor: number) => texto.slice(0, cursor).match(/(?:^|\s)@([\p{L}.\-]{0,30})$/u);
const lista = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
const enderecoDe = (s: string) => s.match(/<([^>]+)>/)?.[1] ?? s;

function useContextoEnvio() {
  return useQuery({ queryKey: ["emails", "contexto-envio"], queryFn: () => contextoEnvio(), staleTime: 60_000 });
}

/** Escrever ou responder um e-mail da própria caixa. Fora da produção, só ensaio. */
export function Escrever({
  missionId,
  inicial,
  sugestoes,
  onFechar,
  enviar: enviarFn,
}: {
  missionId?: string;
  inicial: Rascunho;
  sugestoes: string[];
  onFechar: () => void;
  /** Sem missão (aba E-mails): quem envia. */
  enviar?: (d: { para: string[]; cc: string[]; cco: string[]; assunto: string; texto: string; responderA?: string; anexos: AnexoEnviado[] }) => Promise<{ modo: "ensaio" | "real" }>;
}) {
  const idLista = `sugestoes-${missionId ?? "caixa"}`;
  const ctx = useContextoEnvio();
  const queryClient = useQueryClient();
  const [r, setR] = useState(inicial);
  const [mostrarCc, setMostrarCc] = useState(Boolean(inicial.cc || inicial.cco));
  const [editarAssinatura, setEditarAssinatura] = useState(false);
  const [assinatura, setAssinatura] = useState<string | null>(null);
  const [anexos, setAnexos] = useState<File[]>([]);
  const seletor = useRef<HTMLInputElement>(null);
  const mensagem = useRef<HTMLTextAreaElement>(null);
  // @menção: a pessoa sugerida entra em "Para" (como no Outlook).
  const [mencao, setMencao] = useState<{ termo: string; inicio: number } | null>(null);
  const [destaque, setDestaque] = useState(0);
  const totalAnexos = anexos.reduce((t, a) => t + a.size, 0);
  const juntarAnexos = (novos: File[]) => setAnexos((atuais) => [...atuais, ...novos].slice(0, 10));
  const enviar = useMutation({
    mutationFn: async () => {
      if (totalAnexos > MAX_ANEXOS) throw new Error("Anexos grandes demais: até 3 MB no total por e-mail.");
      const anexosEnviados = await Promise.all(anexos.map(async (a) => ({ nome: a.name, tipo: a.type || "application/octet-stream", base64: await emBase64(a) })));
      const d = { para: lista(r.para), cc: lista(r.cc), cco: lista(r.cco), assunto: r.assunto, texto: r.texto, anexos: anexosEnviados, ...(r.responderA ? { responderA: r.responderA } : {}) };
      if (enviarFn) return enviarFn(d);
      return enviarEmailDaMissao({ data: { missionId: missionId!, ...d } });
    },
  });
  const salvar = useMutation({
    mutationFn: (a: string) => salvarAssinatura({ data: { assinatura: a } }),
    onSuccess: () => {
      setEditarAssinatura(false);
      void queryClient.invalidateQueries({ queryKey: ["emails", "contexto-envio"] });
    },
  });
  if (ctx.isPending) return <Carregando />;
  if (ctx.isError) return <p className="text-sm text-vermelho">Não foi possível preparar o envio.</p>;
  if (!ctx.data.caixa) {
    return (
      <div className="rounded-md bg-superficie-2 p-3 text-sm">
        Sua caixa de e-mail ainda não está conectada ao Omni (ela entra sozinha no seu primeiro acesso, se estiver liberada no Microsoft 365).{" "}
        <button type="button" onClick={onFechar} className="text-floresta-texto hover:underline">
          Fechar
        </button>
      </div>
    );
  }
  if (enviar.isSuccess) {
    return (
      <div className="rounded-md bg-floresta-clara p-3 text-sm text-floresta-texto">
        {enviar.data.modo === "ensaio"
          ? "Ensaio registrado: o e-mail foi montado com a sua assinatura, mas não foi enviado (fora da produção o Omni não envia e-mails)."
          : "E-mail enviado. Ele aparece aqui na próxima leitura da caixa."}{" "}
        <button type="button" onClick={onFechar} className="font-medium hover:underline">
          Fechar
        </button>
      </div>
    );
  }
  const campo = "w-full rounded-md border border-linha bg-superficie px-2 py-1.5 text-sm";
  const assinaturaAtual = assinatura ?? ctx.data.assinatura;
  const sugeridas = mencao
    ? ctx.data.pessoas
        .filter((p) => {
          const t = mencao.termo.toLowerCase();
          return !t || p.nome.toLowerCase().split(/\s+/).some((parte) => parte.startsWith(t)) || p.nome.toLowerCase().startsWith(t) || String(p.email).toLowerCase().startsWith(t);
        })
        .slice(0, 6)
    : [];
  const mencionar = (p: { nome: string; email: string }) => {
    if (!mencao) return;
    const cursor = mensagem.current?.selectionStart ?? r.texto.length;
    const texto = `${r.texto.slice(0, mencao.inicio)}@${p.nome} ${r.texto.slice(cursor)}`;
    const email = String(p.email).toLowerCase();
    const jaEsta = [...lista(r.para), ...lista(r.cc), ...lista(r.cco)].some((x) => enderecoDe(x).toLowerCase() === email);
    setR({ ...r, texto, para: jaEsta ? r.para : [r.para.trim(), email].filter(Boolean).join(", ") });
    setMencao(null);
    const pos = mencao.inicio + p.nome.length + 2;
    requestAnimationFrame(() => {
      mensagem.current?.focus();
      mensagem.current?.setSelectionRange(pos, pos);
    });
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        enviar.mutate();
      }}
      className="space-y-2 rounded-lg border border-linha bg-superficie p-3"
    >
      <datalist id={idLista}>
        {sugestoes.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      {ctx.data.modo !== "real" && (
        <p className="rounded-md bg-superficie-2 px-2 py-1.5 text-xs text-muted">
          {ctx.data.modo === "ensaio"
            ? "Modo de ensaio: o e-mail é montado e registrado, mas não sai (fora da produção)."
            : "O envio de e-mail pelo Omni está desligado."}
        </p>
      )}
      <p className="text-xs text-muted">De: {ctx.data.caixa}</p>
      <label className="block text-sm">
        <span className="text-muted">Para</span>
        <input value={r.para} onChange={(e) => setR({ ...r, para: e.target.value })} list={idLista} required className={campo} placeholder="nome@cliente.com.br, outro@…" />
      </label>
      {mostrarCc ? (
        <>
          <label className="block text-sm">
            <span className="text-muted">Cc</span>
            <input value={r.cc} onChange={(e) => setR({ ...r, cc: e.target.value })} list={idLista} className={campo} />
          </label>
          <label className="block text-sm">
            <span className="text-muted">Cco</span>
            <input value={r.cco} onChange={(e) => setR({ ...r, cco: e.target.value })} list={idLista} className={campo} />
          </label>
        </>
      ) : (
        <button type="button" onClick={() => setMostrarCc(true)} className="text-xs text-floresta-texto hover:underline">
          Cc e Cco
        </button>
      )}
      <label className="block text-sm">
        <span className="text-muted">Assunto</span>
        <input value={r.assunto} onChange={(e) => setR({ ...r, assunto: e.target.value })} required maxLength={300} className={campo} />
      </label>
      <div className="relative block text-sm">
        <label htmlFor={`${idLista}-mensagem`} className="text-muted">
          Mensagem <span className="text-xs">(@ menciona alguém e o põe em Para)</span>
        </label>
        <textarea
          id={`${idLista}-mensagem`}
          ref={mensagem}
          value={r.texto}
          onChange={(e) => {
            setR({ ...r, texto: e.target.value });
            const m = mencaoNoCursor(e.target.value, e.target.selectionStart);
            setMencao(m ? { termo: m[1] ?? "", inicio: e.target.selectionStart - (m[1]?.length ?? 0) - 1 } : null);
            setDestaque(0);
          }}
          onKeyDown={(e) => {
            if (!mencao || !sugeridas.length) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setDestaque((d) => (d + (e.key === "ArrowDown" ? 1 : sugeridas.length - 1)) % sugeridas.length);
            } else if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              mencionar(sugeridas[destaque] ?? sugeridas[0]!);
            } else if (e.key === "Escape") setMencao(null);
          }}
          onPaste={(e) => {
            const colados = Array.from(e.clipboardData?.files ?? []);
            if (colados.length) {
              e.preventDefault();
              juntarAnexos(colados);
            }
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            juntarAnexos(Array.from(e.dataTransfer.files));
          }}
          required
          rows={6}
          maxLength={20000}
          aria-autocomplete="list"
          aria-expanded={Boolean(mencao && sugeridas.length)}
          className={campo}
        />
        {mencao && sugeridas.length > 0 && (
          <ul role="listbox" aria-label="Mencionar" className="absolute left-2 z-20 mt-1 w-72 overflow-hidden rounded-md border border-linha bg-superficie shadow-lg">
            {sugeridas.map((p, i) => (
              <li key={String(p.email)} role="option" aria-selected={i === destaque}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    mencionar(p);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${i === destaque ? "bg-floresta-clara" : "hover:bg-superficie-2"}`}
                >
                  <AtSign size={14} aria-hidden className="shrink-0 text-floresta-texto" />
                  <span className="min-w-0">
                    <span className="block truncate">{p.nome}</span>
                    <span className="block truncate text-xs text-muted">{String(p.email)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="space-y-1 text-sm">
        <input ref={seletor} type="file" multiple hidden onChange={(e) => juntarAnexos(Array.from(e.target.files ?? []))} />
        {anexos.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Anexos">
            {anexos.map((a, i) => (
              <li key={`${a.name}-${i}`} className="flex items-center gap-1.5 rounded-md border border-linha bg-superficie-2 px-2 py-1 text-xs">
                <Paperclip size={12} aria-hidden /> <span className="max-w-48 truncate">{a.name}</span> <span className="text-muted">{kb(a.size)}</span>
                <button type="button" aria-label={`Tirar ${a.name}`} onClick={() => setAnexos((l) => l.filter((_, j) => j !== i))} className="text-muted hover:text-vermelho">
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => seletor.current?.click()} className="flex items-center gap-1 text-xs text-floresta-texto hover:underline">
            <Paperclip size={13} aria-hidden /> Anexar arquivo
          </button>
          <span className={`text-xs ${totalAnexos > MAX_ANEXOS ? "text-vermelho" : "text-muted"}`}>
            {anexos.length ? `${kb(totalAnexos)} de 3 MB` : "até 3 MB no total (arraste ou cole na mensagem)"}
          </span>
        </div>
      </div>
      <div className="text-xs text-muted">
        {editarAssinatura ? (
          <div className="space-y-1">
            <textarea value={assinaturaAtual} onChange={(e) => setAssinatura(e.target.value)} rows={4} maxLength={2000} className={campo} aria-label="Sua assinatura" />
            <button type="button" disabled={salvar.isPending} onClick={() => salvar.mutate(assinaturaAtual)} className="rounded-md bg-floresta px-2 py-1 font-medium text-white">
              Salvar assinatura
            </button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <span className="whitespace-pre-wrap">{assinaturaAtual ? `-- \n${assinaturaAtual}` : "Sem assinatura."}</span>
            <button type="button" onClick={() => setEditarAssinatura(true)} className="flex shrink-0 items-center gap-1 text-floresta-texto hover:underline">
              <PenLine size={12} aria-hidden /> {assinaturaAtual ? "Editar" : "Criar"} assinatura
            </button>
          </div>
        )}
      </div>
      {enviar.isError && <p className="text-sm text-vermelho">{mensagemDeErro(enviar.error)}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={enviar.isPending || ctx.data.modo === "desligado" || totalAnexos > MAX_ANEXOS} className="flex items-center gap-1.5 rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          <Send size={14} aria-hidden /> {ctx.data.modo === "real" ? "Enviar" : "Enviar (ensaio)"}
        </button>
        <button type="button" onClick={onFechar} className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-superficie-2">
          Cancelar
        </button>
      </div>
    </form>
  );
}

/** Vínculo errado: tira o e-mail desta missão (a sincronização não religa). */
function Desvincular({ messageId, missionId }: { messageId: string; missionId: string }) {
  const queryClient = useQueryClient();
  const [confirmar, setConfirmar] = useState(false);
  const tirar = useMutation({
    mutationFn: () => desvincularEmail({ data: { messageId, missionId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["emails", missionId] }),
  });
  if (!confirmar) {
    return (
      <button type="button" onClick={() => setConfirmar(true)} className="text-xs text-muted hover:text-ink hover:underline">
        Não é desta missão
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>Tirar este e-mail da missão? Ele não volta a ser ligado a ela.</span>
      <button type="button" disabled={tirar.isPending} onClick={() => tirar.mutate()} className="rounded-md bg-vermelho px-2 py-1 font-medium text-white disabled:opacity-50">
        Tirar da missão
      </button>
      <button type="button" onClick={() => setConfirmar(false)} className="rounded-md px-2 py-1 text-muted hover:bg-superficie-2">
        Cancelar
      </button>
      {tirar.isError && <span className="text-vermelho">{mensagemDeErro(tirar.error)}</span>}
    </div>
  );
}

function Mensagem({ e, missionId, podeComentar, sugestoes }: { e: EmailResumo; missionId: string; podeComentar: boolean; sugestoes: string[] }) {
  const [aberta, setAberta] = useState(false);
  const [resposta, setResposta] = useState<Rascunho | null>(null);
  const ctx = useContextoEnvio();
  const abrir = useMutation({ mutationFn: (permitirExternas: boolean = false) => abrirEmail({ data: { messageId: e.id, permitirExternas } }) });
  const alternar = () => {
    if (!aberta && !abrir.data && !abrir.isPending) abrir.mutate(false);
    setAberta(!aberta);
  };
  return (
    <li className="border-t border-linha first:border-t-0">
      <button type="button" onClick={alternar} aria-expanded={aberta} className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-superficie-2">
        {aberta ? <ChevronDown size={16} className="mt-0.5 shrink-0" aria-hidden /> : <ChevronRight size={16} className="mt-0.5 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className={`truncate ${e.abertoPorMim ? "" : "font-semibold"}`}>{e.de}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{quando(e.em)}</span>
          </span>
          {!aberta && e.previa && <span className="block truncate text-sm text-muted">{e.previa}</span>}
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <Motivos m={e.motivos} />
            {e.anexos && <Paperclip size={14} className="text-muted" aria-label="Tem anexos" />}
          </span>
        </span>
      </button>
      {aberta && (
        <div className="space-y-3 px-3 pb-4 pl-9">
          {abrir.isPending && <p className="text-sm text-muted">Abrindo…</p>}
          {abrir.isError && <p className="rounded-md bg-superficie-2 p-3 text-sm">{mensagemDeErro(abrir.error)}</p>}
          {abrir.data && (
            <>
              <dl className="grid gap-0.5 text-xs text-muted">
                <div>
                  <dt className="inline">De: </dt>
                  <dd className="inline text-ink">{abrir.data.de}</dd>
                </div>
                {abrir.data.para.length > 0 && (
                  <div>
                    <dt className="inline">Para: </dt>
                    <dd className="inline">{abrir.data.para.join(", ")}</dd>
                  </div>
                )}
                {abrir.data.cc.length > 0 && (
                  <div>
                    <dt className="inline">Cc: </dt>
                    <dd className="inline">{abrir.data.cc.join(", ")}</dd>
                  </div>
                )}
              </dl>
              <CorpoEmail email={abrir.data} carregando={abrir.isPending} mostrarExternas={() => abrir.mutate(true)} />
              {abrir.data.anexos.length > 0 && (
                <ul className="flex flex-wrap gap-2 text-xs">
                  {abrir.data.anexos.map((a) => (
                    <li key={a.id}>
                      {a.arquivo ? (
                        <a
                          href={`/api/emails/${e.id}/anexos/${encodeURIComponent(a.id)}`}
                          download
                          className="flex items-center gap-1 rounded-md border border-linha px-2 py-1 hover:bg-superficie-2"
                          aria-label={`Baixar ${a.nome}`}
                        >
                          <Paperclip size={12} aria-hidden /> {a.nome}
                          {a.tamanho !== null && <span className="text-muted">· {tamanho(a.tamanho)}</span>}
                        </a>
                      ) : (
                        <span className="flex items-center gap-1 rounded-md border border-linha px-2 py-1 text-muted" title="Anexo que não é arquivo: abra no Outlook">
                          <Paperclip size={12} aria-hidden /> {a.nome}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {resposta ? (
                <Escrever missionId={missionId} inicial={resposta} sugestoes={sugestoes} onFechar={() => setResposta(null)} />
              ) : (
                <div className="flex flex-wrap gap-3 text-sm">
                  {(() => {
                    const dados = abrir.data;
                    const minha = ctx.data?.caixa?.toLowerCase();
                    const assunto = /^(re|res)\s*:/i.test(dados.assunto) ? dados.assunto : `RE: ${dados.assunto}`;
                    const remetente = e.deEndereco ?? enderecoDe(dados.de);
                    const todos = [...dados.para, ...dados.cc].map(enderecoDe).filter((x) => x.toLowerCase() !== minha && x !== remetente);
                    return (
                      <>
                        <button type="button" onClick={() => setResposta({ para: remetente, cc: "", cco: "", assunto, texto: "", responderA: e.id })} className="flex items-center gap-1.5 text-floresta-texto hover:underline">
                          <Reply size={16} aria-hidden /> Responder
                        </button>
                        <button type="button" onClick={() => setResposta({ para: remetente, cc: todos.join(", "), cco: "", assunto, texto: "", responderA: e.id })} className="flex items-center gap-1.5 text-floresta-texto hover:underline">
                          <ReplyAll size={16} aria-hidden /> Responder a todos
                        </button>
                      </>
                    );
                  })()}
                </div>
              )}
              {podeComentar && <Comentar missionId={missionId} email={abrir.data} />}
              <RegistrarNoPrisma origem="email" id={e.id} missionId={missionId} />
              <Desvincular messageId={e.id} missionId={missionId} />
              <p className="text-xs text-muted">Aberto por: {abrir.data.leituras.map((l) => `${l.nome} (${quando(l.em)})`).join(", ")}</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}

function Conversa({
  c,
  missionId,
  podeComentar,
  sugestoes,
  selecao,
}: {
  c: ConversaEmail;
  missionId: string;
  podeComentar: boolean;
  sugestoes: string[];
  /** Modo "Registrar no Prisma…": marcar o fio inteiro. */
  selecao?: { marcada: boolean; alternar: () => void };
}) {
  const [aberta, setAberta] = useState(false);
  const remetentes = [...new Set(c.mensagens.map((m) => m.de))];
  const motivos = [...new Map(c.mensagens.flatMap((m) => m.motivos).map((x) => [x.detalhe, x])).values()];
  return (
    <li className={`flex rounded-lg border bg-superficie ${selecao?.marcada ? "border-floresta" : "border-linha"}`}>
      {selecao && (
        <label className="flex shrink-0 cursor-pointer items-start py-3 pl-3">
          <input type="checkbox" checked={selecao.marcada} onChange={selecao.alternar} aria-label={`Selecionar ${c.assunto}`} className="mt-1" />
        </label>
      )}
      <div className="min-w-0 flex-1">
      <button type="button" onClick={() => setAberta(!aberta)} aria-expanded={aberta} className="flex w-full items-start gap-3 p-3 text-left hover:bg-superficie-2">
        <Mail size={18} className="mt-0.5 shrink-0 text-floresta-texto" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className="truncate font-medium">{c.assunto}</span>
            <span className="shrink-0 text-xs text-muted tabular-nums">{quando(c.ultimoEm)}</span>
          </span>
          <span className="block truncate text-sm text-muted">
            {remetentes.slice(0, 3).join(", ")}
            {remetentes.length > 3 ? ` e mais ${remetentes.length - 3}` : ""} · {c.mensagens.length} {c.mensagens.length === 1 ? "e-mail" : "e-mails"}
          </span>
          <span className="mt-1 block">
            <Motivos m={motivos} />
          </span>
        </span>
      </button>
      {aberta && (
        <ul className="border-t border-linha">
          {c.mensagens.map((m) => (
            <Mensagem key={m.id} e={m} missionId={missionId} podeComentar={podeComentar} sugestoes={sugestoes} />
          ))}
        </ul>
      )}
      </div>
    </li>
  );
}

/** Resumo do registro em lote no Prisma. */
function ResultadoLote({ r, fechar }: { r: ResultadoDoLote[]; fechar: () => void }) {
  const n = (s: ResultadoDoLote["situacao"]) => r.filter((x) => x.situacao === s).length;
  const erros = [...new Set(r.filter((x) => x.situacao === "erro").map((x) => x.mensagem ?? "Não foi possível registrar."))];
  return (
    <div role="status" className="space-y-1 rounded-lg border border-linha bg-superficie p-3 text-sm">
      <p className="font-medium">
        {n("registrado")} registrado{n("registrado") === 1 ? "" : "s"} no Prisma
        {n("ja_registrado") ? ` · ${n("ja_registrado")} já estava${n("ja_registrado") === 1 ? "" : "m"}` : ""}
        {n("erro") ? ` · ${n("erro")} não ${n("erro") === 1 ? "pôde" : "puderam"} ser registrado${n("erro") === 1 ? "" : "s"}` : ""}
      </p>
      {erros.map((e) => (
        <p key={e} className="text-xs text-vermelho">
          {e}
        </p>
      ))}
      <button type="button" onClick={fechar} className="text-xs text-muted underline">
        Fechar
      </button>
    </div>
  );
}

export function useEmailsDaMissao(missionId: string) {
  return useQuery({ queryKey: ["emails", missionId], queryFn: () => listarEmailsDaMissao({ data: { missionId } }) });
}

export function EmailsDaMissao({ missionId, missionCode, podeComentar }: { missionId: string; missionCode: string; podeComentar: boolean }) {
  const q = useEmailsDaMissao(missionId);
  const ctx = useContextoEnvio();
  const [novo, setNovo] = useState(false);
  // Registro em lote no Prisma: fios marcados → cada e-mail vira feedback (não duplica).
  const [selecionando, setSelecionando] = useState(false);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const lote = useMutation({
    mutationFn: (ids: string[]) => registrarNoPrismaEmLote({ data: { itens: ids.map((id) => ({ origem: "email" as const, id, missionId })) } }),
    onSuccess: () => {
      setSelecionando(false);
      setMarcadas(new Set());
    },
  });
  if (q.isPending) return <Carregando className="p-5" />;
  if (q.isError) return <p className="p-5 text-sm text-vermelho">Não foi possível carregar os e-mails da missão.</p>;
  if (!q.data.podeVer) return <p className="p-5 text-sm text-muted">Os e-mails da missão são para a diretoria e os gerentes.</p>;
  // Sugestões: participantes dos e-mails da missão e pessoas da empresa.
  const sugestoes = [
    ...new Set([
      ...q.data.conversas.flatMap((c) => c.mensagens.flatMap((m) => [m.deEndereco, ...m.para.map((d) => d.endereco), ...m.cc.map((d) => d.endereco)])),
      ...(ctx.data?.pessoas.map((p) => p.email) ?? []),
    ]),
  ].filter((x): x is string => Boolean(x));
  return (
    <div className="flex-1 space-y-3 overflow-y-auto p-5">
      {novo ? (
        <Escrever missionId={missionId} inicial={{ para: "", cc: "", cco: "", assunto: `${missionCode} - `, texto: "" }} sugestoes={sugestoes} onFechar={() => setNovo(false)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => setNovo(true)} className="flex items-center gap-1.5 rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white">
            <PenLine size={14} aria-hidden /> Novo e-mail
          </button>
          {q.data.conversas.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setSelecionando(!selecionando);
                setMarcadas(new Set());
                lote.reset();
              }}
              aria-pressed={selecionando}
              className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2"
            >
              <CheckSquare size={14} aria-hidden /> {selecionando ? "Cancelar seleção" : "Registrar no Prisma…"}
            </button>
          )}
        </div>
      )}
      {selecionando && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-floresta bg-superficie p-2.5 text-sm shadow-sm">
          <span className="flex-1">
            {(() => {
              const fios = q.data.conversas.filter((c) => marcadas.has(c.id));
              const n = fios.reduce((t, c) => t + c.mensagens.length, 0);
              return fios.length ? `${fios.length} ${fios.length === 1 ? "fio" : "fios"} · ${n} ${n === 1 ? "e-mail" : "e-mails"}` : "Marque os fios que vão para o Prisma.";
            })()}
          </span>
          <button
            type="button"
            onClick={() => setMarcadas(marcadas.size === q.data.conversas.length ? new Set() : new Set(q.data.conversas.map((c) => c.id)))}
            className="rounded-md px-2 py-1 text-xs text-muted hover:text-ink"
          >
            {marcadas.size === q.data.conversas.length ? "Desmarcar todos" : "Marcar todos"}
          </button>
          <button
            type="button"
            disabled={!marcadas.size || lote.isPending}
            onClick={() => lote.mutate(q.data.conversas.filter((c) => marcadas.has(c.id)).flatMap((c) => c.mensagens.map((m) => m.id)).slice(0, 50))}
            title="Cada e-mail vira um feedback no Prisma, no contato do cliente, em seu nome (até 50 por vez)"
            className="flex items-center gap-1.5 rounded-md bg-floresta px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            <Send size={14} aria-hidden /> {lote.isPending ? "Registrando…" : "Registrar no Prisma"}
          </button>
        </div>
      )}
      {lote.isError && (
        <p role="alert" className="text-sm text-vermelho">
          {lote.error instanceof Error ? lote.error.message : "Não foi possível registrar."}
        </p>
      )}
      {lote.isSuccess && <ResultadoLote r={lote.data} fechar={() => lote.reset()} />}
      <p className="flex items-start gap-2 text-sm text-muted">
        <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
        <span>
          E-mails das caixas autorizadas ligados a esta missão pelo número da missão, por proposta ou NF citada, ou pelo domínio do cliente. Abrir um
          e-mail fica registrado.
        </span>
      </p>
      {q.data.conversas.length === 0 ? (
        <div className="rounded-lg border border-linha bg-superficie p-6 text-center text-sm text-muted">
          <Mail size={22} className="mx-auto mb-2" aria-hidden />
          Nenhum e-mail ligado a esta missão nas caixas autorizadas.
        </div>
      ) : (
        <ul className="space-y-2">
          {q.data.conversas.map((c) => (
            <Conversa
              key={c.id}
              c={c}
              missionId={missionId}
              podeComentar={podeComentar}
              sugestoes={sugestoes}
              selecao={
                selecionando
                  ? {
                      marcada: marcadas.has(c.id),
                      alternar: () => {
                        const n = new Set(marcadas);
                        if (n.has(c.id)) n.delete(c.id);
                        else n.add(c.id);
                        setMarcadas(n);
                      },
                    }
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Corpo do e-mail: o HTML (já limpo no servidor) num iframe isolado — sem
 * scripts, com CSP que só carrega imagens embutidas (e as externas, se a
 * pessoa liberar) e fundo branco como o e-mail foi feito. "Ver como texto" volta ao texto puro.
 */
export function CorpoEmail({ email, carregando, mostrarExternas }: { email: EmailAberto; carregando: boolean; mostrarExternas: () => void }) {
  const [comoTexto, setComoTexto] = useState(false);
  const [altura, setAltura] = useState(160);
  const quadro = useRef<HTMLIFrameElement>(null);
  const medir = () => {
    const doc = quadro.current?.contentDocument;
    if (doc?.documentElement) setAltura(Math.min(Math.max(doc.documentElement.scrollHeight, 80), 20000));
  };
  useEffect(() => {
    const doc = quadro.current?.contentDocument;
    if (!doc) return;
    // Imagens externas liberadas chegam depois: mede de novo quando cada uma carrega.
    const imgs = Array.from(doc.images);
    imgs.forEach((i) => i.addEventListener("load", medir));
    return () => imgs.forEach((i) => i.removeEventListener("load", medir));
  });
  if (!email.html || comoTexto) {
    return (
      <div className="space-y-1">
        <div className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-linha bg-fundo p-3 text-sm">{email.texto.trim() || "(sem texto)"}</div>
        {email.html && (
          <button type="button" onClick={() => setComoTexto(false)} className="text-xs text-floresta-texto underline">
            Ver formatado
          </button>
        )}
      </div>
    );
  }
  // 'proxy' na política = só o caminho do proxy de imagens do Omni (nada mais da origem).
  const politica = email.politica.replace("'proxy'", `${typeof location === "undefined" ? "" : location.origin}/api/email/imagem`);
  // Padrão do Outlook (Aptos/Calibri 11pt); o CSS do próprio e-mail vem depois e vale sobre este.
  const documento = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${politica}"><base target="_blank"><style>html,body{margin:0;background:#fff;color:#000}body{padding:12px 16px;font:11pt/1.35 Aptos,Calibri,Carlito,"Segoe UI",Arial,sans-serif;overflow-wrap:break-word}img{max-width:100%;height:auto}img[data-omni-externa]{display:none}a{color:#0563c1}</style></head><body>${email.html}</body></html>`;
  return (
    <div className="space-y-1">
      {email.externasBloqueadas > 0 && (
        <p className="flex flex-wrap items-center gap-2 rounded-md bg-superficie-2 px-3 py-1.5 text-xs text-muted">
          {email.externasBloqueadas === 1 ? "1 imagem da internet bloqueada" : `${email.externasBloqueadas} imagens da internet bloqueadas`} para proteger a sua
          privacidade (algumas avisam o remetente que o e-mail foi aberto).
          <button type="button" disabled={carregando} onClick={mostrarExternas} className="font-medium text-floresta-texto underline">
            Mostrar imagens
          </button>
        </p>
      )}
      <iframe
        ref={quadro}
        title={`E-mail: ${email.assunto}`}
        srcDoc={documento}
        // Sem allow-scripts: nada executa. allow-same-origin só para medir a altura; links abrem em outra aba.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        onLoad={medir}
        style={{ height: altura }}
        className="w-full rounded-md border border-linha bg-white"
      />
      <button type="button" onClick={() => setComoTexto(true)} className="text-xs text-floresta-texto underline">
        Ver como texto
      </button>
    </div>
  );
}

