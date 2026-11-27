import { formatarTelefone } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CheckSquare,
  ChevronDown,
  Copy,
  Download,
  Forward,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Star,
  StarOff,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { ConversaResumo, DetalhesDaConversa, MensagemWhatsApp } from "../../lib/conversas-fns.ts";
import { detalhesDaConversa } from "../../lib/conversas-fns.ts";
import { abrirConversaNova } from "../../lib/whatsapp-aparelho-fns.ts";
import {
  apagarMensagem,
  editarMensagem,
  encaminharMensagens,
  favoritarMensagem,
  fixarMensagem,
  reagirMensagem,
  salvarContatoWhatsApp,
} from "../../lib/whatsapp-acoes-fns.ts";

/**
 * Ações nas mensagens do WhatsApp, como no WhatsApp Web: o menu de cada mensagem (seta ao passar
 * o mouse ou botão direito), reagir, responder citando, encaminhar, copiar, fixar, favoritar,
 * selecionar várias, baixar, conversar em particular (grupo), editar e apagar.
 */

export const REACOES = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente de novo.");
const chaveDetalhes = (chatId: string) => ["whatsapp", "detalhes", chatId];

export function useDetalhesDaConversa(chatId: string) {
  return useQuery({ queryKey: chaveDetalhes(chatId), queryFn: () => detalhesDaConversa({ data: { chatId } }), staleTime: 15_000 });
}

type Acoes = {
  conversa: ConversaResumo;
  detalhes: DetalhesDaConversa | undefined;
  /** Mensagens carregadas (para achar a citada e o nome de quem escreveu). */
  mensagens: MensagemWhatsApp[];
  responder: (m: MensagemWhatsApp) => void;
  editar: (m: MensagemWhatsApp) => void;
  encaminhar: (ms: MensagemWhatsApp[]) => void;
  selecionadas: Set<string> | null;
  alternarSelecao: (m: MensagemWhatsApp) => void;
  irPara: (waId: string) => void;
  aviso: (texto: string) => void;
};
const Contexto = createContext<Acoes | null>(null);
export const ProvedorDeAcoes = Contexto.Provider;
export const useAcoes = () => useContext(Contexto);

const chaveDe = (m: MensagemWhatsApp) => m.waId ?? null;

/** Nome de quem escreveu a citada: "Você", o nome que veio nas mensagens ou o telefone. */
export function nomeDaCitada(citada: NonNullable<MensagemWhatsApp["citada"]>, mensagens: MensagemWhatsApp[], meuJid: string | null): string {
  const original = mensagens.find((m) => m.waId === citada.waId);
  if (original) return original.deMim ? "Você" : (original.autor ?? "Contato");
  if (!citada.autorId || citada.autorId === meuJid) return "Você";
  return mensagens.find((m) => m.autorId === citada.autorId)?.autor ?? formatarTelefone(citada.autorId.match(/^(\d{8,15})@/)?.[1] ?? null) ?? "Contato";
}

/** Bloco da mensagem citada dentro do balão (tocar leva até ela). */
export function CitacaoNoBalao({ m }: { m: MensagemWhatsApp }) {
  const a = useAcoes();
  if (!m.citada || !a) return null;
  return (
    <button
      type="button"
      onClick={() => a.irPara(m.citada!.waId)}
      className={`mb-1 block w-full rounded-md border-l-4 border-azul px-2 py-1 text-left text-xs ${m.deMim ? "bg-black/15" : "bg-superficie-2"}`}
    >
      <span className="block font-semibold text-azul">{nomeDaCitada(m.citada, a.mensagens, null)}</span>
      <span className={`line-clamp-2 ${m.deMim ? "text-white/85" : "text-muted"}`}>{m.citada.texto ?? "Mensagem"}</span>
    </button>
  );
}

/** Reações embaixo do balão (cada emoji com quantos; tocar no meu tira a reação). */
export function ReacoesDoBalao({ m }: { m: MensagemWhatsApp }) {
  const a = useAcoes();
  const reagir = useReagir();
  const lista = (m.waId && a?.detalhes?.reacoes[m.waId]) || [];
  if (!lista.length || !a) return null;
  return (
    <div className={`-mt-1.5 mb-1 flex ${m.deMim ? "justify-end pr-2" : "justify-start pl-2"}`}>
      <div className="flex gap-1 rounded-full border border-linha bg-superficie px-1.5 py-0.5 text-sm shadow-sm">
        {lista.map((r) => (
          <button
            key={r.emoji}
            type="button"
            title={r.quem.join(", ")}
            disabled={!a.conversa.podeResponder}
            onClick={() => r.minha && reagir.mutate({ m, emoji: "", conversa: a.conversa })}
            className={`flex items-center gap-0.5 rounded-full px-1 ${r.minha ? "bg-floresta-clara" : ""}`}
          >
            {r.emoji}
            {r.quantos > 1 && <span className="text-[11px] text-muted">{r.quantos}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function useInvalidar(chatId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: chaveDetalhes(chatId) });
    void qc.invalidateQueries({ queryKey: ["whatsapp", "mensagens", chatId] });
  };
}

function useReagir() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ m, emoji, conversa }: { m: MensagemWhatsApp; emoji: string; conversa: ConversaResumo }) =>
      reagirMensagem({ data: { chatId: conversa.id, waId: m.waId!, deMim: m.deMim, autorId: m.autorId ?? null, emoji } }),
    onSettled: (_r, _e, v) => void qc.invalidateQueries({ queryKey: chaveDetalhes(v.conversa.id) }),
  });
}

/** Seta do menu (ao passar o mouse) + menu; o botão direito no balão abre o mesmo menu. */
export function MenuDaMensagem({ m, children }: { m: MensagemWhatsApp; children: ReactNode }) {
  const a = useAcoes();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [emojis, setEmojis] = useState(false);
  const [contato, setContato] = useState(false);
  const reagir = useReagir();
  const invalidar = useInvalidar(a?.conversa.id ?? "");
  const acao = useMutation({
    mutationFn: async (f: () => Promise<unknown>) => f(),
    onSuccess: invalidar,
    onError: (e) => a?.aviso(erroDe(e)),
  });
  useEffect(() => {
    if (!pos) return;
    const fechar = () => (setPos(null), setEmojis(false));
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("click", fechar);
    window.addEventListener("scroll", fechar, true);
    window.addEventListener("keydown", tecla);
    return () => {
      window.removeEventListener("click", fechar);
      window.removeEventListener("scroll", fechar, true);
      window.removeEventListener("keydown", tecla);
    };
  }, [pos]);
  if (!a || !m.waId || m.pendente || m.ensaio || m.chamada) return <>{children}</>;
  const c = a.conversa;
  const waId = m.waId;
  const responde = c.podeResponder;
  const temMidia = ["imagem", "video", "audio", "documento", "figurinha"].includes(m.tipo) && !m.apagada;
  const favorita = a.detalhes?.favoritas.includes(waId) ?? false;
  const fixada = a.detalhes?.fixadas.includes(waId) ?? false;
  const recente = Date.now() - Date.parse(m.em);
  const telefoneDoAutor = m.autorId?.match(/^(\d{8,15})@s\.whatsapp\.net$/)?.[1] ?? null;
  const abrir = (x: number, y: number) => setPos({ x: Math.min(x, window.innerWidth - 250), y: Math.min(y, window.innerHeight - 420) });
  const itens: Array<{ rotulo: string; icone: typeof Reply; fazer: () => void; perigo?: boolean } | null> = [
    responde && !m.apagada ? { rotulo: "Responder", icone: Reply, fazer: () => a.responder(m) } : null,
    responde && !m.apagada ? { rotulo: "Reagir", icone: SmilePlus, fazer: () => setEmojis(true) } : null,
    !m.apagada ? { rotulo: "Encaminhar", icone: Forward, fazer: () => a.encaminhar([m]) } : null,
    m.texto && !m.apagada ? { rotulo: "Copiar", icone: Copy, fazer: () => void navigator.clipboard.writeText(m.texto!).then(() => a.aviso("Copiada.")) } : null,
    temMidia ? { rotulo: "Baixar", icone: Download, fazer: () => window.open(`${m.midia ?? `/api/whatsapp/midia/${m.id}`}?baixar=1`, "_blank", "noopener") } : null,
    responde && !m.apagada
      ? { rotulo: fixada ? "Desafixar" : "Fixar", icone: fixada ? PinOff : Pin, fazer: () => acao.mutate(() => fixarMensagem({ data: { chatId: c.id, waId, fixar: !fixada, deMim: m.deMim, autorId: m.autorId ?? null } })) }
      : null,
    { rotulo: favorita ? "Desfavoritar" : "Favoritar", icone: favorita ? StarOff : Star, fazer: () => acao.mutate(() => favoritarMensagem({ data: { chatId: c.id, waId, favorita: !favorita, deMim: m.deMim } })) },
    { rotulo: "Selecionar", icone: CheckSquare, fazer: () => a.alternarSelecao(m) },
    c.grupo && !m.deMim && telefoneDoAutor && responde
      ? {
          rotulo: `Conversar com ${m.autor ?? "esta pessoa"}`,
          icone: MessageCircle,
          fazer: () =>
            acao.mutate(async () => {
              const r = await abrirConversaNova({ data: { numberId: c.numero.id, telefone: telefoneDoAutor, nome: m.autor ?? null } });
              window.dispatchEvent(new CustomEvent("omni:abrir-conversa", { detail: r.chatId }));
            }),
        }
      : null,
    // Grupo: quem escreveu e não está salvo na agenda (aparece pelo número e "~ Nome").
    c.grupo && !m.deMim && telefoneDoAutor && responde && m.autorPerfil !== undefined && m.autorPerfil !== null
      ? { rotulo: "Adicionar contato", icone: UserPlus, fazer: () => setContato(true) }
      : null,
    responde && m.deMim && m.tipo === "texto" && !m.apagada && recente < 15 * 60_000 ? { rotulo: "Editar", icone: Pencil, fazer: () => a.editar(m) } : null,
    { rotulo: "Apagar para mim", icone: Trash2, perigo: true, fazer: () => confirm("Apagar esta mensagem só para você?") && acao.mutate(() => apagarMensagem({ data: { chatId: c.id, waId, deMim: m.deMim, autorId: m.autorId ?? null, paraTodos: false } })) },
    responde && m.deMim && !m.apagada && recente < 2 * 24 * 3600_000
      ? {
          rotulo: "Apagar para todos",
          icone: Ban,
          perigo: true,
          fazer: () =>
            confirm("Apagar esta mensagem para todos na conversa?") &&
            acao.mutate(() => apagarMensagem({ data: { chatId: c.id, waId, deMim: true, autorId: null, paraTodos: true, em: m.em } })),
        }
      : null,
  ];
  return (
    <div
      className="group/msg relative"
      onContextMenu={(e) => {
        e.preventDefault();
        abrir(e.clientX, e.clientY);
      }}
    >
      {children}
      {contato && telefoneDoAutor && (
        <DialogoContato numberId={c.numero.id} telefone={telefoneDoAutor} sugestao={m.autorPerfil ?? ""} fechar={() => setContato(false)} aoSalvar={(texto) => (a.aviso(texto), invalidar())} />
      )}
      <button
        type="button"
        aria-label="Opções da mensagem"
        onClick={(e) => {
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          abrir(r.left - 200, r.bottom);
        }}
        className={`absolute right-1 top-1 hidden size-6 items-center justify-center rounded-full bg-black/20 text-white shadow-sm group-hover/msg:flex focus-visible:flex`}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {pos &&
        createPortal(
          <div role="menu" onClick={(e) => e.stopPropagation()} className="fixed z-50 w-60 rounded-md border border-linha bg-superficie py-1 text-sm shadow-xl" style={{ left: pos.x, top: pos.y }}>
            {emojis ? (
              <div className="flex justify-between px-2 py-1.5 text-xl">
                {REACOES.map((e) => (
                  <button
                    key={e}
                    type="button"
                    aria-label={`Reagir com ${e}`}
                    onClick={() => {
                      setPos(null);
                      setEmojis(false);
                      reagir.mutate({ m, emoji: e, conversa: c }, { onError: (err) => a.aviso(erroDe(err)) });
                    }}
                    className="rounded-md px-1 hover:bg-superficie-2"
                  >
                    {e}
                  </button>
                ))}
              </div>
            ) : (
              itens.filter((i): i is NonNullable<typeof i> => i !== null).map((i) => (
                <button
                  key={i.rotulo}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (i.rotulo !== "Reagir") setPos(null);
                    i.fazer();
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-superficie-2 ${i.perigo ? "text-vermelho" : ""}`}
                >
                  <i.icone size={16} aria-hidden className={i.perigo ? "" : "text-muted"} /> {i.rotulo}
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Barra das mensagens fixadas no topo da conversa (tocar leva até ela; a seta passa para a próxima). */
export function BarraDeFixadas() {
  const a = useAcoes();
  const [i, setI] = useState(0);
  const fixadas = (a?.detalhes?.fixadas ?? []).map((w) => a?.mensagens.find((m) => m.waId === w)).filter((m): m is MensagemWhatsApp => Boolean(m));
  if (!a || !fixadas.length) return null;
  const atual = fixadas[i % fixadas.length]!;
  return (
    <div className="flex items-center gap-2 border-b border-linha bg-superficie px-5 py-1.5 text-sm">
      <Pin size={15} aria-hidden className="shrink-0 text-muted" />
      <button type="button" onClick={() => a.irPara(atual.waId!)} className="min-w-0 flex-1 truncate text-left hover:underline">
        {atual.texto ?? (atual.arquivo ? `[${atual.arquivo}]` : "Mensagem fixada")}
      </button>
      {fixadas.length > 1 && (
        <button type="button" onClick={() => setI(i + 1)} className="shrink-0 text-xs text-muted hover:text-ink">
          {(i % fixadas.length) + 1}/{fixadas.length}
        </button>
      )}
    </div>
  );
}

/** Barra da resposta, acima da caixa de digitar. */
export function RespondendoA({ m, onFechar }: { m: MensagemWhatsApp; onFechar: () => void }) {
  const a = useAcoes();
  return (
    <div className="mb-2 flex items-start gap-2 rounded-md border-l-4 border-azul bg-superficie-2 px-3 py-1.5 text-sm">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-azul">{m.deMim ? "Você" : (m.autor ?? a?.conversa.nome ?? "Contato")}</p>
        <p className="line-clamp-2 text-muted">{m.texto ?? (m.arquivo ? `[${m.arquivo}]` : "Mensagem")}</p>
      </div>
      <button type="button" onClick={onFechar} aria-label="Cancelar a resposta" className="rounded p-0.5 text-muted hover:text-ink">
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

/** Barra da seleção (várias mensagens): encaminhar, copiar, favoritar e apagar para mim. */
export function BarraDeSelecao({ fechar }: { fechar: () => void }) {
  const a = useAcoes();
  const invalidar = useInvalidar(a?.conversa.id ?? "");
  const acao = useMutation({ mutationFn: async (f: () => Promise<unknown>) => f(), onSuccess: () => (invalidar(), fechar()), onError: (e) => a?.aviso(erroDe(e)) });
  if (!a?.selecionadas) return null;
  const ms = a.mensagens.filter((m) => m.waId && a.selecionadas!.has(m.waId));
  const c = a.conversa;
  const botao = "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium hover:bg-superficie-2 disabled:opacity-50";
  return (
    <div className="flex items-center gap-2 border-b border-linha bg-superficie px-4 py-2">
      <button type="button" onClick={fechar} aria-label="Cancelar a seleção" className="rounded p-1 hover:bg-superficie-2">
        <X size={18} aria-hidden />
      </button>
      <span className="flex-1 text-sm font-medium">
        {ms.length} {ms.length === 1 ? "selecionada" : "selecionadas"}
      </span>
      <button type="button" disabled={!ms.length || ms.length > 10} onClick={() => a.encaminhar(ms)} className={botao}>
        <Forward size={16} aria-hidden /> Encaminhar
      </button>
      <button
        type="button"
        disabled={!ms.some((m) => m.texto)}
        onClick={() => void navigator.clipboard.writeText(ms.filter((m) => m.texto).map((m) => m.texto).join("\n")).then(() => (a.aviso("Copiadas."), fechar()))}
        className={botao}
      >
        <Copy size={16} aria-hidden /> Copiar
      </button>
      <button type="button" disabled={!ms.length} onClick={() => acao.mutate(() => Promise.all(ms.map((m) => favoritarMensagem({ data: { chatId: c.id, waId: m.waId!, favorita: true, deMim: m.deMim } }))))} className={botao}>
        <Star size={16} aria-hidden /> Favoritar
      </button>
      <button
        type="button"
        disabled={!ms.length}
        onClick={() =>
          confirm(`Apagar ${ms.length} ${ms.length === 1 ? "mensagem" : "mensagens"} só para você?`) &&
          acao.mutate(() => Promise.all(ms.map((m) => apagarMensagem({ data: { chatId: c.id, waId: m.waId!, deMim: m.deMim, autorId: m.autorId ?? null, paraTodos: false } }))))
        }
        className={`${botao} text-vermelho`}
      >
        <Trash2 size={16} aria-hidden /> Apagar
      </button>
    </div>
  );
}

/** Encaminhar: escolher até 5 conversas. */
export function DialogoEncaminhar({ mensagens, conversas, deChatId, fechar }: { mensagens: MensagemWhatsApp[]; conversas: ConversaResumo[]; deChatId: string; fechar: () => void }) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [busca, setBusca] = useState("");
  const [escolhidas, setEscolhidas] = useState<string[]>([]);
  const qc = useQueryClient();
  const enviar = useMutation({
    mutationFn: () =>
      encaminharMensagens({
        data: { deChatId, mensagens: mensagens.map((m) => ({ waId: m.waId!, tipo: m.tipo, texto: m.texto, arquivo: m.arquivo })), paraChatIds: escolhidas },
      }),
    onSuccess: () => {
      for (const id of escolhidas) void qc.invalidateQueries({ queryKey: ["whatsapp", "mensagens", id] });
      fechar();
    },
  });
  useEffect(() => dialogo.current?.showModal(), []);
  const termo = busca.trim().toLowerCase();
  const lista = conversas.filter((c) => c.podeResponder && (!termo || c.nome.toLowerCase().includes(termo) || (c.telefone ?? "").includes(termo))).slice(0, 50);
  return (
    <dialog
      ref={dialogo}
      onCancel={(e) => (e.preventDefault(), fechar())}
      aria-label="Encaminhar"
      className="m-auto max-h-[85dvh] w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-linha bg-superficie p-0 text-ink backdrop:bg-black/50"
    >
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex items-center gap-2 border-b border-linha px-4 py-3">
          <h2 className="flex-1 font-semibold">
            Encaminhar {mensagens.length > 1 ? `${mensagens.length} mensagens` : "mensagem"}
          </h2>
          <button type="button" onClick={fechar} aria-label="Fechar" className="rounded p-1 hover:bg-superficie-2">
            <X size={18} aria-hidden />
          </button>
        </header>
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar conversa…"
          aria-label="Buscar conversa"
          className="mx-4 mt-3 rounded-md border border-linha bg-superficie-2 px-3 py-2"
        />
        <ul className="min-h-0 flex-1 overflow-y-auto py-2">
          {lista.map((c) => {
            const marcada = escolhidas.includes(c.id);
            return (
              <li key={c.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-superficie-2">
                  <input
                    type="checkbox"
                    checked={marcada}
                    disabled={!marcada && escolhidas.length >= 5}
                    onChange={() => setEscolhidas(marcada ? escolhidas.filter((x) => x !== c.id) : [...escolhidas, c.id])}
                  />
                  <span className="min-w-0 flex-1 truncate">{c.nome}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {enviar.isError && <p role="alert" className="px-4 text-sm text-vermelho">{erroDe(enviar.error)}</p>}
        <footer className="flex items-center justify-between gap-2 border-t border-linha px-4 py-3">
          <span className="text-xs text-muted">Até 5 conversas.</span>
          <button
            type="button"
            disabled={!escolhidas.length || enviar.isPending}
            onClick={() => enviar.mutate()}
            className="flex items-center gap-1.5 rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white hover:bg-floresta-escura disabled:opacity-60"
          >
            <Forward size={16} aria-hidden /> {enviar.isPending ? "Enviando…" : "Encaminhar"}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

/** Editar uma mensagem minha (até 15 minutos, como no WhatsApp). */
export function DialogoEditar({ m, chatId, fechar }: { m: MensagemWhatsApp; chatId: string; fechar: () => void }) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [texto, setTexto] = useState(m.texto ?? "");
  const qc = useQueryClient();
  const salvar = useMutation({
    mutationFn: () => editarMensagem({ data: { chatId, waId: m.waId!, deMim: true, autorId: null, texto, em: m.em } }),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ["whatsapp", "mensagens", chatId] }), fechar()),
  });
  useEffect(() => dialogo.current?.showModal(), []);
  return (
    <dialog
      ref={dialogo}
      onCancel={(e) => (e.preventDefault(), fechar())}
      aria-label="Editar mensagem"
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-linha bg-superficie p-0 text-ink backdrop:bg-black/50"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          salvar.mutate();
        }}
        className="space-y-3 p-4"
      >
        <h2 className="font-semibold">Editar mensagem</h2>
        <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={4} autoFocus className="w-full rounded-md border border-linha bg-superficie-2 px-3 py-2" />
        {salvar.isError && <p role="alert" className="text-sm text-vermelho">{erroDe(salvar.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={fechar} className="rounded-md px-3 py-1.5 text-sm hover:bg-superficie-2">
            Cancelar
          </button>
          <button type="submit" disabled={!texto.trim() || texto === m.texto || salvar.isPending} className="rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
            Salvar
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Adicionar contato (pessoa de um grupo): salva na agenda do celular do número, como no WhatsApp Web. */
function DialogoContato({ numberId, telefone, sugestao, fechar, aoSalvar }: { numberId: string; telefone: string; sugestao: string; fechar: () => void; aoSalvar: (aviso: string) => void }) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [nome, setNome] = useState(sugestao);
  const qc = useQueryClient();
  const salvar = useMutation({
    mutationFn: () => salvarContatoWhatsApp({ data: { numberId, telefone, nome } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["whatsapp"] });
      aoSalvar(r.noCelular ? "Contato salvo na agenda do celular." : (r.aviso ?? "Contato salvo no Omni (não foi para a agenda do celular neste ambiente)."));
      fechar();
    },
  });
  useEffect(() => dialogo.current?.showModal(), []);
  return createPortal(
    <dialog
      ref={dialogo}
      onCancel={(e) => (e.preventDefault(), fechar())}
      onClick={(e) => e.stopPropagation()}
      aria-label="Adicionar contato"
      className="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-linha bg-superficie p-0 text-ink backdrop:bg-black/50"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          salvar.mutate();
        }}
        className="space-y-3 p-4"
      >
        <h2 className="font-semibold">Adicionar contato</h2>
        <p className="text-sm text-muted">{formatarTelefone(telefone) ?? telefone}</p>
        <label className="block">
          <span className="text-sm font-medium">Nome</span>
          <input value={nome} onChange={(e) => setNome(e.target.value)} autoFocus maxLength={120} className="mt-1 w-full rounded-md border border-linha bg-superficie-2 px-3 py-2" />
        </label>
        {salvar.isError && <p role="alert" className="text-sm text-vermelho">{erroDe(salvar.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={fechar} className="rounded-md px-3 py-1.5 text-sm hover:bg-superficie-2">
            Cancelar
          </button>
          <button type="submit" disabled={!nome.trim() || salvar.isPending} className="rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white hover:bg-floresta-escura disabled:opacity-60">
            Salvar
          </button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

