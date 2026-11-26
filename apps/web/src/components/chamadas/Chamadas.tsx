import { formatarTelefone } from "@omni/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Mic, MicOff, Pause, Phone, PhoneCall, PhoneIncoming, PhoneOff, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { acaoChamada, painelChamadas, type PainelChamadas } from "../../lib/chamadas-fns.ts";
import { ItemDeLigacao } from "./ItemDeLigacao.tsx";
import { saidaComEcoCancelado, type SaidaDeAudio } from "./saida-com-eco-cancelado.ts";
import type { EstadoChamada } from "../../server/chamadas.ts";
import { Carregando } from "../comum/Carregando.tsx";

/**
 * Chamadas pelo WhatsApp do próprio usuário (docs/integracoes/chamadas-omni.md).
 * O componente fica montado junto da casca: mudar de tela não derruba o áudio.
 * - Ligar com um clique (de uma conversa ou da lista): microfone, linha e discagem.
 * - Chamada recebida em qualquer tela: cartão, toque, notificação do sistema e título piscando.
 * - Barra da chamada em andamento: nome, tempo, gravação, silenciar, encerrar.
 * - "Receber ligações no Omni": conecta a linha sozinho ao abrir o app (desligável).
 * A gravação continua exigindo permissão da administração e a confirmação do aviso, a cada ligação.
 */

const botao = "inline-flex items-center gap-1.5 rounded-md border border-linha px-3 py-2 text-sm hover:bg-superficie-2 disabled:opacity-40";
const botaoVerde = "inline-flex items-center gap-1.5 rounded-md bg-floresta px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40";
const botaoVermelho = "inline-flex items-center gap-1.5 rounded-md bg-vermelho px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40";
const campo = "rounded-md border border-linha bg-superficie px-3 py-2 text-sm";
const ESTADO: Record<string, string> = {
  conectado: "Pronto para ligar e receber",
  desconectado: "Desconectado",
  erro: "Conexão indisponível",
  conectando: "Conectando…",
  ligando: "Ligando…",
  recebendo: "Chamada recebida",
  tocando: "Chamando…",
  ativa: "Em chamada",
  encerrada: "Encerrada",
};
const CHAVE_RECEBER = "omni-receber-ligacoes";
const CHAVE_VISTAS = "omni-chamadas-vistas";

const lerLocal = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const gravarLocal = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    // sem armazenamento local: vale só nesta aba
  }
};

/** Pede para ligar (ex.: botão 📞 de uma conversa). O componente Chamadas atende o pedido. */
export function abrirChamada(numberId: string, peer: string) {
  window.dispatchEvent(new CustomEvent("omni-ligar", { detail: { numberId, peer } }));
}

const duracao = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Chamadas recebidas e não atendidas desde a última visita à tela (marcador no trilho). */
export function useChamadasPerdidas(personId: string): number {
  const painel = useQuery({ queryKey: ["chamadas", personId, "painel"], queryFn: () => painelChamadas(), staleTime: 30_000 });
  const vistas = Number(lerLocal(CHAVE_VISTAS) ?? 0);
  return (painel.data?.chamadas ?? []).filter((c) => c.minha && c.direcao === "entrada" && !c.inicio && c.estado === "encerrada" && new Date(c.criadaEm).getTime() > vistas).length;
}

function nomeDoContato(p: PainelChamadas | undefined, numberId: string, peer: string) {
  return p?.contatos[`${numberId}:${peer}`]?.nome ?? formatarTelefone(peer) ?? `+${peer}`;
}

type Audio = { context: AudioContext; stream: MediaStream; node: AudioWorkletNode; socket: WebSocket; saida: SaidaDeAudio | null };

export function Chamadas({
  personId,
  visivel,
  abrir,
  fechar,
  abrirConversa,
  aoMudarLinha,
}: {
  personId: string;
  visivel: boolean;
  abrir: () => void;
  fechar: () => void;
  abrirConversa: (chatId: string) => void;
  /** Para o trilho mostrar se a linha está pronta para receber ligações. */
  aoMudarLinha?: (pronta: boolean) => void;
}) {
  const qc = useQueryClient();
  const painel = useQuery({ queryKey: ["chamadas", personId, "painel"], queryFn: () => painelChamadas(), refetchInterval: 30_000 });
  const p = painel.data;
  const [numberId, setNumberId] = useState("");
  const [peer, setPeer] = useState("");
  // Gravar vem marcado (decisão de 24/11/2026); a pessoa ainda confirma que avisa os participantes.
  const [gravar, setGravar] = useState(true);
  const [avisei, setAvisei] = useState(true);
  // Ligar a gravação durante a ligação: confirma o aviso antes.
  const [confirmarGravar, setConfirmarGravar] = useState(false);
  const [erro, setErro] = useState("");
  const [audioPronto, setAudioPronto] = useState(false);
  const [mudo, setMudo] = useState(false);
  const [escolhendo, setEscolhendo] = useState<{ peer: string } | null>(null);
  const [receber, setReceber] = useState(() => lerLocal(CHAVE_RECEBER) !== "nao");
  const [agora, setAgora] = useState(Date.now());
  const audio = useRef<Audio | null>(null);
  const reproducao = useRef<string | null>(null);
  const epocaAudio = useRef(0);
  const inicioAtiva = useRef<{ id: string; em: number } | null>(null);
  const ultimaConexao = useRef(0);

  const numero = p?.numeros.find((n) => n.id === numberId);
  useEffect(() => {
    if (p && !p.numeros.some((n) => n.id === numberId)) setNumberId(p.numeros.find((n) => n.telefone)?.id ?? p.numeros[0]?.id ?? "");
  }, [p, numberId]);

  const live = useQuery({
    queryKey: ["chamadas", personId, "linha", numberId],
    queryFn: () => acaoChamada({ data: { numberId, action: "status" } }),
    enabled: !!numberId && !!p?.configurado && !!numero?.telefone,
    // Em chamada, rápido; parado, o tempo real (SSE "chamada") avisa quando tocar.
    refetchInterval: (q) => (q.state.data?.call ? 2000 : 10_000),
    retry: false,
  });
  const estado = live.data;
  const chamada = estado?.call ?? null;
  const conectado = estado?.connection.state === "conectado";
  useEffect(() => aoMudarLinha?.(conectado), [conectado, aoMudarLinha]);

  const pararAudio = useCallback(() => {
    epocaAudio.current++;
    const a = audio.current;
    audio.current = null;
    if (a) {
      a.socket.onclose = null;
      a.socket.close();
      a.stream.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      a.saida?.parar();
      a.node.disconnect();
      void a.context.close().catch(() => {});
    }
    setAudioPronto(false);
    setMudo(false);
    reproducao.current = null;
  }, []);

  // Renovação da sessão de controle (independente das atualizações do áudio).
  useEffect(() => {
    if (!numberId || !p?.configurado || !numero?.telefone) return;
    const t = window.setInterval(() => {
      void acaoChamada({ data: { numberId, action: "status" } })
        .then((s) => qc.setQueryData(["chamadas", personId, "linha", numberId], s))
        .catch(() => {
          pararAudio();
          setErro("Não foi possível renovar sua sessão de chamadas.");
        });
    }, 5000);
    return () => window.clearInterval(t);
  }, [numberId, p?.configurado, numero?.telefone, personId, qc, pararAudio]);

  useEffect(() => () => pararAudio(), [numberId, pararAudio]);
  useEffect(() => {
    if (audio.current && reproducao.current !== (chamada?.id ?? null)) {
      audio.current.node.port.postMessage({ type: "reset" });
      reproducao.current = chamada?.id ?? null;
    }
  }, [chamada?.id]);

  /** Microfone + áudio da linha; idempotente. Chamar dentro do clique (o navegador exige o gesto). */
  const garantirAudio = useCallback(async (): Promise<boolean> => {
    if (audio.current) return true;
    const epoca = ++epocaAudio.current;
    const atual = () => {
      if (epocaAudio.current !== epoca) throw new Error("A ativação do microfone foi cancelada.");
    };
    let context: AudioContext | undefined, stream: MediaStream | undefined, socket: WebSocket | undefined;
    try {
      context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      if (context.sampleRate !== 16000) throw new Error("Use Chrome ou Edge para o áudio das chamadas.");
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
      atual();
      await context.audioWorklet.addModule("/audio/chamada-worklet.js");
      const node = new AudioWorkletNode(context, "omni-audio", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const r = await acaoChamada({ data: { numberId, action: "ticket" } });
      atual();
      socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/omni/audio?ticket=${encodeURIComponent(r.ticket ?? "")}`);
      const ws = socket;
      ws.binaryType = "arraybuffer";
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("Não foi possível ativar o áudio. Feche outras abas que estejam usando sua linha."));
      });
      atual();
      audio.current = { context, stream, node, socket: ws, saida: null };
      node.port.onmessage = ({ data }) => {
        if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1920 * 5) ws.send(data);
      };
      ws.onmessage = ({ data }) => {
        if (typeof data === "string") qc.setQueryData(["chamadas", personId, "linha", numberId], JSON.parse(data));
        else node.port.postMessage({ type: "audio", buffer: data }, [data]);
      };
      ws.onclose = () => {
        pararAudio();
      };
      context.createMediaStreamSource(stream).connect(node);
      // A voz da outra pessoa por WebRTC interno, para o cancelamento de eco do microfone funcionar.
      const saida = await saidaComEcoCancelado(context, node);
      if (audio.current?.socket !== ws) {
        saida?.parar();
        throw new Error("A ativação do microfone foi cancelada.");
      }
      audio.current.saida = saida;
      if (!saida) node.connect(context.destination);
      for (const track of stream.getTracks()) track.onended = () => pararAudio();
      setAudioPronto(true);
      return true;
    } catch (e) {
      socket?.close();
      stream?.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      void context?.close().catch(() => {});
      setErro(e instanceof Error ? e.message : "Não foi possível ativar o microfone.");
      return false;
    }
  }, [numberId, personId, qc, pararAudio]);

  const acao = useMutation({
    mutationFn: async (input: { action: "connect" | "disconnect" | "dial" | "answer" | "hangup" | "reject" | "record"; record?: boolean; peer?: string }) =>
      acaoChamada({
        data: { numberId, action: input.action, peer: input.action === "dial" ? input.peer : undefined, id: chamada?.id, record: input.record ?? false, notified: Boolean(input.record) },
      }),
    onMutate: () => setErro(""),
    onError: (e: Error) => setErro(e.message),
    onSuccess: (s: EstadoChamada) => qc.setQueryData(["chamadas", personId, "linha", numberId], s),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["chamadas", personId, "painel"] }),
  });

  /** Conecta a linha (se preciso) e espera ficar pronta, até ~10 s. */
  const garantirLinha = useCallback(async (): Promise<boolean> => {
    let s = qc.getQueryData<EstadoChamada>(["chamadas", personId, "linha", numberId]);
    if (s?.connection.state === "conectado") return true;
    if (s?.connection.state !== "conectando") s = await acaoChamada({ data: { numberId, action: "connect" } });
    for (let i = 0; i < 20 && s?.connection.state !== "conectado"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      s = await acaoChamada({ data: { numberId, action: "status" } });
    }
    qc.setQueryData(["chamadas", personId, "linha", numberId], s);
    if (s?.connection.state !== "conectado") setErro(s?.connection.message ?? "Não foi possível conectar seu WhatsApp.");
    return s?.connection.state === "conectado";
  }, [numberId, personId, qc]);

  /** Ligar com um clique: microfone (no gesto), linha e discagem. */
  const ligar = useCallback(
    async (destino: string, comGravacao: boolean) => {
      setEscolhendo(null);
      setErro("");
      if (!(await garantirAudio())) return;
      if (!(await garantirLinha())) return;
      acao.mutate({ action: "dial", peer: destino, record: comGravacao });
    },
    [garantirAudio, garantirLinha, acao],
  );

  /** Atender com um clique (ativa o microfone se ainda não estiver). */
  const atender = useCallback(
    async (comGravacao: boolean) => {
      if (!(await garantirAudio())) return;
      acao.mutate({ action: "answer", record: comGravacao });
    },
    [garantirAudio, acao],
  );

  // Pedido de ligação vindo de uma conversa.
  useEffect(() => {
    const aoPedir = (event: Event) => {
      const { numberId: alvo, peer: destino } = (event as CustomEvent<{ numberId: string; peer: string }>).detail;
      if (!p?.numeros.some((n) => n.id === alvo)) return;
      if (chamada) {
        setErro("Encerre a chamada atual antes de ligar de novo.");
        return;
      }
      setNumberId(alvo);
      setPeer(destino);
      if (p.podeGravar) setEscolhendo({ peer: destino });
      else void ligar(destino, false);
    };
    window.addEventListener("omni-ligar", aoPedir);
    return () => window.removeEventListener("omni-ligar", aoPedir);
  }, [p, chamada, ligar]);

  // Ao voltar para a aba, confere a linha na hora (o navegador atrasa consultas em abas escondidas).
  useEffect(() => {
    const aoVoltar = () => {
      if (!document.hidden) void qc.invalidateQueries({ queryKey: ["chamadas", personId, "linha"] });
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => document.removeEventListener("visibilitychange", aoVoltar);
  }, [qc, personId]);

  // "Receber ligações no Omni": conecta a linha ao abrir o app e reconecta se cair
  // (o servidor a mantém viva enquanto o Omni estiver aberto, mesmo em segundo plano).
  useEffect(() => {
    if (!receber || !p?.configurado || !numero?.telefone || !estado) return;
    if (estado.connection.state !== "desconectado" && estado.connection.state !== "erro") return;
    if (Date.now() - ultimaConexao.current < 30_000 || acao.isPending) return;
    ultimaConexao.current = Date.now();
    void acaoChamada({ data: { numberId, action: "connect" } })
      .then((s) => qc.setQueryData(["chamadas", personId, "linha", numberId], s))
      .catch(() => undefined);
  }, [receber, p?.configurado, numero?.telefone, estado, numberId, personId, qc, acao.isPending]);

  // Tempo da chamada e fim: guarda o início e solta o microfone quando acaba.
  useEffect(() => {
    if (chamada?.state === "ativa" && inicioAtiva.current?.id !== chamada.id) inicioAtiva.current = { id: chamada.id, em: Date.now() };
    if (!chamada && audio.current) {
      const t = window.setTimeout(() => {
        if (!qc.getQueryData<EstadoChamada>(["chamadas", personId, "linha", numberId])?.call) pararAudio();
      }, 1500);
      return () => window.clearTimeout(t);
    }
  }, [chamada, numberId, personId, qc, pararAudio]);
  useEffect(() => {
    if (chamada?.state !== "ativa") return;
    const t = window.setInterval(() => setAgora(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [chamada?.state]);

  // Chamada tocando: toque, título piscando e notificação do sistema (com o Omni em segundo plano).
  const tocando = chamada?.state === "recebendo";
  const nomeChamada = chamada ? nomeDoContato(p, numberId, chamada.peer) : "";
  useEffect(() => {
    if (!tocando) return;
    const titulo = document.title;
    let alterna = false;
    const pisca = window.setInterval(() => {
      document.title = (alterna = !alterna) ? `📞 ${nomeChamada} está ligando` : titulo;
    }, 1000);
    let toque: AudioContext | null = null;
    let repete: number | undefined;
    try {
      toque = new AudioContext();
      void toque.resume();
      const ctx = toque;
      const tocar = () => {
        for (const [ini, fim] of [[0, 0.4], [0.6, 1.0]] as const) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.frequency.value = 440;
          g.gain.value = 0.08;
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + ini);
          o.stop(ctx.currentTime + fim);
        }
      };
      tocar();
      repete = window.setInterval(tocar, 3000);
    } catch {
      // sem áudio para o toque: o cartão e a notificação continuam
    }
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      void navigator.serviceWorker?.ready.then((r) =>
        r.showNotification(`${nomeChamada} está ligando`, { body: "WhatsApp · toque para atender no Omni", tag: "omni-chamada", requireInteraction: true, data: { url: "/?chamadas=1" } }),
      );
    }
    return () => {
      window.clearInterval(pisca);
      if (repete !== undefined) window.clearInterval(repete);
      void toque?.close().catch(() => {});
      document.title = titulo;
      void navigator.serviceWorker?.ready.then((r) => r.getNotifications({ tag: "omni-chamada" }).then((ns) => ns.forEach((n) => n.close())));
    };
  }, [tocando, nomeChamada]);


  // Abrir a tela marca as perdidas como vistas.
  useEffect(() => {
    if (visivel) gravarLocal(CHAVE_VISTAS, String(Date.now()));
  }, [visivel, p?.chamadas.length]);

  const alternarReceber = (valor: boolean) => {
    setReceber(valor);
    gravarLocal(CHAVE_RECEBER, valor ? "sim" : "nao");
    window.dispatchEvent(new CustomEvent("omni-receber-ligacoes", { detail: valor }));
    if (!valor && !chamada && estado?.connection.state !== "desconectado") acao.mutate({ action: "disconnect" });
  };
  const segundos = chamada?.state === "ativa" && inicioAtiva.current?.id === chamada.id ? Math.floor((agora - inicioAtiva.current.em) / 1000) : null;
  const chatDaChamada = chamada ? p?.contatos[`${numberId}:${chamada.peer}`]?.chatId : undefined;

  // Gravação durante a ligação: pausar ou retomar (retomar confirma o aviso de novo).
  const gravandoAgora = Boolean(chamada && (chamada.recordingActive ?? chamada.recording));
  const emAndamento = Boolean(chamada && chamada.state !== "encerrada" && !tocando);
  const alternarGravacao = (ligarGravacao: boolean) => {
    setConfirmarGravar(false);
    acao.mutate({ action: "record", record: ligarGravacao });
  };
  const controleGravacao =
    p?.podeGravar && emAndamento ? (
      confirmarGravar ? (
        <span className="flex flex-wrap items-center gap-1.5 text-xs">
          Vai avisar os participantes?
          <button type="button" className={botao} disabled={acao.isPending} onClick={() => alternarGravacao(true)}>
            <span className="text-vermelho">●</span> Sim, gravar
          </button>
          <button type="button" className={botao} onClick={() => setConfirmarGravar(false)}>
            Cancelar
          </button>
        </span>
      ) : gravandoAgora ? (
        <button type="button" className={botao} disabled={acao.isPending} onClick={() => alternarGravacao(false)} aria-label="Pausar a gravação">
          <Pause size={16} /> <span className="hidden sm:inline">Pausar gravação</span>
        </button>
      ) : (
        <button type="button" className={botao} disabled={acao.isPending} onClick={() => setConfirmarGravar(true)} aria-label="Gravar a ligação">
          <span className="text-vermelho">●</span> <span className="hidden sm:inline">{chamada?.recording ? "Retomar gravação" : "Gravar"}</span>
        </button>
      )
    ) : null;

  // ---------------------------------------------------------------- partes que aparecem em qualquer tela
  const flutuantes = (
    <>
      {tocando && chamada && (
        <div role="alertdialog" aria-label={`${nomeChamada} está ligando`} className="fixed bottom-20 right-4 z-50 w-80 space-y-3 rounded-xl border border-linha bg-superficie p-4 shadow-2xl md:bottom-4">
          <p className="flex items-center gap-2 font-semibold">
            <PhoneIncoming size={18} className="animate-pulse text-floresta-texto" aria-hidden /> {nomeChamada}
          </p>
          <p className="text-sm text-muted">está ligando no seu WhatsApp</p>
          {p?.podeGravar && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={gravar && avisei}
                onChange={(e) => {
                  setGravar(e.target.checked);
                  setAvisei(e.target.checked);
                }}
              />
              Gravar (vou avisar os participantes)
            </label>
          )}
          <div className="flex gap-2">
            <button type="button" className={botaoVerde} disabled={acao.isPending} onClick={() => void atender(Boolean(p?.podeGravar && gravar && avisei))}>
              <Phone size={16} /> Atender
            </button>
            <button type="button" className={botaoVermelho} disabled={acao.isPending} onClick={() => acao.mutate({ action: "reject" })}>
              <PhoneOff size={16} /> Recusar
            </button>
          </div>
          {erro && <p className="text-xs text-vermelho">{erro}</p>}
        </div>
      )}
      {chamada && !tocando && !visivel && (
        <div role="status" className="fixed bottom-20 right-4 z-50 flex flex-wrap items-center gap-2 rounded-xl border border-linha bg-superficie p-3 shadow-2xl md:bottom-4">
          <PhoneCall size={18} className="text-floresta-texto" aria-hidden />
          <span className="text-sm">
            <b>{nomeChamada}</b> · {segundos !== null ? duracao(segundos) : ESTADO[chamada.state] ?? chamada.state}
            {gravandoAgora && <span className="ml-1 text-vermelho">● gravando</span>}
            {!gravandoAgora && chamada.recording && <span className="ml-1 text-muted">gravação pausada</span>}
          </span>
          {controleGravacao}
          {audioPronto && (
            <button
              type="button"
              className={botao}
              aria-label={mudo ? "Reativar microfone" : "Silenciar"}
              onClick={() => {
                const v = !mudo;
                audio.current?.node.port.postMessage({ type: "mute", value: v });
                setMudo(v);
              }}
            >
              {mudo ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
          {chatDaChamada && (
            <button type="button" className={botao} aria-label="Abrir conversa" onClick={() => abrirConversa(chatDaChamada)}>
              <MessageCircle size={16} />
            </button>
          )}
          <button type="button" className={botao} onClick={abrir}>
            Abrir
          </button>
          <button type="button" className={botaoVermelho} aria-label="Encerrar" onClick={() => acao.mutate({ action: "hangup" })}>
            <PhoneOff size={16} />
          </button>
        </div>
      )}
      {escolhendo && (
        <div role="dialog" aria-modal="true" aria-label="Ligar" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEscolhendo(null)}>
          <div className="w-full max-w-sm space-y-3 rounded-xl bg-superficie p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <p className="font-semibold">Ligar para {nomeDoContato(p, numberId, escolhendo.peer)}</p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={gravar && avisei}
                onChange={(e) => {
                  setGravar(e.target.checked);
                  setAvisei(e.target.checked);
                }}
              />
              Gravar (vou avisar os participantes de que a ligação será gravada)
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={botaoVerde} onClick={() => void ligar(escolhendo.peer, gravar && avisei)}>
                <Phone size={16} /> {gravar && avisei ? "Ligar e gravar" : "Ligar"}
              </button>
              <button type="button" className={botao} onClick={() => setEscolhendo(null)}>
                Cancelar
              </button>
            </div>
            <p className="text-xs text-muted">Dá para pausar ou retomar a gravação durante a ligação.</p>
          </div>
        </div>
      )}
      {erro && !visivel && !tocando && (
        <div role="alert" className="fixed bottom-36 right-4 z-50 max-w-80 rounded-md border border-vermelho/40 bg-superficie px-3 py-2 text-sm text-vermelho shadow-xl md:bottom-24">
          {erro}
          <button type="button" className="ml-2 underline" onClick={() => setErro("")}>
            Fechar
          </button>
        </div>
      )}
    </>
  );

  if (!visivel) return flutuantes;

  // ---------------------------------------------------------------- tela Chamadas
  return (
    <>
      {flutuantes}
      <section className="fixed inset-x-0 bottom-16 top-0 z-20 overflow-y-auto bg-fundo p-4 md:bottom-0 md:left-16 md:p-8" aria-label="Chamadas">
        <div className="mx-auto max-w-3xl space-y-5">
          <header className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">Chamadas</h1>
            <button type="button" className={botao} onClick={fechar} aria-label="Fechar chamadas">
              <X size={18} />
            </button>
          </header>
          {painel.isPending && <Carregando rotulo="Carregando chamadas" />}
          {painel.isError && <p role="alert">Não foi possível carregar suas chamadas.</p>}
          {erro && (
            <p role="alert" className="text-vermelho">
              {erro}
            </p>
          )}
          {p && (
            <>
              {!p.configurado && <p className="text-muted">As chamadas ainda não foram habilitadas neste ambiente.</p>}
              {!p.numeros.length && <p className="text-muted">Seu WhatsApp ainda não está vinculado ao Omni. Peça à administração para cadastrar seu número com você como responsável.</p>}
              {!!p.numeros.length && (
                <div className="space-y-3 rounded-xl border border-linha bg-superficie p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      {p.numeros.length > 1 ? (
                        <select className={campo} aria-label="Meu WhatsApp" value={numberId} disabled={audioPronto || !!chamada} onChange={(e) => setNumberId(e.target.value)}>
                          {p.numeros.map((n) => (
                            <option key={n.id} value={n.id}>
                              {n.rotulo} · {formatarTelefone(n.telefone) ?? "não pareado"}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="font-medium">
                          {numero?.rotulo} · {formatarTelefone(numero?.telefone) ?? "não pareado"}
                        </p>
                      )}
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                        <span className={`inline-block size-2 rounded-full ${conectado ? "bg-floresta" : "bg-muted"}`} aria-hidden />
                        {ESTADO[estado?.connection.state ?? "desconectado"]}
                        {estado?.connection.message && ` · ${estado.connection.message}`}
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={receber} disabled={!p.configurado} onChange={(e) => alternarReceber(e.target.checked)} />
                      Receber ligações no Omni
                    </label>
                  </div>
                  {estado?.mode === "simulado" && <p className="text-sm text-muted">Simulação: as ligações ficam neste computador e não chamam o WhatsApp.</p>}
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (p.podeGravar) setEscolhendo({ peer });
                      else void ligar(peer, false);
                    }}
                  >
                    <input
                      className={`${campo} flex-1`}
                      aria-label="Número para ligar"
                      placeholder="Nome do contato ou DDI + DDD + número"
                      list="omni-contatos-chamada"
                      value={peer}
                      onChange={(e) => {
                        const v = e.target.value;
                        const achado = Object.entries(p.contatos).find(([k, c]) => k.startsWith(`${numberId}:`) && c.nome === v);
                        setPeer(achado ? achado[0].split(":")[1]! : v.replace(/\D/g, ""));
                      }}
                      pattern="[1-9][0-9]{9,14}"
                      required
                    />
                    <datalist id="omni-contatos-chamada">
                      {Object.entries(p.contatos)
                        .filter(([k, c]) => k.startsWith(`${numberId}:`) && c.nome)
                        .map(([k, c]) => (
                          <option key={k} value={c.nome!} />
                        ))}
                    </datalist>
                    <button type="submit" className={botaoVerde} disabled={!p.configurado || !!chamada || acao.isPending}>
                      <Phone size={16} /> Ligar
                    </button>
                  </form>
                  {!!estado?.allowed.length && <p className="text-xs text-muted">Neste teste, os destinos permitidos são: {estado.allowed.join(", ")}.</p>}
                  {chamada && !tocando && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-linha pt-3" role="status">
                      <span>
                        <b>{nomeChamada}</b> · {segundos !== null ? duracao(segundos) : ESTADO[chamada.state] ?? chamada.state}
                        {gravandoAgora && <span className="ml-1 text-vermelho">● gravando</span>}
                        {!gravandoAgora && chamada.recording && <span className="ml-1 text-muted">gravação pausada</span>}
                      </span>
                      {controleGravacao}
                      {audioPronto && (
                        <button
                          type="button"
                          className={botao}
                          onClick={() => {
                            const v = !mudo;
                            audio.current?.node.port.postMessage({ type: "mute", value: v });
                            setMudo(v);
                          }}
                        >
                          {mudo ? <MicOff size={16} /> : <Mic size={16} />} {mudo ? "Reativar microfone" : "Silenciar"}
                        </button>
                      )}
                      <button type="button" className={botaoVermelho} onClick={() => acao.mutate({ action: "hangup" })}>
                        <PhoneOff size={16} /> Encerrar
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                <h2 className="font-semibold">Recentes</h2>
                {!p.chamadas.length && <p className="text-muted">Nenhuma chamada registrada.</p>}
                <ul className="divide-y divide-linha rounded-xl border border-linha bg-superficie">
                  {p.chamadas.map((c) => (
                    <ItemDeLigacao
                      key={c.id}
                      c={c}
                      pessoas={p.pessoas}
                      podeLigar={!chamada && p.configurado}
                      aoLigar={() => abrirChamada(c.numeroId, c.telefone)}
                      aoAbrirConversa={abrirConversa}
                    />
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
