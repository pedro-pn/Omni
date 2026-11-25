import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Inbox, Mail, MailOpen, Paperclip, PenSquare, Reply, ReplyAll, Target, TriangleAlert, X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { abrirDaMinhaCaixa, enviarDaMinhaCaixa, listarMinhaCaixa, marcarLidoNaMinhaCaixa, minhaCaixa } from "../../lib/caixa-fns.ts";
import type { ResumoDeEmail } from "@omni/integrations/graph";
import { TentarDeNovo } from "../comum/TentarDeNovo.tsx";
import { acaoLida, BotaoLida, useDeslizarLados, useMenuDeContexto } from "../comum/MarcarLida.tsx";
import { CorpoEmail, Escrever, type Rascunho } from "../missions/EmailsMissao.tsx";

/**
 * Aba E-mails: a caixa da própria pessoa, lida na hora no Microsoft 365 (pastas,
 * mensagens, leitura, anexos, responder e escrever). Os e-mails das missões
 * continuam também em cada missão.
 */

export type CentroEmail = { tipo: "ler"; id: string } | { tipo: "escrever"; rascunho: Rascunho };

const quando = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const hoje = new Date();
  return d.toDateString() === hoje.toDateString()
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", ...(d.getFullYear() !== hoje.getFullYear() ? { year: "2-digit" } : {}), timeZone: "America/Sao_Paulo" });
};
const dataHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "";
const tamanho = (b: number | null) => (b === null ? "" : b < 1024 ** 2 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`);
const erroDe = (e: unknown) => (e instanceof Error && e.message ? e.message : "Não foi possível falar com o Microsoft 365 agora.");

/**
 * Abre o e-mail numa janela pequena e separada, como o duplo clique do Outlook.
 * Cada e-mail na sua janela (abrir de novo traz a mesma para a frente). Bloqueada
 * pelo navegador, abre numa aba.
 */
export function abrirEmailEmJanela(id: string) {
  let h = 0;
  for (const c of id) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  const largura = Math.min(860, screen.availWidth - 40);
  const altura = Math.min(760, screen.availHeight - 40);
  const esquerda = Math.round((window.screenX ?? 0) + Math.max(0, (window.outerWidth - largura) / 2) + 40);
  const topo = Math.round((window.screenY ?? 0) + Math.max(0, (window.outerHeight - altura) / 2));
  const janela = window.open(
    `/emails/janela?id=${encodeURIComponent(id)}`,
    `omni-email-${(h >>> 0).toString(36)}`,
    `popup,width=${largura},height=${altura},left=${esquerda},top=${topo}`,
  );
  janela?.focus();
}

/** Aviso entre as janelas do Omni: um envio pela janela avulsa atualiza a caixa da principal. */
const CANAL_CAIXA = "omni-caixa";
function avisarCaixaMudou() {
  try {
    const c = new BroadcastChannel(CANAL_CAIXA);
    c.postMessage("mudou");
    c.close();
  } catch {
    // Sem BroadcastChannel: a caixa se atualiza sozinha em alguns minutos.
  }
}
export function useAvisosDaCaixa() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const c = new BroadcastChannel(CANAL_CAIXA);
    c.onmessage = () => void qc.invalidateQueries({ queryKey: ["caixa"] });
    return () => c.close();
  }, [qc]);
}

/** Leva a janela principal do Omni para a missão (da janela avulsa); sem ela, abre numa aba. */
function abrirMissaoNaPrincipal(missionId: string) {
  const url = `/?missao=${encodeURIComponent(missionId)}`;
  const principal = window.opener as Window | null;
  try {
    if (principal && !principal.closed) {
      principal.location.href = url;
      principal.focus();
      return;
    }
  } catch {
    // Outra origem: abre numa aba.
  }
  window.open(url, "_blank");
}

/** Janela avulsa de um e-mail (/emails/janela): ler, responder e escrever sem a casca do Omni. */
export function JanelaDeEmail({ id }: { id: string }) {
  const qc = useQueryClient();
  const [estado, setEstado] = useState<CentroEmail>({ tipo: "ler", id });
  if (estado.tipo === "escrever") {
    return (
      <div className="flex h-dvh flex-col bg-fundo">
        <Cabecalho titulo={estado.rascunho.responderA ? "Responder" : "Novo e-mail"} onFechar={() => setEstado({ tipo: "ler", id })} avulsa />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Escrever
            key={JSON.stringify(estado.rascunho)}
            inicial={estado.rascunho}
            sugestoes={[]}
            onFechar={() => {
              void qc.invalidateQueries({ queryKey: ["caixa"] });
              avisarCaixaMudou();
              setEstado({ tipo: "ler", id });
            }}
            enviar={(d) => enviarDaMinhaCaixa({ data: d })}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-dvh flex-col bg-fundo">
      <Leitura id={id} onFechar={() => window.close()} onEscrever={(r) => setEstado({ tipo: "escrever", rascunho: r })} onAbrirMissao={abrirMissaoNaPrincipal} avulsa />
    </div>
  );
}

export function useMinhaCaixa(ativo: boolean) {
  return useQuery({ queryKey: ["caixa", "pastas"], queryFn: () => minhaCaixa(), enabled: ativo, staleTime: 60_000, refetchInterval: 2 * 60_000 });
}

/** Lista da caixa (coluna da esquerda): pasta, "Novo e-mail" e as mensagens de 50 em 50. */
/**
 * Um e-mail da lista: clique abre, duplo clique abre numa janela à parte; lida/não lida pelo
 * botão que aparece ao passar o mouse, pelo botão direito ou deslizando para a direita.
 */
function ItemDaLista({
  m,
  selecionado,
  onSelecionar,
  children,
}: {
  m: ResumoDeEmail;
  selecionado: boolean;
  onSelecionar: (id: string) => void;
  children: (lida: boolean) => ReactNode;
}) {
  const qc = useQueryClient();
  const [lida, setLida] = useState(m.lida);
  useEffect(() => setLida(m.lida), [m.lida]);
  const marcar = useMutation({
    mutationFn: (v: boolean) => marcarLidoNaMinhaCaixa({ data: { id: m.id, lido: v } }),
    onMutate: (v) => setLida(v),
    onError: () => setLida(m.lida),
    onSuccess: () => {
      void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === "caixa" && x.queryKey[1] !== "email" });
      void qc.invalidateQueries({ queryKey: ["unica"] });
    },
  });
  const alternar = () => marcar.mutate(!lida);
  const { dx, moveu, fundo, handlers } = useDeslizarLados({ direita: acaoLida(lida, alternar) });
  const menu = useMenuDeContexto([acaoLida(lida, alternar), { rotulo: "Abrir numa janela à parte", icone: ExternalLink, acao: () => abrirEmailEmJanela(m.id) }]);
  return (
    <li className="group relative" onContextMenu={menu.abrir}>
      {fundo}
      <button
        type="button"
        {...handlers}
        onClick={() => {
          if (moveu.current) return;
          onSelecionar(m.id);
        }}
        // Duplo clique: o e-mail numa janela à parte, como no Outlook.
        onDoubleClick={() => abrirEmailEmJanela(m.id)}
        title="Duplo clique abre numa janela à parte"
        aria-current={selecionado ? "true" : undefined}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={`relative block w-full touch-pan-y border-b border-linha bg-superficie px-4 py-2.5 pr-10 text-left hover:bg-superficie-2 ${selecionado ? "bg-floresta-clara" : ""}`}
      >
        {children(lida)}
      </button>
      {dx === 0 && (
        <div className="absolute right-2 top-2.5">
          <BotaoLida lida={lida} alternar={alternar} />
        </div>
      )}
      {marcar.isError && (
        <p role="alert" className="px-4 pb-1 text-xs text-vermelho">
          {erroDe(marcar.error)}
        </p>
      )}
      {menu.menu}
    </li>
  );
}

export function EmailsLista({
  busca,
  selecionado,
  onSelecionar,
  onEscrever,
}: {
  busca: string;
  selecionado: string | null;
  onSelecionar: (id: string) => void;
  onEscrever: () => void;
}) {
  const caixa = useMinhaCaixa(true);
  const [pastaId, setPastaId] = useState<string | null>(null);
  const [termo, setTermo] = useState("");
  // Pesquisa no Exchange só depois de uma pausa na digitação.
  useEffect(() => {
    const t = setTimeout(() => setTermo(busca.trim()), 450);
    return () => clearTimeout(t);
  }, [busca]);
  const pastas = caixa.data?.pastas ?? [];
  const pasta = pastas.find((p) => p.id === pastaId) ?? pastas.find((p) => p.sistema === "inbox") ?? pastas[0];
  const lista = useInfiniteQuery({
    queryKey: ["caixa", "mensagens", pasta?.id ?? null, termo],
    queryFn: ({ pageParam }) => listarMinhaCaixa({ data: { pastaId: pasta!.id, inicio: pageParam, ...(termo ? { busca: termo } : {}) } }),
    initialPageParam: 0,
    getNextPageParam: (ultima, todas) => (ultima.haMais ? todas.length * 50 : undefined),
    enabled: Boolean(pasta),
    refetchInterval: termo ? false : 60_000,
    staleTime: 30_000,
  });

  if (caixa.isPending) return <p className="px-6 py-10 text-center text-muted">Abrindo a sua caixa…</p>;
  if (caixa.isError) return <p className="px-6 py-10 text-center text-vermelho">{erroDe(caixa.error)}</p>;
  if (!caixa.data.disponivel) return <p className="px-6 py-10 text-center text-muted">A conexão com o Microsoft 365 ainda não foi configurada no Omni.</p>;
  if (!caixa.data.caixa)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-muted">
        <Mail size={32} strokeWidth={1.6} aria-hidden />
        <p>Sua caixa de e-mail ainda não está conectada ao Omni. Ela entra sozinha no seu primeiro acesso; se não entrou, avise a administração.</p>
      </div>
    );
  if (caixa.data.erro)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <TriangleAlert size={28} aria-hidden className="text-vermelho" />
        <p className="text-muted">{caixa.data.erro}</p>
        <TentarDeNovo tentar={() => caixa.refetch()} tentando={caixa.isFetching} falhou={Boolean(caixa.data.erro)} />
      </div>
    );
  const mensagens = lista.data?.pages.flatMap((p) => p.mensagens) ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-linha px-4 pb-2">
        <select
          value={pasta?.id ?? ""}
          onChange={(e) => {
            setPastaId(e.target.value);
          }}
          aria-label="Pasta"
          className="min-w-0 flex-1 rounded-md border border-linha bg-superficie px-2 py-1.5 text-sm"
        >
          {pastas.map((p) => (
            <option key={p.id} value={p.id}>
              {p.nome}
              {p.naoLidas ? ` (${p.naoLidas})` : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={onEscrever} className="flex shrink-0 items-center gap-1.5 rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white">
          <PenSquare size={15} aria-hidden /> Novo
        </button>
      </div>
      {termo && <p className="px-4 pt-2 text-xs text-muted">Resultados em "{pasta?.nome}" para "{termo}".</p>}
      {lista.isPending && <p className="px-6 py-10 text-center text-muted">Carregando…</p>}
      {lista.isError && (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-vermelho">{erroDe(lista.error)}</p>
          <TentarDeNovo tentar={() => lista.refetch()} tentando={lista.isFetching} falhou={lista.isError} />
        </div>
      )}
      {lista.isSuccess && !mensagens.length && (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-muted">
          <Inbox size={28} strokeWidth={1.6} aria-hidden />
          <p>{termo ? "Nada encontrado nesta pasta." : "Nenhum e-mail nesta pasta."}</p>
        </div>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {mensagens.map((m) => {
          const quem = pasta?.sistema === "sentitems" || pasta?.sistema === "drafts" ? m.para.map((p) => p.nome || p.endereco).join(", ") || "(sem destinatário)" : (m.de?.nome || m.de?.endereco || "(sem remetente)");
          return (
            <ItemDaLista key={m.id} m={m} selecionado={m.id === selecionado} onSelecionar={onSelecionar}>
              {(lida) => (
                <>
                <span className="flex items-baseline justify-between gap-2">
                  <span className={`truncate ${lida ? "" : "font-semibold"}`}>
                    {!lida && <span className="mr-1.5 inline-block size-2 rounded-full bg-azul align-middle" aria-label="Não lido" />}
                    {quem}
                  </span>
                  <span className="shrink-0 text-xs text-muted">{quando(m.em)}</span>
                </span>
                <span className={`flex items-center gap-1 truncate text-sm ${lida ? "" : "font-medium"}`}>
                  {m.importante && <span className="text-vermelho" title="Importante">!</span>}
                  {m.anexos && <Paperclip size={12} aria-label="Com anexo" className="shrink-0 text-muted" />}
                  <span className="truncate">{m.rascunho ? `[Rascunho] ${m.assunto}` : m.assunto}</span>
                </span>
                <span className="block truncate text-xs text-muted">{m.previa}</span>
                </>
              )}
            </ItemDaLista>
          );
        })}
        {lista.hasNextPage && (
          <li className="px-4 py-3 text-center">
            <button type="button" disabled={lista.isFetchingNextPage} onClick={() => void lista.fetchNextPage()} className="text-sm text-floresta-texto hover:underline">
              {lista.isFetchingNextPage ? "Carregando…" : "Carregar mais"}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Centro: ler um e-mail ou escrever. */
export function EmailsCentro({
  estado,
  onFechar,
  onEscrever,
  onAbrirMissao,
  sugestoes,
  voltarSempre = false,
}: {
  estado: CentroEmail;
  onFechar: () => void;
  onEscrever: (r: Rascunho) => void;
  onAbrirMissao: (id: string) => void;
  sugestoes: string[];
  /** Caixa única: aberto a partir de uma conversa, o "voltar" aparece também na tela larga. */
  voltarSempre?: boolean;
}) {
  return (
    <VoltarSempre.Provider value={voltarSempre}>
      <CentroDeEmail estado={estado} onFechar={onFechar} onEscrever={onEscrever} onAbrirMissao={onAbrirMissao} sugestoes={sugestoes} />
    </VoltarSempre.Provider>
  );
}

const VoltarSempre = createContext(false);

function CentroDeEmail({
  estado,
  onFechar,
  onEscrever,
  onAbrirMissao,
  sugestoes,
}: {
  estado: CentroEmail;
  onFechar: () => void;
  onEscrever: (r: Rascunho) => void;
  onAbrirMissao: (id: string) => void;
  sugestoes: string[];
}) {
  const qc = useQueryClient();
  if (estado.tipo === "escrever") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Cabecalho titulo={estado.rascunho.responderA ? "Responder" : "Novo e-mail"} onFechar={onFechar} />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Escrever
            key={JSON.stringify(estado.rascunho)}
            inicial={estado.rascunho}
            sugestoes={sugestoes}
            onFechar={() => {
              void qc.invalidateQueries({ queryKey: ["caixa"] });
              onFechar();
            }}
            enviar={(d) => enviarDaMinhaCaixa({ data: d })}
          />
        </div>
      </div>
    );
  }
  return <Leitura id={estado.id} onFechar={onFechar} onEscrever={onEscrever} onAbrirMissao={onAbrirMissao} />;
}

function Cabecalho({ titulo, onFechar, emJanela, avulsa = false }: { titulo: string; onFechar: () => void; emJanela?: () => void; avulsa?: boolean }) {
  const sempre = useContext(VoltarSempre);
  return (
    <header className="flex items-center gap-2 border-b border-linha bg-superficie px-4 py-3">
      {!avulsa && (
        <button
          type="button"
          onClick={onFechar}
          aria-label={sempre ? "Voltar à conversa" : "Voltar para a lista"}
          title={sempre ? "Voltar à conversa" : undefined}
          className={`-ml-1 flex size-9 items-center justify-center rounded-md hover:bg-superficie-2 ${sempre ? "" : "md:hidden"}`}
        >
          <ArrowLeft size={20} />
        </button>
      )}
      <h2 className="min-w-0 flex-1 truncate font-semibold">{titulo}</h2>
      {emJanela && (
        <button
          type="button"
          onClick={emJanela}
          aria-label="Abrir numa janela à parte"
          title="Abrir numa janela à parte"
          className="hidden size-9 shrink-0 items-center justify-center rounded-md hover:bg-superficie-2 md:flex"
        >
          <ExternalLink size={18} />
        </button>
      )}
      {avulsa && (
        <button type="button" onClick={onFechar} aria-label="Fechar" title="Fechar" className="flex size-9 shrink-0 items-center justify-center rounded-md hover:bg-superficie-2">
          <X size={18} />
        </button>
      )}
    </header>
  );
}

function Leitura({
  id,
  onFechar,
  onEscrever,
  onAbrirMissao,
  avulsa = false,
}: {
  id: string;
  onFechar: () => void;
  onEscrever: (r: Rascunho) => void;
  onAbrirMissao: (id: string) => void;
  /** Na janela à parte: botão de fechar, título da janela com o assunto. */
  avulsa?: boolean;
}) {
  const [externas, setExternas] = useState(false);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["caixa", "email", id, externas], queryFn: () => abrirDaMinhaCaixa({ data: { id, permitirExternas: externas } }), staleTime: 5 * 60_000, retry: false });
  const e = q.data;
  // Lido/não lido como no Outlook: abrir já marca como lido; o botão inverte.
  const [lido, setLido] = useState<boolean | null>(null);
  useEffect(() => setLido(null), [id]);
  const atualizarListas = () => {
    void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] === "caixa" && x.queryKey[1] !== "email" });
    void qc.invalidateQueries({ queryKey: ["unica"] });
    avisarCaixaMudou();
  };
  useEffect(() => {
    if (e?.marcadoAgora) atualizarListas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e?.id, e?.marcadoAgora]);
  const marcar = useMutation({
    mutationFn: (v: boolean) => marcarLidoNaMinhaCaixa({ data: { id, lido: v } }),
    onSuccess: (_, v) => {
      setLido(v);
      atualizarListas();
    },
  });
  const estaLido = lido ?? e?.lido ?? true;
  // A resposta pelo Microsoft 365 já leva a mensagem original no fim (como no Outlook).
  const re = (assunto: string) => (/^re:/i.test(assunto) ? assunto : `RE: ${assunto}`);
  useEffect(() => {
    if (avulsa && e) document.title = `${e.assunto} · Omni`;
  }, [avulsa, e]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Cabecalho titulo={e?.assunto ?? "E-mail"} onFechar={onFechar} avulsa={avulsa} emJanela={avulsa ? undefined : () => abrirEmailEmJanela(id)} />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {q.isPending && <p className="text-muted">Abrindo o e-mail…</p>}
        {q.isError && (
          <div className="space-y-3">
            <p className="text-vermelho">{erroDe(q.error)}</p>
            <TentarDeNovo tentar={() => q.refetch()} tentando={q.isFetching} falhou={q.isError} />
          </div>
        )}
        {e && (
          <>
            <div className="space-y-0.5 text-sm">
              <p className="text-lg font-semibold leading-snug">{e.assunto}</p>
              <p>
                <span className="text-muted">De:</span> {e.de}
              </p>
              {e.para.length > 0 && (
                <p className="break-words">
                  <span className="text-muted">Para:</span> {e.para.join(", ")}
                </p>
              )}
              {e.cc.length > 0 && (
                <p className="break-words">
                  <span className="text-muted">Cc:</span> {e.cc.join(", ")}
                </p>
              )}
              <p className="text-xs text-muted">{dataHora(e.em)}</p>
            </div>
            {e.missoes.length > 0 && (
              <p className="flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted">Ligado a:</span>
                {e.missoes.map((m) => (
                  <button key={m.id} type="button" onClick={() => onAbrirMissao(m.id)} className="flex items-center gap-1 rounded-full bg-floresta-clara px-2 py-0.5 font-medium text-floresta-texto hover:underline">
                    <Target size={12} aria-hidden /> {m.titulo}
                  </button>
                ))}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onEscrever({ para: e.todos.para[0] ?? "", cc: "", cco: "", assunto: re(e.assunto), texto: "", responderA: e.id })}
                className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2"
              >
                <Reply size={15} aria-hidden /> Responder
              </button>
              {e.todos.para.length + e.todos.cc.length > 1 && (
                <button
                  type="button"
                  onClick={() => onEscrever({ para: e.todos.para.join(", "), cc: e.todos.cc.join(", "), cco: "", assunto: re(e.assunto), texto: "", responderA: e.id })}
                  className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2"
                >
                  <ReplyAll size={15} aria-hidden /> Responder a todos
                </button>
              )}
              <button
                type="button"
                disabled={marcar.isPending}
                onClick={() => marcar.mutate(!estaLido)}
                className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2 disabled:opacity-60"
              >
                {estaLido ? <Mail size={15} aria-hidden /> : <MailOpen size={15} aria-hidden />} {estaLido ? "Marcar como não lido" : "Marcar como lido"}
              </button>
            </div>
            {marcar.isError && (
              <p role="alert" className="text-sm text-vermelho">
                {erroDe(marcar.error)}
              </p>
            )}
            {e.anexos.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {e.anexos.map((a) => (
                  <li key={a.id}>
                    {a.arquivo ? (
                      <a
                        href={`/api/caixa/anexo?m=${encodeURIComponent(e.id)}&a=${encodeURIComponent(a.id)}`}
                        className="flex items-center gap-1.5 rounded-md border border-linha bg-superficie px-2.5 py-1 text-sm hover:bg-superficie-2"
                      >
                        <Paperclip size={14} aria-hidden /> {a.nome} <span className="text-xs text-muted">{tamanho(a.tamanho)}</span>
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 rounded-md border border-linha px-2.5 py-1 text-sm text-muted" title="Abra no Outlook">
                        <Paperclip size={14} aria-hidden /> {a.nome}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <CorpoEmail email={e} carregando={q.isFetching} mostrarExternas={() => setExternas(true)} />
          </>
        )}
      </div>
    </div>
  );
}
