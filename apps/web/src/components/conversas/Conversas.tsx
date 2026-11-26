import { formatarTelefone } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Ban,
  CheckCheck,
  Clock,
  Forward,
  Pin,
  PinOff,
  Star,
  UserPlus,
  Download,
  FileText,
  Image,
  Lightbulb,
  Link2,
  Mail,
  MessageSquarePlus,
  Mic,
  Paperclip,
  Trash2,
  Pencil,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  QrCode,
  Send,
  Smartphone,
  Users,
  Video,
  X, User } from "lucide-react";
import { memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import {
  concluirConversa,
  renomearContato,
  marcarConversaLida,
  conversasDaMissao,
  enviarMensagemWhatsApp,
  ligarConversaMissao,
  listarConversas,
  mensagensDaConversa,
  modoEnvioWhatsApp,
  recusarSugestaoMissao,
  type ConversaResumo,
  type MensagemWhatsApp,
} from "../../lib/conversas-fns.ts";
import { listMissoes } from "../../lib/missions-fns.ts";
import { abrirConversaNova, contatosDoWhatsApp, telefoneComDdi } from "../../lib/whatsapp-aparelho-fns.ts";
import { BotaoEmojis } from "./Emojis.tsx";
import { EscolherFundo, estiloDoFundo, useFundoDaConversa } from "./FundoConversa.tsx";
import { MAX_SEGUNDOS_VOZ, relogio, useGravador } from "./gravador.ts";
import {
  mensagensDoAparelho,
  pessoaDoAparelho,
  sincronizarHistorico,
  useProgressoDoHistorico,
} from "../../lib/whatsapp-aparelho.ts";
import {
  conectarMeuWhatsApp,
  meuWhatsApp,
  type MeuWhatsApp,
} from "../../lib/meu-whatsapp-fns.ts";
import {
  AbasOrganizacao,
  filtrarPorAba,
  MenuOrganizar,
  useAbaOrganizacao,
  useOrganizacao,
} from "../organizacao/Organizacao.tsx";
import { abrirChamada } from "../chamadas/Chamadas.tsx";
import { ItemDeLigacao } from "../chamadas/ItemDeLigacao.tsx";
import { ligacoesDaConversa } from "../../lib/chamadas-fns.ts";
import { ResumoChamada } from "../chamadas/ResumoChamada.tsx";
import { FalhaAoCarregar, TentarDeNovo } from "../comum/TentarDeNovo.tsx";
import { emailsDoContato, type EmailDoContato } from "../../lib/unica-fns.ts";
import { CartaoEmail } from "../unica/CartaoEmail.tsx";
import { acaoLida, BotaoLida, useDeslizarLados, useMenuDeContexto } from "../comum/MarcarLida.tsx";
import { AvisoNaoLidas, SetaParaBaixo, useRolagemDoChat } from "../comum/RolagemDoChat.tsx";
import { VincularContato } from "../unica/Vincular.tsx";
import { ImagemComPrevia } from "../comum/ImagemComPrevia.tsx";
import { PreviaDoLink, primeiroLink, TextoComLinks } from "./Links.tsx";
import { horaSP, quandoCurto, separadorDoDia } from "../../lib/datas-sp.ts";
import { fixarConversa, salvarContatoWhatsApp } from "../../lib/whatsapp-acoes-fns.ts";
import { corDoAutor, FotoDoAutor } from "./AutorDoGrupo.tsx";
import {
  BarraDeFixadas,
  BarraDeSelecao,
  CitacaoNoBalao,
  DialogoEditar,
  DialogoEncaminhar,
  MenuDaMensagem,
  ProvedorDeAcoes,
  ReacoesDoBalao,
  RespondendoA,
  useAcoes,
  useDetalhesDaConversa,
} from "./AcoesDaMensagem.tsx";
import { useListaProgressiva } from "../comum/ListaProgressiva.tsx";

/**
 * Conversas do WhatsApp (Fase 7). As conversas e as mensagens vêm do webhook da
 * Evolution do Omni (e do histórico dos grupos escolhidos), só do que a pessoa vê.
 * Responde quem acompanha o número; o envio segue WHATSAPP_ENVIO (ensaio fora da produção).
 */

const TZ = { timeZone: "America/Sao_Paulo" } as const;

// Datas com formatadores criados uma vez (lib/datas-sp.ts): formatar em cada item travava a troca de conversa.
export { quandoCurto };

/** Com o Omni aberto, baixa para este aparelho o histórico do WhatsApp da pessoa (continua de onde parou). */
export function useSincronizarHistoricoDoWhatsApp(personId: string) {
  const qc = useQueryClient();
  const meu = useQuery({ queryKey: ["whatsapp", "meu"], queryFn: () => meuWhatsApp(), staleTime: 30_000 });
  const n = meu.data?.disponivel ? meu.data.numero : null;
  const numberId = n && n.status !== "removido" && n.status !== "criado" ? n.id : null;
  useEffect(() => {
    if (numberId) sincronizarHistorico(personId, numberId, () => void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] }));
  }, [personId, numberId, qc]);
}

/** Mensagens desta conversa guardadas no aparelho (histórico), relidas quando a cópia grava algo dela. */
function useMensagensDoAparelho(chatId: string, numberId: string, ativo: boolean) {
  const [limite, setLimite] = useState(500);
  const [dados, setDados] = useState<{ chatId: string; mensagens: MensagemWhatsApp[]; haMais: boolean } | null>(null);
  const progresso = useProgressoDoHistorico();
  const tocou = progresso.tocadas.has(chatId) ? progresso.versao : 0;
  useEffect(() => setLimite(500), [chatId]);
  useEffect(() => {
    const personId = pessoaDoAparelho();
    if (!ativo || !personId) return;
    let vivo = true;
    mensagensDoAparelho(personId, chatId, limite)
      .then((r) => {
        if (!vivo) return;
        setDados({
          chatId,
          haMais: r.haMais,
          mensagens: r.mensagens.map(({ chatId: _c, ...m }) => ({
            ...m,
            status: m.status ?? null,
            midia: `/api/whatsapp/historico/${numberId}/${m.waId}${m.arquivo ? `?nome=${encodeURIComponent(m.arquivo)}` : ""}`,
          })),
        });
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [chatId, numberId, limite, ativo, tocou]);
  const atual = dados?.chatId === chatId ? dados : null;
  return { mensagens: atual?.mensagens ?? [], haMais: atual?.haMais ?? false, mais: () => setLimite((l) => l + 500) };
}

/** Marca a conversa como lida ou não lida (0075) e atualiza a lista. */
export function useMarcarConversaLida() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { chatId: string; lida: boolean }) => marcarConversaLida({ data: v }),
    onMutate: (v) => {
      // Na hora, na lista (sem esperar o servidor).
      qc.setQueryData<ConversaResumo[]>(["whatsapp", "conversas"], (l) =>
        l?.map((c) => (c.id === v.chatId ? { ...c, naoLidas: v.lida ? 0 : c.naoLidas, marcadaNaoLida: !v.lida, lidaAte: v.lida ? new Date().toISOString() : c.lidaAte } : c)),
      );
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] }),
  });
}

export function useConversas(ativo: boolean) {
  return useQuery({
    queryKey: ["whatsapp", "conversas"],
    queryFn: () => listarConversas(),
    enabled: ativo,
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------- inbox zero (concluir)

type AvisoConclusao = { chatId: string; nome: string } | null;
let avisoAtual: AvisoConclusao = null;
const ouvintesAviso = new Set<() => void>();
function mostrarAviso(a: AvisoConclusao) {
  avisoAtual = a;
  for (const f of ouvintesAviso) f();
}

/** Arquivar ou desarquivar uma conversa (só para esta pessoa; volta sozinha com mensagem nova). Some da lista na hora; o servidor confirma. */
export function useConcluirConversa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { conversa: ConversaResumo; concluir: boolean }) =>
      concluirConversa({
        data: { chatId: v.conversa.id, concluir: v.concluir },
      }),
    onMutate: ({ conversa, concluir }) => {
      qc.setQueryData<ConversaResumo[]>(["whatsapp", "conversas"], (lista) =>
        lista?.map((c) =>
          c.id === conversa.id ? { ...c, concluida: concluir } : c,
        ),
      );
      mostrarAviso(
        concluir ? { chatId: conversa.id, nome: conversa.nome } : null,
      );
    },
    onError: () => mostrarAviso(null),
    onSettled: () =>
      void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] }),
  });
}

/** Aviso "Conversa concluída" com Desfazer (montado uma vez pela tela principal). */
export function AvisoConversas() {
  const aviso = useSyncExternalStore(
    (f) => {
      ouvintesAviso.add(f);
      return () => ouvintesAviso.delete(f);
    },
    () => avisoAtual,
    () => null,
  );
  const qc = useQueryClient();
  const reabrir = useConcluirConversa();
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => mostrarAviso(null), 6000);
    return () => clearTimeout(t);
  }, [aviso]);
  if (!aviso) return null;
  const conversa = qc
    .getQueryData<ConversaResumo[]>(["whatsapp", "conversas"])
    ?.find((c) => c.id === aviso.chatId);
  return (
    <div
      role="status"
      className="fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-md items-center gap-3 rounded-lg bg-ink px-4 py-3 text-sm text-fundo shadow-lg md:bottom-6"
    >
      <Archive size={18} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">
        <b className="block truncate">{aviso.nome}</b>
        Conversa arquivada. Volta sozinha quando chegar mensagem nova.
      </span>
      {conversa && (
        <button
          type="button"
          onClick={() => reabrir.mutate({ conversa, concluir: false })}
          className="shrink-0 rounded-md px-2 py-1 font-semibold underline-offset-2 hover:underline"
        >
          Desfazer
        </button>
      )}
    </div>
  );
}

/** Topo da lista: andamento da cópia do histórico para este aparelho e "Nova conversa". */
function BarraDoWhatsApp({ numero, onSelecionar }: { numero: MeuWhatsApp["numero"]; onSelecionar: (id: string) => void }) {
  const [nova, setNova] = useState(false);
  const p = useProgressoDoHistorico();
  if (!numero || numero.status === "removido" || numero.status === "criado") return null;
  const deste = p.numberId === numero.id;
  const pct = deste && p.paginas ? Math.min(100, Math.round((p.pagina / p.paginas) * 100)) : null;
  const andamento = !deste
    ? null
    : p.fase === "baixando"
      ? `Baixando o histórico para este aparelho… ${pct ?? 0}%`
      : p.fase === "erro"
        ? "Histórico: sem resposta, tentando de novo…"
        : p.fase === "outraAba"
          ? "Histórico: baixando em outra aba"
          : null;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-linha px-4 py-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted" aria-live="polite" title={p.erro ?? undefined}>
          {andamento}
        </span>
        <button
          type="button"
          onClick={() => setNova(true)}
          disabled={numero.status !== "conectado"}
          title={numero.status === "conectado" ? "Conversar com um contato ou um número" : "Conecte o seu WhatsApp primeiro"}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-linha px-2.5 py-1 text-sm font-medium hover:bg-superficie-2 disabled:opacity-50"
        >
          <MessageSquarePlus size={16} aria-hidden /> Nova conversa
        </button>
      </div>
      {pct !== null && p.fase === "baixando" && (
        <div className="h-0.5 bg-superficie-2" aria-hidden>
          <div className="h-full bg-floresta transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
      {nova && (
        <NovaConversa
          numberId={numero.id}
          fechar={() => setNova(false)}
          onAberta={(id) => {
            setNova(false);
            onSelecionar(id);
          }}
        />
      )}
    </>
  );
}

const LETRAS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];
/** Letra do contato na agenda: a primeira do nome sem acento; sem nome ou com número/símbolo, "#". */
function letraDoContato(nome: string | null) {
  const l = (nome ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(l) ? l : "#";
}

/** Conversa nova: um contato do WhatsApp ou qualquer número (conferido no WhatsApp antes de abrir). */
function NovaConversa({ numberId, fechar, onAberta }: { numberId: string; fechar: () => void; onAberta: (chatId: string) => void }) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState("");
  const contatos = useQuery({
    queryKey: ["whatsapp", "contatos", numberId],
    queryFn: () => contatosDoWhatsApp({ data: { numberId } }),
    staleTime: 10 * 60_000,
  });
  const abrir = useMutation({
    mutationFn: (c: { telefone: string; nome: string | null }) => abrirConversaNova({ data: { numberId, telefone: c.telefone, nome: c.nome } }),
    onSuccess: async ({ chatId }) => {
      await qc.refetchQueries({ queryKey: ["whatsapp", "conversas"] });
      onAberta(chatId);
    },
  });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [fechar]);
  const termo = texto.trim().toLowerCase();
  const digitos = texto.replace(/\D/g, "");
  // Todos os contatos, por ordem alfabética e agrupados pela letra (sem nome vão para "#").
  const grupos = useMemo(() => {
    const lista = (contatos.data ?? []).filter(
      (c) => !termo || (c.nome ?? "").toLowerCase().includes(termo) || (digitos.length >= 3 && c.telefone.includes(digitos)),
    );
    const porLetra = new Map<string, typeof lista>();
    for (const c of lista) {
      const l = letraDoContato(c.nome);
      porLetra.set(l, [...(porLetra.get(l) ?? []), c]);
    }
    for (const [l, cs] of porLetra)
      porLetra.set(
        l,
        cs.sort((a, b) => (a.nome && b.nome ? a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }) : a.nome ? -1 : b.nome ? 1 : a.telefone.localeCompare(b.telefone))),
      );
    return { porLetra, total: lista.length };
  }, [contatos.data, termo, digitos]);
  const numero = telefoneComDdi(texto);
  const ehContato = Boolean(numero && (contatos.data ?? []).some((c) => c.telefone === numero));
  const rolagem = useRef<HTMLDivElement>(null);
  const irParaLetra = (letra: string) => {
    // Letra sem contatos: a próxima que tem.
    const alvo = LETRAS.slice(LETRAS.indexOf(letra)).find((l) => grupos.porLetra.has(l)) ?? [...grupos.porLetra.keys()].at(-1);
    const sec = alvo ? rolagem.current?.querySelector<HTMLElement>(`[data-secao="${alvo}"]`) : null;
    if (sec && rolagem.current) rolagem.current.scrollTop = sec.offsetTop;
  };
  const arrastando = useRef(false);
  const letraNoPonto = (e: { clientX: number; clientY: number }) =>
    (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>("[data-letra]")?.dataset.letra;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-nova-conversa"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10dvh]"
      onClick={(e) => e.target === e.currentTarget && fechar()}
    >
      <div className="flex h-[min(80dvh,44rem)] w-full max-w-md flex-col gap-3 rounded-lg bg-superficie p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 id="titulo-nova-conversa" className="text-lg font-semibold">
            Nova conversa
          </h2>
          <button type="button" onClick={fechar} aria-label="Fechar" className="rounded-md p-1.5 hover:bg-superficie-2">
            <X size={18} />
          </button>
        </div>
        <input
          autoFocus
          type="search"
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && numero && !abrir.isPending) abrir.mutate({ telefone: numero, nome: null });
          }}
          placeholder="Nome ou número (ex.: 47 99999-0000)"
          aria-label="Nome ou número"
          className="w-full rounded-md border border-linha bg-superficie px-3 py-2 outline-none focus:border-floresta"
        />
        {abrir.isError && (
          <p role="alert" className="text-sm text-vermelho">
            {abrir.error instanceof Error && abrir.error.message ? abrir.error.message : "Não foi possível abrir a conversa."}
          </p>
        )}
        <div className="relative flex min-h-0 flex-1">
          <div ref={rolagem} className="relative min-h-0 flex-1 overflow-y-auto pr-6">
            {numero && !ehContato && (
              <div>
                <button
                  type="button"
                  disabled={abrir.isPending}
                  onClick={() => abrir.mutate({ telefone: numero, nome: null })}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-superficie-2 disabled:opacity-60"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-floresta-clara text-floresta-texto">
                    <Phone size={16} aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <b className="block">Conversar com {formatarTelefone(numero) ?? numero}</b>
                    <span className="text-sm text-muted">{abrir.isPending ? "Conferindo no WhatsApp…" : "Número fora dos seus contatos"}</span>
                  </span>
                </button>
              </div>
            )}
            {LETRAS.filter((l) => grupos.porLetra.has(l)).map((letra) => (
              <section key={letra} data-secao={letra} aria-label={letra === "#" ? "Sem nome ou outros" : `Letra ${letra}`}>
                <h3 className="sticky top-0 z-10 bg-superficie px-2 py-1 text-xs font-semibold text-floresta-texto">{letra}</h3>
                <ul>
                  {grupos.porLetra.get(letra)!.map((c) => (
                    <li key={c.jid} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 52px" }}>
                      <button
                        type="button"
                        disabled={abrir.isPending}
                        onClick={() => abrir.mutate({ telefone: c.telefone, nome: c.nome })}
                        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-superficie-2 disabled:opacity-60"
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-superficie-2 text-sm font-semibold">
                          {letra === "#" ? "#" : letra}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate">{c.nome ?? formatarTelefone(c.telefone) ?? c.telefone}</span>
                          {c.nome && <span className="block text-sm text-muted">{formatarTelefone(c.telefone) ?? c.telefone}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {contatos.isPending && <p className="px-2 py-3 text-sm text-muted">Carregando os contatos…</p>}
            {contatos.isError && <p className="px-2 py-3 text-sm text-vermelho">Não foi possível carregar os contatos. Ainda dá para digitar um número.</p>}
            {contatos.data && !grupos.total && !numero && <p className="px-2 py-3 text-sm text-muted">Nenhum contato com esse nome. Digite o número.</p>}
          </div>
          {grupos.total > 0 && (
            // Índice das letras: tocar ou arrastar leva à letra (como na agenda do celular).
            <nav
              aria-label="Ir para a letra"
              className="absolute inset-y-0 right-0 flex w-5 touch-none select-none flex-col items-center justify-between py-1 text-[10px] font-semibold leading-none"
              onPointerDown={(e) => {
                arrastando.current = true;
                e.currentTarget.setPointerCapture(e.pointerId);
                const l = letraNoPonto(e);
                if (l) irParaLetra(l);
              }}
              onPointerMove={(e) => {
                if (!arrastando.current) return;
                const l = letraNoPonto(e);
                if (l) irParaLetra(l);
              }}
              onPointerUp={() => (arrastando.current = false)}
              onPointerCancel={() => (arrastando.current = false)}
            >
              {LETRAS.map((l) => (
                <button
                  key={l}
                  type="button"
                  data-letra={l}
                  tabIndex={-1}
                  aria-label={l === "#" ? "Sem nome ou outros" : `Letra ${l}`}
                  onClick={() => irParaLetra(l)}
                  className={grupos.porLetra.has(l) ? "text-floresta-texto" : "text-muted opacity-40"}
                >
                  {l}
                </button>
              ))}
            </nav>
          )}
        </div>
        {grupos.total > 0 && (
          <p className="text-right text-xs text-muted">
            {grupos.total.toLocaleString("pt-BR")} contato{grupos.total === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
}

export function ListaConversas({
  conversas,
  selecionada,
  onSelecionar,
  busca,
}: {
  conversas: ConversaResumo[];
  selecionada: string | null;
  onSelecionar: (id: string) => void;
  busca: string;
}) {
  // Arquivadas (como no WhatsApp Web): as que a pessoa arquivou (voltam com mensagem nova)
  // e as que mantém arquivadas (menu ⋮, não voltam), numa linha no topo da lista.
  const [verArquivadas, setVerArquivadas] = useState(false);
  const [mostrarQr, setMostrarQr] = useState(false);
  const meu = useQuery({
    queryKey: ["whatsapp", "meu"],
    queryFn: () => meuWhatsApp(),
    staleTime: 30_000,
  });
  const precisaConectar = Boolean(
    meu.data?.disponivel &&
    meu.data.podeConectar &&
    meu.data.numero?.status !== "conectado",
  );
  const termo = busca.trim().toLowerCase();
  const org = useOrganizacao("conversa");
  const [aba, setAba] = useAbaOrganizacao("conversa");
  // A aba "Arquivadas" das pastas (0059) passou para a linha do topo.
  useEffect(() => {
    if (aba === "arquivadas") {
      setAba("todas");
      setVerArquivadas(true);
    }
  }, [aba, setAba]);
  const mantida = (c: ConversaResumo) => Boolean(org.data?.itens[c.id]?.arquivado);
  const arquivada = (c: ConversaResumo) => c.concluida || mantida(c);
  const arquivadas = conversas.filter(arquivada);
  const daAba = filtrarPorAba(conversas, (c) => c.id, org.data, aba === "arquivadas" ? "todas" : aba);
  // A busca acha tudo, inclusive as arquivadas; sem busca, vale a aba (ou a lista das arquivadas).
  const filtradas = termo
    ? conversas.filter((c) =>
        [c.nome, c.telefone ?? "", c.numero.rotulo, c.previa ?? ""].some((x) =>
          x.toLowerCase().includes(termo),
        ),
      )
    : verArquivadas
      ? arquivadas
      : fixadasNoTopo(daAba.filter((c) => !c.concluida));
  const progressiva = useListaProgressiva(filtradas.length, `${termo}|${aba}|${verArquivadas}`);
  // Sem conversas e sem o WhatsApp conectado: o QR code já fica na tela.
  if (!conversas.length && precisaConectar) return <ConectarWhatsApp />;
  if (!conversas.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BarraDoWhatsApp numero={meu.data?.numero ?? null} onSelecionar={onSelecionar} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-muted">
          <Smartphone size={32} strokeWidth={1.6} aria-hidden />
          <p>
            Nenhuma conversa ainda. As mensagens que chegarem nos números de
            WhatsApp que você acompanha aparecem aqui.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BarraDoWhatsApp numero={meu.data?.numero ?? null} onSelecionar={onSelecionar} />
      {!termo && !verArquivadas && <AbasOrganizacao tipo="conversa" aba={aba} onAba={setAba} semArquivadas />}
      <ul className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {precisaConectar && (
          <li className="border-b border-linha bg-superficie-2">
            {mostrarQr ? (
              <ConectarWhatsApp automatico onFechar={() => setMostrarQr(false)} />
            ) : (
              <button
                type="button"
                onClick={() => setMostrarQr(true)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm"
              >
                <QrCode
                  size={18}
                  aria-hidden
                  className="shrink-0 text-floresta-texto"
                />
                <span className="min-w-0 flex-1">
                  <b className="block">Seu WhatsApp está desconectado</b>
                  <span className="text-muted">
                    As mensagens novas não chegam ao Omni. Toque para conectar
                    de novo.
                  </span>
                </span>
              </button>
            )}
          </li>
        )}
        {!termo && verArquivadas && (
          <li className="flex items-center gap-2 border-b border-linha bg-superficie-2 px-3 py-2 text-sm">
            <button
              type="button"
              onClick={() => setVerArquivadas(false)}
              aria-label="Voltar às conversas"
              className="flex size-8 items-center justify-center rounded-full hover:bg-superficie"
            >
              <ArrowLeft size={18} aria-hidden />
            </button>
            <span className="font-medium">Arquivadas</span>
          </li>
        )}
        {!termo && !verArquivadas && arquivadas.length > 0 && (
          <li className="border-b border-linha">
            <button
              type="button"
              onClick={() => setVerArquivadas(true)}
              className="flex w-full items-center gap-4 px-6 py-3 text-left text-sm hover:bg-superficie-2"
            >
              <Archive size={18} aria-hidden className="text-floresta-texto" />
              <span className="flex-1 font-medium">Arquivadas</span>
              <span className="text-xs font-semibold text-floresta-texto">{arquivadas.length}</span>
            </button>
          </li>
        )}
        {filtradas.slice(0, progressiva.limite).map((c) => (
          <ItemConversa
            key={c.id}
            c={c}
            selecionada={c.id === selecionada}
            onSelecionar={onSelecionar}
          />
        ))}
        {progressiva.faltam > 0 && <li ref={progressiva.sentinela} className="h-8" aria-hidden />}
        {!filtradas.length && (
          <li className="px-6 py-8 text-center text-muted">
            {termo
              ? "Nada encontrado."
              : verArquivadas
                ? "Nenhuma conversa arquivada."
                : aba !== "todas" && !daAba.length
                    ? "Nenhuma conversa nesta pasta. Use o menu ⋮ de uma conversa para pôr aqui."
                    : "Tudo em dia. As conversas voltam sozinhas quando chegar algo novo."}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Fixadas no topo (a fixada por último primeiro); o resto na ordem de sempre (mais recente). */
function fixadasNoTopo(lista: ConversaResumo[]): ConversaResumo[] {
  const fixadas = lista.filter((c) => c.fixadaEm).sort((a, b) => b.fixadaEm!.localeCompare(a.fixadaEm!));
  return [...fixadas, ...lista.filter((c) => !c.fixadaEm)];
}

function prefetchMensagens(qc: ReturnType<typeof useQueryClient>, chatId: string) {
  void qc.prefetchQuery({ queryKey: ["whatsapp", "mensagens", chatId], queryFn: () => mensagensDaConversa({ data: { chatId } }), staleTime: 15_000 });
}

const ItemConversa = memo(function ItemConversa({
  c,
  selecionada,
  onSelecionar,
}: {
  c: ConversaResumo;
  selecionada: boolean;
  onSelecionar: (id: string) => void;
}) {
  const qc = useQueryClient();
  const concluir = useConcluirConversa();
  const marcar = useMarcarConversaLida();
  // Não lida: mensagens do contato depois da leitura, ou marcada como não lida (0075).
  const lida = c.naoLidas === 0 && !c.marcadaNaoLida;
  const alternarLida = () => marcar.mutate({ chatId: c.id, lida: !lida });
  const concluirOuReabrir = { rotulo: c.concluida ? "Desarquivar" : "Arquivar", icone: c.concluida ? ArchiveRestore : Archive, acao: () => concluir.mutate({ conversa: c, concluir: !c.concluida }) };
  const { dx, moveu, fundo, handlers } = useDeslizarLados({ direita: c.podeResponder ? acaoLida(lida, alternarLida) : undefined, esquerda: concluirOuReabrir });
  // Fixar no topo da lista (até 3, como no WhatsApp; 0087).
  const fixar = useMutation({
    mutationFn: () => fixarConversa({ data: { chatId: c.id, fixar: !c.fixadaEm } }),
    onError: (e) => alert(e instanceof Error ? e.message : "Não foi possível fixar."),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] }),
  });
  const fixarOuDesafixar = { rotulo: c.fixadaEm ? "Desafixar conversa" : "Fixar conversa", icone: c.fixadaEm ? PinOff : Pin, acao: () => fixar.mutate() };
  const menu = useMenuDeContexto([...(c.podeResponder ? [acaoLida(lida, alternarLida)] : []), fixarOuDesafixar, concluirOuReabrir]);
  return (
    <li className="group relative border-b border-linha" onContextMenu={menu.abrir}>
      {fundo}
      <button
        type="button"
        {...handlers}
        onClick={() => {
          if (moveu.current) return; // foi um deslize, não um toque
          onSelecionar(c.id);
        }}
        // Busca as mensagens antes do clique (passar o mouse ou focar): a conversa abre na hora.
        onMouseEnter={() => prefetchMensagens(qc, c.id)}
        onFocus={() => prefetchMensagens(qc, c.id)}
        aria-current={selecionada ? "true" : undefined}
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        className={`relative flex w-full touch-pan-y items-center gap-3 bg-superficie py-3 pl-4 pr-10 text-left hover:bg-superficie-2 ${selecionada ? "bg-superficie-2" : ""}`}
      >
        <FotoConversa c={c} tamanho="size-11" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`truncate ${lida ? "font-medium" : "font-semibold"}`}>{c.nome}</span>
            <span className={`flex shrink-0 items-center gap-1 text-xs ${lida ? "text-muted" : "font-semibold text-floresta-texto"}`}>
              {c.fixadaEm && <Pin size={12} aria-label="Fixada" className="rotate-45 text-muted" />}
              {quandoCurto(c.ultimaEm)}
            </span>
          </span>
          <span className="flex items-center justify-between gap-2">
            <span className={`truncate text-sm ${lida ? "text-muted" : "text-ink"}`}>{c.previa ?? ""}</span>
            {!lida &&
              (c.naoLidas ? (
                <span
                  className="shrink-0 rounded-full bg-floresta px-1.5 text-center text-[11px] font-semibold leading-5 text-white"
                  style={{ minWidth: "1.25rem" }}
                  aria-label={`${c.naoLidas} mensagens não lidas`}
                >
                  {c.naoLidas > 98 ? "99+" : c.naoLidas}
                </span>
              ) : (
                <span className="size-3 shrink-0 rounded-full bg-floresta-texto" aria-label="Marcada como não lida" />
              ))}
          </span>
          <span className="block truncate text-xs text-muted">
            WhatsApp · {c.numero.rotulo}
            {c.concluida ? " · Arquivada" : ""}
          </span>
        </span>
      </button>
      {dx === 0 && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1">
          {c.podeResponder && <BotaoLida lida={lida} alternar={alternarLida} />}
          <MenuOrganizar tipo="conversa" itemId={c.id} nome={c.nome} rotulos={{ arquivar: "Manter arquivada", desarquivar: "Tirar das arquivadas" }} />
        </div>
      )}
      {menu.menu}
    </li>
  );
});

const ICONE_TIPO: Partial<Record<MensagemWhatsApp["tipo"], typeof Image>> = {
  imagem: Image,
  video: Video,
  audio: Mic,
  documento: FileText,
};
const ROTULO_TIPO: Record<MensagemWhatsApp["tipo"], string> = {
  texto: "",
  imagem: "Imagem",
  video: "Vídeo",
  audio: "Áudio",
  documento: "Arquivo",
  figurinha: "Figurinha",
  localizacao: "Localização",
  contato: "Contato",
  outro: "Mensagem que o Omni ainda não mostra",
};

function Midia({ m }: { m: MensagemWhatsApp }) {
  const url = m.midia ?? `/api/whatsapp/midia/${m.id}`;
  if (m.tipo === "imagem" || m.tipo === "figurinha") {
    return (
      <ImagemComPrevia
        src={url}
        alt={m.texto ?? "Imagem do WhatsApp"}
        nome={m.arquivo ?? `whatsapp-${m.em.slice(0, 10)}-${m.id.slice(0, 6)}.${m.tipo === "figurinha" ? "webp" : "jpg"}`}
        className="max-h-72 rounded-md object-contain"
      />
    );
  }
  if (m.tipo === "audio")
    return (
      <audio controls preload="none" src={url} className="mb-1 max-w-full" />
    );
  if (m.tipo === "video")
    return (
      <video
        controls
        preload="none"
        src={url}
        className="mb-1 max-h-72 max-w-full rounded-md"
      />
    );
  if (m.tipo === "documento") {
    return (
      <a
        href={url}
        className="mb-1 flex items-center gap-2 rounded-md border border-current/20 px-2 py-1.5 underline-offset-2 hover:underline"
      >
        <FileText size={16} aria-hidden /> {m.arquivo ?? "Arquivo"}{" "}
        <Download size={14} aria-hidden />
      </a>
    );
  }
  return null;
}

/** Ligação com o contato, na linha do tempo da conversa (com a gravação, se houver). */
function LinhaDeChamada({ m }: { m: MensagemWhatsApp }) {
  const c = m.chamada!;
  const perdida = c.direcao === "entrada" && !c.atendida;
  const Icone = perdida
    ? PhoneMissed
    : c.direcao === "entrada"
      ? PhoneIncoming
      : PhoneOutgoing;
  const quando = horaSP(new Date(m.em));
  const texto = perdida
    ? "Chamada perdida"
    : !c.atendida
      ? "Chamada não atendida"
      : c.direcao === "entrada"
        ? "Ligação recebida"
        : "Ligação feita";
  return (
    <div className="my-1 flex flex-col items-center gap-1">
      <p
        className={`flex items-center gap-1.5 rounded-full bg-superficie px-3 py-1 text-xs shadow-sm ${perdida ? "text-vermelho" : "text-muted"}`}
      >
        <Icone size={14} aria-hidden /> {texto}
        {c.segundos !== null &&
          ` · ${Math.floor(c.segundos / 60)}:${String(c.segundos % 60).padStart(2, "0")}`}{" "}
        · {quando}
      </p>
      {c.gravacao && (
        <audio
          controls
          preload="none"
          src={`/api/chamadas/gravacoes/${c.id}`}
          className="h-8 max-w-full"
        />
      )}
      <ResumoChamada
        callId={c.id}
        resumo={c.resumo}
        situacao={c.resumoSituacao}
        temTranscricao={c.temTranscricao}
        compacto
        podePedir={c.minha && c.gravacao}
        podeRegistrar={c.minha}
      />
    </div>
  );
}

/** Grupo: a mensagem abre uma sequência (mostra nome e foto) se a anterior é de outra pessoa, de outro dia ou não é mensagem. */
function inicioDaSequencia(itens: Array<{ k: string; m?: MensagemWhatsApp }>, i: number, novoDia: boolean): boolean {
  const atual = itens[i]?.m;
  const antes = itens[i - 1]?.m;
  if (novoDia || !atual || !antes || antes.chamada || antes.deMim !== atual.deMim) return true;
  return (antes.autorId ?? antes.autor) !== (atual.autorId ?? atual.autor);
}

function Balao({ m, grupo, chatId, inicio = true }: { m: MensagemWhatsApp; grupo: boolean; chatId?: string; /** Primeira de uma sequência da mesma pessoa (grupo: nome e foto). */ inicio?: boolean }) {
  if (m.chamada) return <LinhaDeChamada m={m} />;
  const comAutor = grupo && !m.deMim;
  const acoes = useAcoes();
  const selecionando = Boolean(acoes?.selecionadas);
  const marcada = Boolean(m.waId && acoes?.selecionadas?.has(m.waId));
  const favorita = Boolean(m.waId && acoes?.detalhes?.favoritas.includes(m.waId));
  const Icone = ICONE_TIPO[m.tipo];
  const temMidia =
    ["imagem", "figurinha", "audio", "video", "documento"].includes(m.tipo) &&
    !m.ensaio;
  return (
    <div
      className={`flex gap-2 ${m.deMim ? "justify-end" : "justify-start"} ${comAutor && !inicio ? "pl-10" : ""} ${m.pendente ? "motion-safe:animate-[omni-entrar_160ms_ease-out]" : ""} ${selecionando && m.waId ? "cursor-pointer" : ""} ${marcada ? "rounded-md bg-azul/10" : ""}`}
      onClick={selecionando && m.waId ? () => acoes?.alternarSelecao(m) : undefined}
    >
      {selecionando && m.waId && <input type="checkbox" readOnly checked={marcada} aria-label="Selecionar mensagem" className={`mt-2 ${m.deMim ? "order-first mr-auto" : ""}`} />}
      {comAutor && inicio && chatId && <FotoDoAutor chatId={chatId} autorId={m.autorId} nome={m.autor} />}
      <div className={`flex max-w-[80%] flex-col ${m.deMim ? "items-end" : "items-start"}`}>
      <MenuDaMensagem m={m}>
      <div
        className={`max-w-full rounded-lg px-3 py-2 text-sm shadow-sm ${
          m.ensaio
            ? "border border-dashed border-floresta bg-superficie"
            : m.deMim
              ? "bg-floresta text-white"
              : "bg-superficie"
        }`}
      >
        {comAutor && inicio && m.autor && (
          <p className="mb-0.5 flex items-baseline gap-2 text-xs font-semibold" style={{ color: corDoAutor(m.autorId ?? m.autor) }}>
            <span>{m.autor}</span>
            {m.autorPerfil && <span className="truncate font-normal text-muted">~ {m.autorPerfil}</span>}
          </p>
        )}
        {m.ensaio && (
          <p className="mb-0.5 text-xs font-semibold text-floresta-texto">
            Ensaio: registrada no Omni, não enviada
          </p>
        )}
        {m.encaminhada && !m.apagada && (
          <p className={`mb-0.5 flex items-center gap-1 text-xs italic ${m.deMim ? "text-white/75" : "text-muted"}`}>
            <Forward size={12} aria-hidden /> Encaminhada
          </p>
        )}
        {!m.apagada && <CitacaoNoBalao m={m} />}
        {m.apagada && (
          <p className={`flex items-center gap-1.5 italic ${m.deMim ? "text-white/80" : "text-muted"}`}>
            <Ban size={14} aria-hidden /> {m.deMim ? "Você apagou esta mensagem" : "Mensagem apagada"}
          </p>
        )}
        {!m.apagada && temMidia && <Midia m={m} />}
        {!m.apagada && m.tipo !== "texto" && !temMidia && (
          <p
            className={`flex items-center gap-1 text-xs ${m.deMim ? "text-white/80" : "text-muted"}`}
          >
            {Icone && <Icone size={14} aria-hidden />} {ROTULO_TIPO[m.tipo]}
            {m.arquivo ? `: ${m.arquivo}` : ""}
          </p>
        )}
        {!m.apagada && m.tipo === "texto" && primeiroLink(m.texto) && <PreviaDoLink url={primeiroLink(m.texto)!} deMim={m.deMim && !m.ensaio} />}
        {!m.apagada && m.texto && <TextoComLinks texto={m.texto} deMim={m.deMim && !m.ensaio} />}
        <p
          className={`mt-0.5 flex items-center justify-end gap-1 text-[11px] ${m.deMim && !m.ensaio ? "text-white/70" : "text-muted"}`}
        >
          {favorita && <Star size={11} aria-label="Favorita" className="fill-current" />}
          {m.editada && !m.apagada && <span className="italic">Editada</span>}
          {horaSP(new Date(m.em))}
          {m.deMim && m.status === "lida" && (
            // Azul como no WhatsApp (claro, para ler sobre o verde do balão).
            <CheckCheck size={15} strokeWidth={2.4} aria-label="Lida" className="text-sky-300" />
          )}
          {m.deMim && m.status === "entregue" && (
            <CheckCheck
              size={14}
              aria-label="Entregue"
              className="opacity-60"
            />
          )}
          {m.pendente && <Clock size={13} aria-label="Enviando" className="opacity-70" />}
          {m.deMim && m.status === "enviada" && (
            <Check size={14} aria-label="Enviada" className="opacity-60" />
          )}
        </p>
      </div>
      </MenuDaMensagem>
      <ReacoesDoBalao m={m} />
      </div>
    </div>
  );
}

export function PainelConversa({
  conversa,
  onVoltar,
  naMissao = false,
  onConcluida,
  contato,
}: {
  conversa: ConversaResumo;
  onVoltar: () => void;
  naMissao?: boolean;
  /** Depois de concluir: a tela principal passa para a próxima conversa. */
  onConcluida?: () => void;
  /**
   * Caixa única: o contato da agenda da empresa (e-mails ligados a este telefone).
   * Os e-mails da própria caixa com ele entram na linha do tempo, entre as mensagens.
   */
  contato?: { id: string | null; enderecos: string[]; onAbrirEmail: (graphId: string) => void; onEscreverEmail: (para: string) => void };
}) {
  const concluir = useConcluirConversa();
  const fundo = useFundoDaConversa(conversa.id);
  // Ligações com o contato (conversa com pessoa, com número): aba à parte.
  const temLigacoes = !conversa.grupo && Boolean(conversa.telefone);
  const [aba, setAba] = useState<"mensagens" | "ligacoes">("mensagens");
  useEffect(() => setAba("mensagens"), [conversa.id]);
  const ligacoes = useLigacoesDaConversa(conversa.id, temLigacoes);
  const q = useQuery({
    queryKey: ["whatsapp", "mensagens", conversa.id],
    queryFn: () => mensagensDaConversa({ data: { chatId: conversa.id } }),
    // Já vista: aparece na hora; o tempo real (e esta releitura) trazem o que mudou.
    staleTime: 15_000,
  });
  // Histórico baixado neste aparelho (só o dono do número): junta com o servidor sem repetir.
  const aparelho = useMensagensDoAparelho(conversa.id, conversa.numero.id, conversa.podeResponder);
  const doServidor = new Set((q.data ?? []).map((m) => m.waId).filter(Boolean));
  // Reações, favoritas, fixadas e as apagadas só para mim (0087).
  const detalhes = useDetalhesDaConversa(conversa.id);
  const ocultas = new Set(detalhes.data?.ocultas ?? []);
  const mensagens = q.data
    ? [...q.data, ...aparelho.mensagens.filter((m) => !doServidor.has(m.waId))].filter((m) => !m.waId || !ocultas.has(m.waId)).sort((a, b) => a.em.localeCompare(b.em))
    : undefined;
  // Ações nas mensagens (como no WhatsApp Web).
  const [respondendo, setRespondendo] = useState<MensagemWhatsApp | null>(null);
  const [editando, setEditando] = useState<MensagemWhatsApp | null>(null);
  const [encaminhando, setEncaminhando] = useState<MensagemWhatsApp[] | null>(null);
  const [selecionadas, setSelecionadas] = useState<Set<string> | null>(null);
  const [avisoAcao, setAvisoAcao] = useState<string | null>(null);
  useEffect(() => {
    setRespondendo(null);
    setSelecionadas(null);
  }, [conversa.id]);
  useEffect(() => {
    if (!avisoAcao) return;
    const t = setTimeout(() => setAvisoAcao(null), 4000);
    return () => clearTimeout(t);
  }, [avisoAcao]);
  const todasAsConversas = useConversas(Boolean(encaminhando));
  const acoes = {
    conversa,
    detalhes: detalhes.data,
    mensagens: mensagens ?? [],
    responder: (m: MensagemWhatsApp) => setRespondendo(m),
    editar: (m: MensagemWhatsApp) => setEditando(m),
    encaminhar: (ms: MensagemWhatsApp[]) => setEncaminhando(ms),
    selecionadas,
    alternarSelecao: (m: MensagemWhatsApp) => {
      if (!m.waId) return;
      const nova = new Set(selecionadas ?? []);
      if (nova.has(m.waId)) nova.delete(m.waId);
      else nova.add(m.waId);
      setSelecionadas(nova);
    },
    irPara: (waId: string) => {
      const alvo = mensagens?.find((m) => m.waId === waId);
      const el = alvo ? document.querySelector<HTMLElement>(`[data-msg="${CSS.escape(alvo.id)}"]`) : null;
      if (!el) return setAvisoAcao("Essa mensagem não está carregada.");
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.animate([{ backgroundColor: "rgba(56,139,253,0.25)" }, { backgroundColor: "transparent" }], { duration: 1600 });
    },
    aviso: setAvisoAcao,
  };
  const enderecos = contato?.enderecos ?? [];
  const emails = useQuery({
    queryKey: ["unica", "emails", enderecos.join(",")],
    queryFn: () => emailsDoContato({ data: { enderecos } }),
    enabled: enderecos.length > 0,
  });
  const [vincular, setVincular] = useState(false);
  // Linha do tempo: WhatsApp e e-mail por data. Com mensagens antigas ainda por carregar,
  // os e-mails mais antigos que a primeira mensagem esperam (não ficam fora de ordem).
  const primeira = mensagens?.[0]?.em;
  const itens: Array<{ k: "wa"; em: string; id: string; m: MensagemWhatsApp } | { k: "email"; em: string; id: string; e: EmailDoContato }> | undefined = mensagens
    ? [
        ...mensagens.map((m) => ({ k: "wa" as const, em: m.em, id: m.id, m })),
        ...(emails.data ?? []).filter((e) => !aparelho.haMais || !primeira || e.em >= primeira).map((e) => ({ k: "email" as const, em: e.em, id: `email-${e.id}`, e })),
      ].sort((a, b) => a.em.localeCompare(b.em))
    : undefined;
  // Como no WhatsApp: abre na primeira não lida; seta para as novas ou para o fim.
  // Lida (0075): abrir e ler até o fim marcam a conversa como lida para esta pessoa.
  const marcarLida = useMarcarConversaLida();
  // Até onde estava lida quando a conversa foi aberta (abrir já marca como lida).
  const lidaNaAbertura = useRef(conversa.lidaAte);
  const lidaAte = lidaNaAbertura.current ? Date.parse(lidaNaAbertura.current) : -Infinity;
  const ultimaMarcacao = useRef(0);
  const lerTudo = () => {
    if (!conversa.podeResponder || Date.now() - ultimaMarcacao.current < 5_000) return;
    ultimaMarcacao.current = Date.now();
    marcarLida.mutate({ chatId: conversa.id, lida: true });
  };
  useEffect(() => {
    if (conversa.podeResponder && (conversa.naoLidas > 0 || conversa.marcadaNaoLida)) lerTudo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversa.id]);
  const rolagem = useRolagemDoChat(
    `wa:${conversa.id}`,
    itens?.map((i) => ({
      id: i.id,
      em: i.em,
      deMim: i.k === "wa" ? i.m.deMim : i.e.pasta === "sentitems",
      // Não lida: do contato depois da última leitura; e-mail recebido não lido no Outlook.
      naoLida: i.k === "wa" ? !i.m.deMim && conversa.podeResponder && Date.parse(i.m.em) > lidaAte : i.e.pasta === "inbox" && !i.e.lido,
    })),
    { aoLerTudo: () => (conversa.naoLidas > 0 || conversa.marcadaNaoLida ? lerTudo() : undefined) },
  );
  let dia = "";
  return (
    <ProvedorDeAcoes value={acoes}>
    <div className="flex min-h-0 flex-1 flex-col">
      {avisoAcao && (
        <p role="status" className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-md bg-ink px-3 py-2 text-sm text-fundo shadow-lg">
          {avisoAcao}
        </p>
      )}
      {encaminhando && todasAsConversas.data && (
        <DialogoEncaminhar mensagens={encaminhando} conversas={todasAsConversas.data} deChatId={conversa.id} fechar={() => (setEncaminhando(null), setSelecionadas(null))} />
      )}
      {editando && <DialogoEditar m={editando} chatId={conversa.id} fechar={() => setEditando(null)} />}
      <header className="flex items-center gap-3 border-b border-linha bg-superficie px-5 py-3">
        <button
          type="button"
          onClick={onVoltar}
          aria-label="Voltar para a lista"
          className="-ml-2 flex size-9 items-center justify-center rounded-md hover:bg-superficie-2 md:hidden"
        >
          <ArrowLeft size={20} />
        </button>
        <FotoConversa c={conversa} tamanho="size-10" />
        <div className="min-w-0">
          <NomeDaConversa conversa={conversa} />
          <p className="truncate text-sm text-muted">
            {conversa.grupo
              ? "Grupo"
              : (formatarTelefone(conversa.telefone) ?? "Contato")}{" "}
            · WhatsApp · {conversa.numero.rotulo}
          </p>
        </div>
        <div className="ml-auto">
          <EscolherFundo chatId={conversa.id} />
        </div>
        {contato && enderecos.length > 0 && (
          <button
            type="button"
            title={`Escrever e-mail para ${enderecos[0]}`}
            aria-label={`Escrever e-mail para ${enderecos[0]}`}
            onClick={() => contato.onEscreverEmail(enderecos[0]!)}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2"
          >
            <Mail size={18} aria-hidden /> <span className="hidden lg:inline">E-mail</span>
          </button>
        )}
        {!naMissao && !conversa.grupo && conversa.telefone && (
          <button
            type="button"
            aria-label="Vincular e-mail a este contato"
            title={enderecos.length ? `E-mails vinculados: ${enderecos.join(", ")}. Vincular outro` : "Vincular o e-mail deste contato (e-mails e WhatsApp juntos)"}
            onClick={() => setVincular(true)}
            className="flex items-center justify-center rounded-md border border-linha p-1.5 hover:bg-superficie-2"
          >
            <Link2 size={18} aria-hidden />
          </button>
        )}
        {!conversa.grupo && conversa.telefone && conversa.podeLigar && (
          <button
            type="button"
            aria-label="Ligar pelo meu WhatsApp"
            title="Ligar pelo meu WhatsApp"
            onClick={() => abrirChamada(conversa.numero.id, conversa.telefone!)}
            className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm font-medium text-floresta-texto hover:bg-superficie-2"
          >
            <Phone size={18} /> <span className="hidden sm:inline">Ligar</span>
          </button>
        )}
        {!naMissao && (
          <button
            type="button"
            title={
              conversa.concluida
                ? "Reabrir: volta para a sua lista"
                : "Arquivar: sai da sua lista até chegar mensagem nova"
            }
            onClick={() => {
              concluir.mutate({ conversa, concluir: !conversa.concluida });
              if (!conversa.concluida) onConcluida?.();
            }}
            className="flex items-center gap-1.5 rounded-md border border-linha px-3 py-1.5 text-sm font-medium hover:bg-superficie-2"
          >
            {conversa.concluida ? (
              <ArchiveRestore size={18} aria-hidden />
            ) : (
              <Check size={18} aria-hidden />
            )}
            <span className="hidden sm:inline">
              {conversa.concluida ? "Desarquivar" : "Arquivar"}
            </span>
          </button>
        )}
      </header>
      {!naMissao && <MissoesDaConversa conversa={conversa} />}
      {aba === "mensagens" && selecionadas && <BarraDeSelecao fechar={() => setSelecionadas(null)} />}
      {aba === "mensagens" && !selecionadas && <BarraDeFixadas />}
      {temLigacoes && (
        <div role="tablist" aria-label="Conversa" className="flex gap-1 border-b border-linha bg-superficie px-5">
          {(["mensagens", "ligacoes"] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={aba === a}
              onClick={() => setAba(a)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${aba === a ? "border-floresta text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              {a === "mensagens" ? "Mensagens" : `Ligações${ligacoes.data?.ligacoes.length ? ` (${ligacoes.data.ligacoes.length})` : ""}`}
            </button>
          ))}
        </div>
      )}
      {aba === "ligacoes" && temLigacoes ? (
        <LigacoesDaConversa conversa={conversa} q={ligacoes} />
      ) : (
      <>
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={rolagem.caixa} onScroll={rolagem.aoRolar} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-5" style={estiloDoFundo(fundo)}>
        {q.isPending && <p className="text-center text-muted">Carregando…</p>}
        {q.isError && (
          <p className="text-center text-vermelho">
            Não foi possível carregar a conversa.
          </p>
        )}
        {aparelho.haMais && (
          <div className="text-center">
            <button type="button" onClick={aparelho.mais} className="rounded-md border border-linha bg-superficie px-3 py-1.5 text-sm hover:bg-superficie-2">
              Mostrar mensagens anteriores
            </button>
          </div>
        )}
        {itens?.map((item, i) => {
          const em = new Date(item.em);
          const d = separadorDoDia(em);
          const novoDia = d !== dia;
          dia = d;
          return (
            <div key={item.id} data-msg={item.id}>
              {novoDia && (
                <p className="my-3 text-center">
                  <span className="rounded-full bg-superficie px-2.5 py-0.5 text-xs text-muted shadow-sm">{d}</span>
                </p>
              )}
              {rolagem.divisor?.id === item.id && <AvisoNaoLidas n={rolagem.divisor.n} />}
              {item.k === "wa" ? (
                <Balao m={item.m} grupo={conversa.grupo} chatId={conversa.id} inicio={inicioDaSequencia(itens, i, novoDia)} />
              ) : (
                <CartaoEmail e={item.e} onAbrir={(id) => contato?.onAbrirEmail(id)} />
              )}
            </div>
          );
        })}
      </div>
      <SetaParaBaixo visivel={!rolagem.noFim || rolagem.naoLidasAbaixo > 0} naoLidas={rolagem.naoLidasAbaixo} onClick={rolagem.descer} />
      </div>
      {conversa.podeResponder ? (
        <Resposta conversa={conversa} respondendo={respondendo} onResposta={() => setRespondendo(null)} />
      ) : (
        <footer className="border-t border-linha bg-superficie px-5 py-3 text-sm text-muted">
          Você acompanha esta conversa pela missão. Responde quem acompanha o
          número {conversa.numero.rotulo}.
        </footer>
      )}
      </>
      )}
      {vincular && conversa.telefone && (
        <VincularContato nome={conversa.nome} telefone={conversa.telefone} contatoId={contato?.id ?? null} fechar={() => setVincular(false)} />
      )}
    </div>
    </ProvedorDeAcoes>
  );
}

/** Aba Ligações da conversa: as ligações com este contato, com gravação, resumo e transcrição. */
function LigacoesDaConversa({ conversa, q }: { conversa: ConversaResumo; q: ReturnType<typeof useLigacoesDaConversa> }) {
  if (q.isPending) return <p className="p-5 text-center text-muted">Carregando…</p>;
  if (q.isError) return <FalhaAoCarregar mensagem="Não foi possível carregar as ligações." consulta={q} />;
  if (!q.data.ligacoes.length)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
        <Phone size={28} strokeWidth={1.6} aria-hidden />
        <p>Nenhuma ligação com este contato ainda.</p>
      </div>
    );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <ul className="divide-y divide-linha rounded-xl border border-linha bg-superficie">
        {q.data.ligacoes.map((c) => (
          <ItemDeLigacao
            key={c.id}
            c={c}
            pessoas={q.data.pessoas}
            naConversa
            podeLigar={conversa.podeLigar}
            aoLigar={() => abrirChamada(c.numeroId, c.telefone)}
          />
        ))}
      </ul>
    </div>
  );
}

function useLigacoesDaConversa(chatId: string, ativo: boolean) {
  return useQuery({ queryKey: ["chamadas", "conversa", chatId], queryFn: () => ligacoesDaConversa({ data: { chatId } }), enabled: ativo, refetchInterval: 60_000 });
}

/** Missões ligadas à conversa (normalmente o grupo da missão); liga e desliga quem acompanha o número. */
function MissoesDaConversa({ conversa }: { conversa: ConversaResumo }) {
  const qc = useQueryClient();
  const [escolhendo, setEscolhendo] = useState(false);
  const missoes = useQuery({
    queryKey: ["missoes"],
    queryFn: () => listMissoes(),
    enabled: escolhendo,
  });
  const ligar = useMutation({
    mutationFn: (v: { missionId: string; ligar: boolean }) =>
      ligarConversaMissao({ data: { chatId: conversa.id, ...v } }),
    onSuccess: () => {
      setEscolhendo(false);
      void qc.invalidateQueries({ queryKey: ["whatsapp"] });
    },
  });
  const recusar = useMutation({
    mutationFn: (missionId: string) =>
      recusarSugestaoMissao({ data: { chatId: conversa.id, missionId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["whatsapp"] }),
  });
  if (!conversa.missoes.length && !conversa.podeResponder) return null;
  return (
    <>
      {conversa.sugestoes.map((m) => (
        <div
          key={m.id}
          className="flex flex-wrap items-center gap-2 border-b border-linha bg-superficie-2 px-5 py-2 text-sm"
        >
          <Lightbulb size={14} aria-hidden className="text-floresta-texto" />
          <span>
            O nome do grupo cita a <b>{m.titulo}</b>. Ligar este grupo à missão?
          </span>
          <button
            type="button"
            disabled={ligar.isPending}
            onClick={() => ligar.mutate({ missionId: m.id, ligar: true })}
            className="rounded-md bg-floresta px-2 py-0.5 text-white"
          >
            Ligar
          </button>
          <button
            type="button"
            disabled={recusar.isPending}
            onClick={() => recusar.mutate(m.id)}
            className="rounded-md border border-linha px-2 py-0.5 hover:bg-superficie"
          >
            Não é
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 border-b border-linha bg-superficie px-5 py-2 text-sm">
        <Link2 size={14} aria-hidden className="text-muted" />
        {conversa.missoes.map((m) => (
          <span
            key={m.id}
            className="flex items-center gap-1 rounded-full bg-superficie-2 px-2 py-0.5"
          >
            {m.titulo}
            {conversa.podeResponder && (
              <button
                type="button"
                aria-label={`Desligar de ${m.titulo}`}
                onClick={() => ligar.mutate({ missionId: m.id, ligar: false })}
                className="text-muted hover:text-vermelho"
              >
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        {!conversa.missoes.length && (
          <span className="text-muted">Não ligada a nenhuma missão.</span>
        )}
        {conversa.podeResponder &&
          (escolhendo ? (
            <select
              autoFocus
              aria-label="Escolher a missão"
              defaultValue=""
              onChange={(e) =>
                e.target.value &&
                ligar.mutate({ missionId: e.target.value, ligar: true })
              }
              className="max-w-72 rounded-md border border-linha bg-superficie-2 px-2 py-1"
            >
              <option value="">
                {missoes.isPending ? "Carregando missões…" : "Escolha a missão"}
              </option>
              {missoes.data
                ?.filter((m) => !conversa.missoes.some((x) => x.id === m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} - {m.clientName}
                  </option>
                ))}
            </select>
          ) : (
            <button
              type="button"
              onClick={() => setEscolhendo(true)}
              className="rounded-md border border-linha px-2 py-0.5 hover:bg-superficie-2"
            >
              Ligar à missão
            </button>
          ))}
        {ligar.isError && (
          <span className="text-vermelho">
            {(ligar.error as Error).message}
          </span>
        )}
      </div>
    </>
  );
}

function Resposta({ conversa, respondendo = null, onResposta }: { conversa: ConversaResumo; respondendo?: MensagemWhatsApp | null; onResposta?: () => void }) {
  const qc = useQueryClient();
  const [texto, setTexto] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const seletor = useRef<HTMLInputElement>(null);
  const caixaTexto = useRef<HTMLTextAreaElement>(null);
  // Responder: o cursor vai para a caixa de digitar.
  useEffect(() => {
    if (respondendo) caixaTexto.current?.focus();
  }, [respondendo]);
  const gravador = useGravador();
  // Emoji no ponto do cursor (ou no fim), e o cursor depois dele.
  const inserirEmoji = (emoji: string) => {
    const t = caixaTexto.current;
    const ini = t?.selectionStart ?? texto.length;
    const fim = t?.selectionEnd ?? texto.length;
    setTexto(texto.slice(0, ini) + emoji + texto.slice(fim));
    requestAnimationFrame(() => {
      t?.focus();
      t?.setSelectionRange(ini + emoji.length, ini + emoji.length);
    });
  };
  const enviarVoz = useMutation({
    mutationFn: async () => {
      const voz = await gravador.terminar();
      if (!voz) throw new Error("Nada foi gravado.");
      if (voz.size > 16 * 1024 * 1024) throw new Error("Áudio grande demais (até 16 MB).");
      const form = new FormData();
      form.set("chatId", conversa.id);
      form.set("voz", "1");
      form.set("arquivo", voz);
      const r = await fetch("/api/whatsapp/arquivo", { method: "POST", body: form });
      const corpo = (await r.json().catch(() => ({}))) as { erro?: string };
      if (!r.ok) throw new Error(corpo.erro ?? "Não foi possível enviar o áudio.");
      return corpo;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["whatsapp", "mensagens", conversa.id] }),
  });
  // No teto de tempo, envia o que gravou.
  useEffect(() => {
    if (gravador.gravando && gravador.segundos >= MAX_SEGUNDOS_VOZ && !enviarVoz.isPending) enviarVoz.mutate();
  }, [gravador.gravando, gravador.segundos, enviarVoz]);
  const modo = useQuery({
    queryKey: ["whatsapp", "modo"],
    queryFn: () => modoEnvioWhatsApp(),
    staleTime: Infinity,
  });
  // Como no WhatsApp Web: a mensagem entra na conversa na hora (com o relógio) e a caixa já
  // fica livre; a confirmação do servidor troca pela de verdade. Se der erro, o texto volta.
  const chaveMensagens = ["whatsapp", "mensagens", conversa.id];
  const enviar = useMutation({
    onMutate: async (v: { texto: string; arquivo: File | null; citada?: MensagemWhatsApp | null }) => {
      setTexto("");
      onResposta?.();
      setArquivo(null);
      if (seletor.current) seletor.current.value = "";
      await qc.cancelQueries({ queryKey: chaveMensagens });
      const pendente: MensagemWhatsApp = {
        id: `pendente-${crypto.randomUUID()}`,
        deMim: true,
        autor: null,
        tipo: v.arquivo ? "documento" : "texto",
        texto: v.texto.trim() || null,
        arquivo: v.arquivo?.name ?? null,
        em: new Date().toISOString(),
        status: null,
        pendente: true,
        citada: v.citada?.waId ? { waId: v.citada.waId, texto: v.citada.texto, autorId: v.citada.deMim ? null : (v.citada.autorId ?? null) } : null,
      };
      qc.setQueryData<MensagemWhatsApp[]>(chaveMensagens, (atual) => [...(atual ?? []), pendente]);
      return { pendente };
    },
    onError: (_e, v, ctx) => {
      qc.setQueryData<MensagemWhatsApp[]>(chaveMensagens, (atual) => (atual ?? []).filter((m) => m.id !== ctx?.pendente.id));
      setTexto(v.texto);
      setArquivo(v.arquivo);
    },
    mutationFn: async ({ texto, arquivo, citada }: { texto: string; arquivo: File | null; citada?: MensagemWhatsApp | null }) => {
      if (!arquivo)
        return enviarMensagemWhatsApp({
          data: {
            chatId: conversa.id,
            texto,
            ...(citada?.waId ? { citada: { waId: citada.waId, deMim: citada.deMim, autorId: citada.autorId ?? null, texto: citada.texto } } : {}),
          },
        });
      if (arquivo.size > 16 * 1024 * 1024)
        throw new Error("Arquivo grande demais (até 16 MB).");
      const form = new FormData();
      form.set("chatId", conversa.id);
      form.set("legenda", texto);
      form.set("arquivo", arquivo);
      const r = await fetch("/api/whatsapp/arquivo", {
        method: "POST",
        body: form,
      });
      const corpo = (await r.json().catch(() => ({}))) as { erro?: string };
      if (!r.ok)
        throw new Error(corpo.erro ?? "Não foi possível enviar o arquivo.");
      return corpo;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: chaveMensagens });
      void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] });
    },
  });
  const submeter = (e: FormEvent) => {
    e.preventDefault();
    if (texto.trim() || arquivo) enviar.mutate({ texto, arquivo, citada: respondendo });
  };
  if (modo.data?.modo === "desligado") {
    return (
      <footer className="border-t border-linha bg-superficie px-5 py-3 text-sm text-muted">
        O envio pelo WhatsApp está desligado neste ambiente.
      </footer>
    );
  }
  return (
    <form
      onSubmit={submeter}
      className="border-t border-linha bg-superficie px-5 py-3"
    >
      {respondendo && <RespondendoA m={respondendo} onFechar={() => onResposta?.()} />}
      {modo.data?.modo === "ensaio" && (
        <p className="mb-1 text-xs text-muted">
          Modo de ensaio: a mensagem fica registrada no Omni e não sai pelo
          WhatsApp.
        </p>
      )}
      {enviar.isError && (
        <p className="mb-1 text-sm text-vermelho">
          {(enviar.error as Error).message}
        </p>
      )}
      {(enviarVoz.isError || gravador.erro) && (
        <p role="alert" className="mb-1 text-sm text-vermelho">
          {gravador.erro ?? (enviarVoz.error as Error).message}
        </p>
      )}
      {enviarVoz.isPending && <p className="mb-1 text-sm text-muted">Enviando o áudio…</p>}
      {arquivo && (
        <p className="mb-1 flex items-center gap-2 text-sm">
          <FileText size={14} aria-hidden /> {arquivo.name}
          <button
            type="button"
            aria-label="Tirar o arquivo"
            onClick={() => setArquivo(null)}
            className="text-muted hover:text-vermelho"
          >
            <X size={14} />
          </button>
        </p>
      )}
      {gravador.gravando ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={gravador.cancelar}
            aria-label="Descartar a gravação"
            title="Descartar"
            className="flex size-10 items-center justify-center rounded-md border border-linha text-vermelho hover:bg-superficie-2"
          >
            <Trash2 size={18} />
          </button>
          <p className="flex flex-1 items-center gap-2 rounded-md border border-linha bg-superficie-2 px-3 py-2" aria-live="polite">
            <span className="size-2.5 animate-pulse rounded-full bg-vermelho" aria-hidden />
            <span className="font-mono tabular-nums">{relogio(gravador.segundos)}</span>
            <span className="text-sm text-muted">Gravando…</span>
          </p>
          <button
            type="button"
            onClick={() => enviarVoz.mutate()}
            disabled={enviarVoz.isPending}
            aria-label="Enviar o áudio"
            className="flex size-10 items-center justify-center rounded-md bg-floresta text-white disabled:opacity-60"
          >
            <Send size={18} />
          </button>
        </div>
      ) : (
      <div className="flex items-end gap-2">
        <BotaoEmojis aoEscolher={inserirEmoji} />
        <input
          ref={seletor}
          type="file"
          hidden
          accept="image/jpeg,image/png,image/webp,video/mp4,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.csv,.txt"
          onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => seletor.current?.click()}
          aria-label="Anexar arquivo"
          className="flex size-10 items-center justify-center rounded-md border border-linha hover:bg-superficie-2"
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={caixaTexto}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submeter(e);
          }}
          rows={1}
          maxLength={4096}
          placeholder={
            arquivo
              ? "Legenda (opcional)"
              : `Responder pelo ${conversa.numero.rotulo}…`
          }
          aria-label="Mensagem"
          className="max-h-40 min-h-10 flex-1 resize-y rounded-md border border-linha bg-superficie-2 px-3 py-2"
        />
        {texto.trim() || arquivo ? (
          <button
            type="submit"
            disabled={enviar.isPending}
            aria-label="Enviar"
            className="flex size-10 items-center justify-center rounded-md bg-floresta text-white disabled:opacity-60"
          >
            <Send size={18} />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void gravador.iniciar()}
            disabled={enviarVoz.isPending}
            aria-label="Gravar mensagem de voz"
            title="Gravar mensagem de voz"
            className="flex size-10 items-center justify-center rounded-md bg-floresta text-white disabled:opacity-60"
          >
            <Mic size={18} />
          </button>
        )}
      </div>
      )}
    </form>
  );
}

export function useWhatsAppDaMissao(missionId: string) {
  return useQuery({
    queryKey: ["whatsapp", "missao", missionId],
    queryFn: () => conversasDaMissao({ data: { missionId } }),
  });
}

/** Aba WhatsApp da missão: os grupos ligados a ela (quem vê o Interno lê; responde quem acompanha o número). */
export function WhatsAppDaMissao({ missionId }: { missionId: string }) {
  const q = useWhatsAppDaMissao(missionId);
  const [aberta, setAberta] = useState<string | null>(null);
  if (q.isPending) return <p className="p-5 text-sm text-muted">Carregando…</p>;
  if (q.isError)
    return (
      <p className="p-5 text-sm text-vermelho">
        Não foi possível carregar o WhatsApp da missão.
      </p>
    );
  const conversas = q.data;
  const atual =
    conversas.find((c) => c.id === aberta) ??
    (conversas.length === 1 ? conversas[0] : undefined);
  if (atual)
    return (
      <PainelConversa
        key={atual.id}
        conversa={atual}
        naMissao
        onVoltar={() => setAberta(null)}
      />
    );
  return (
    <div className="flex-1 overflow-y-auto p-5">
      <p className="mb-3 text-sm text-muted">
        Grupos do WhatsApp ligados a esta missão.
      </p>
      <ListaConversas
        conversas={conversas}
        selecionada={null}
        onSelecionar={setAberta}
        busca=""
      />
    </div>
  );
}

/** Foto do contato ou do grupo (pelo servidor do Omni); sem foto ou se falhar, iniciais ou o ícone do grupo. */
export function FotoConversa({
  c,
  tamanho,
}: {
  c: { foto: string | null; grupo: boolean; nome: string };
  tamanho: string;
}) {
  const [falhou, setFalhou] = useState<string | null>(null);
  const comFoto = c.foto && falhou !== c.foto;
  return (
    <span
      className={`flex ${tamanho} shrink-0 items-center justify-center overflow-hidden rounded-full bg-floresta text-white`}
    >
      {comFoto ? (
        <img
          src={c.foto!}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFalhou(c.foto)}
          className="size-full object-cover"
        />
      ) : c.grupo ? (
        <Users size={18} aria-hidden />
      ) : (
        <span className="text-sm font-semibold">
          {/^\p{L}/u.test(c.nome) ? c.nome.slice(0, 2).toUpperCase() : <User size={18} aria-hidden />}
        </span>
      )}
    </span>
  );
}

/**
 * Conectar o próprio WhatsApp (0055): cria o número da pessoa, se ainda não houver,
 * e mostra o QR code, que se renova sozinho até o celular conectar.
 * Só depois de a pessoa pedir (botão, ou `automatico` quando ela já clicou para
 * conectar): abrir Conversas não pode criar o número de quem não usa WhatsApp.
 */
export function ConectarWhatsApp({ onFechar, automatico = false }: { onFechar?: () => void; automatico?: boolean }) {
  const qc = useQueryClient();
  const [pediu, setPediu] = useState(automatico);
  const q = useQuery({
    queryKey: ["whatsapp", "conectar"],
    queryFn: () => conectarMeuWhatsApp(),
    enabled: pediu,
    refetchInterval: (consulta) =>
      consulta.state.data?.estado === "conectado" || consulta.state.error
        ? false
        : 5_000,
    refetchIntervalInBackground: false,
    retry: false,
    gcTime: 0,
  });
  const conectado = q.data?.estado === "conectado";
  useEffect(() => {
    if (!conectado) return;
    void qc.invalidateQueries({ queryKey: ["whatsapp", "meu"] });
    void qc.invalidateQueries({ queryKey: ["whatsapp", "meus"] });
    void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] });
  }, [conectado, qc]);
  return (
    <section
      aria-labelledby="titulo-conectar"
      className="flex flex-1 flex-col items-center gap-4 px-5 py-6 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-floresta text-white">
        <Smartphone size={22} aria-hidden />
      </span>
      <div className="space-y-1">
        <h2 id="titulo-conectar" className="text-lg font-semibold">
          {conectado ? "WhatsApp conectado" : "Conecte seu WhatsApp"}
        </h2>
        <p className="text-sm text-muted">
          {conectado
            ? `Pronto${q.data?.telefone ? `: ${formatarTelefone(q.data.telefone) ?? q.data.telefone}` : ""}. As mensagens novas passam a aparecer aqui.`
            : "As conversas do seu número aparecem aqui, e só você as vê."}
        </p>
      </div>
      {!conectado && !pediu && (
        <>
          <p className="max-w-xs text-sm text-muted">
            Use o WhatsApp do seu celular pelo Omni: ler e responder as conversas, ligar e atender. Se você não usa o WhatsApp no trabalho, pode
            ignorar.
          </p>
          <button
            type="button"
            onClick={() => setPediu(true)}
            className="flex items-center gap-2 rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura"
          >
            <QrCode size={18} aria-hidden /> Conectar meu WhatsApp
          </button>
        </>
      )}
      {!conectado && pediu && (
        <>
          <ol className="max-w-xs list-decimal space-y-1 pl-5 text-left text-sm">
            <li>No seu celular, abra o WhatsApp.</li>
            <li>
              Toque em <b>⋮ → Dispositivos conectados → Conectar dispositivo</b>{" "}
              (no iPhone: <b>Configurações → Dispositivos conectados</b>).
            </li>
            <li>Aponte a câmera para o código abaixo.</li>
          </ol>
          <div className="flex size-60 items-center justify-center rounded-md bg-white p-2">
            {q.isPending && (
              <p className="text-sm text-neutral-600">Gerando o QR code…</p>
            )}
            {q.data?.imagem && (
              <img
                src={q.data.imagem}
                alt="QR code para conectar o seu WhatsApp"
                className="size-full"
              />
            )}
            {q.data && !q.data.imagem && (
              <p className="text-sm text-neutral-600">
                Gerando um novo código…
              </p>
            )}
            {q.isError && (
              <p className="px-2 text-sm text-vermelho">
                {q.error instanceof Error
                  ? q.error.message
                  : "Não foi possível gerar o QR code."}
              </p>
            )}
          </div>
          {q.isError && <TentarDeNovo tentar={() => q.refetch()} tentando={q.isFetching} falhou={q.isError} />}
          <p className="max-w-xs text-xs text-muted">
            O código muda sozinho a cada poucos segundos. Não mostre esta tela a
            ninguém: quem ler o código conecta o seu número.
          </p>
        </>
      )}
      {onFechar && (
        <button
          type="button"
          onClick={onFechar}
          className="text-sm text-muted hover:underline"
        >
          {conectado ? "Fechar" : "Agora não"}
        </button>
      )}
    </section>
  );
}

/** Nome no cabeçalho; em conversa com pessoa, o dono do número pode dar ou trocar o nome (0057). */
function NomeDaConversa({ conversa }: { conversa: ConversaResumo }) {
  const qc = useQueryClient();
  const [editando, setEditando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Adicionar/editar contato (0088): com o número, salva na agenda do celular (como no WhatsApp Web).
  const salvar = useMutation({
    mutationFn: async (nome: string) =>
      conversa.telefone
        ? salvarContatoWhatsApp({ data: { numberId: conversa.numero.id, telefone: conversa.telefone, nome, chatId: conversa.id } })
        : renomearContato({ data: { chatId: conversa.id, nome } }).then(() => ({ noCelular: false })),
    onSuccess: (r) => {
      setEditando(false);
      setAviso(r.noCelular ? null : "Salvo no Omni (não foi para a agenda do celular neste ambiente).");
      void qc.invalidateQueries({ queryKey: ["whatsapp", "conversas"] });
    },
  });
  if (!editando)
    return (
      <div className="min-w-0">
        <h2 className="flex min-w-0 items-center gap-1.5 font-semibold">
          <span className="truncate">{conversa.nome}</span>
          {!conversa.salvo && conversa.perfil && <span className="truncate text-xs font-normal text-muted">~ {conversa.perfil}</span>}
          {!conversa.grupo && conversa.podeResponder && (conversa.salvo || !conversa.telefone) && (
            <button
              type="button"
              onClick={() => setEditando(true)}
              aria-label="Editar contato"
              title="Editar contato"
              className="shrink-0 rounded p-0.5 text-muted hover:text-ink"
            >
              <Pencil size={14} aria-hidden />
            </button>
          )}
          {!conversa.grupo && conversa.podeResponder && !conversa.salvo && conversa.telefone && (
            <button
              type="button"
              onClick={() => setEditando(true)}
              className="flex shrink-0 items-center gap-1 rounded-md border border-linha px-2 py-0.5 text-xs font-medium text-floresta-texto hover:bg-superficie-2"
            >
              <UserPlus size={13} aria-hidden /> Adicionar contato
            </button>
          )}
        </h2>
        {aviso && <p className="text-xs text-muted">{aviso}</p>}
      </div>
    );
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        salvar.mutate(String(new FormData(e.currentTarget).get("nome") ?? ""));
      }}
    >
      <input
        name="nome"
        autoFocus
        maxLength={120}
        defaultValue={conversa.salvo ? conversa.nome : (conversa.perfil ?? "")}
        placeholder="Nome do contato"
        aria-label="Nome do contato"
        className="min-w-0 rounded-md border border-linha bg-superficie px-2 py-0.5 text-sm"
        onKeyDown={(e) => e.key === "Escape" && setEditando(false)}
      />
      <button
        type="submit"
        disabled={salvar.isPending}
        className="rounded-md bg-floresta px-2 py-0.5 text-sm text-white"
      >
        Salvar
      </button>
      {salvar.isError && (
        <span className="text-xs text-vermelho">
          {salvar.error instanceof Error
            ? salvar.error.message
            : "Não foi possível."}
        </span>
      )}
    </form>
  );
}
