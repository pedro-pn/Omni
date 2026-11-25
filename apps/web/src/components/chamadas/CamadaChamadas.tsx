import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { getMe } from "../../lib/session-fns.ts";
import { Chamadas } from "./Chamadas.tsx";

/**
 * Chamadas no nível do app: uma instância só, montada na raiz, para a ligação tocar
 * (e a chamada em andamento não cair) em qualquer tela — Início, Administração, Conta…
 * A tela principal só registra como abrir o painel e as conversas.
 */
type Controles = { abrir: () => void; fechar: () => void; abrirConversa: (chatId: string) => void };

type Camada = {
  linhaPronta: boolean;
  /** A tela principal informa se o painel Chamadas está aberto. */
  definirVisivel: (visivel: boolean) => void;
  registrar: (controles: Controles | null) => void;
};

const Contexto = createContext<Camada>({ linhaPronta: false, definirVisivel: () => undefined, registrar: () => undefined });

export const useCamadaChamadas = () => useContext(Contexto);

/** Tempo real (SSE em /api/eventos): mensagens, WhatsApp, chamadas e avisos da pessoa. */
function useEventosAoVivo(ativo: boolean) {
  const queryClient = useQueryClient();
  // "Receber ligações no Omni" (tela Chamadas): o servidor mantém a linha enquanto os eventos estiverem abertos.
  const [receber, setReceber] = useState(() => {
    try {
      return localStorage.getItem("omni-receber-ligacoes") !== "nao";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const aoMudar = (e: Event) => setReceber(Boolean((e as CustomEvent<boolean>).detail));
    window.addEventListener("omni-receber-ligacoes", aoMudar);
    return () => window.removeEventListener("omni-receber-ligacoes", aoMudar);
  }, []);
  useEffect(() => {
    if (!ativo || typeof EventSource === "undefined") return;
    const fonte = new EventSource(receber ? "/api/eventos?receber=1" : "/api/eventos");
    fonte.addEventListener("mensagem", (e) => {
      try {
        const { missionId, channel } = JSON.parse((e as MessageEvent<string>).data) as { missionId: string; channel: string };
        void queryClient.invalidateQueries({ queryKey: ["mensagens", missionId, channel] });
        void queryClient.invalidateQueries({ queryKey: ["canais", missionId] });
        void queryClient.invalidateQueries({ queryKey: ["nao-lidas"] });
      } catch {
        // evento malformado: ignora
      }
    });
    fonte.addEventListener("whatsapp", (e) => {
      try {
        const { chatId } = JSON.parse((e as MessageEvent<string>).data) as { chatId: string };
        void queryClient.invalidateQueries({ queryKey: ["whatsapp", "conversas"] });
        void queryClient.invalidateQueries({ queryKey: ["whatsapp", "missao"] });
        void queryClient.invalidateQueries({ queryKey: ["whatsapp", "mensagens", chatId] });
      } catch {
        // evento malformado: ignora
      }
    });
    // Chamada tocando, atendida ou encerrada na linha da pessoa: atualiza na hora.
    fonte.addEventListener("chamada", () => {
      void queryClient.invalidateQueries({ queryKey: ["chamadas"] });
    });
    // E-mail novo na própria caixa (0067): a lista e a caixa única se atualizam.
    fonte.addEventListener("email", () => {
      void queryClient.invalidateQueries({ queryKey: ["caixa"] });
      void queryClient.invalidateQueries({ queryKey: ["unica"] });
    });
    fonte.addEventListener("aviso", () => {
      void queryClient.invalidateQueries({ queryKey: ["avisos"] });
      void queryClient.invalidateQueries({ queryKey: ["tarefas"] });
    });
    return () => fonte.close();
  }, [ativo, queryClient, receber]);
}

export function CamadaChamadas({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Quem está logado (na tela de entrada, null: nada de eventos nem chamadas).
  const me = useQuery({ queryKey: ["sessao", "me"], queryFn: () => getMe(), staleTime: 60_000 });
  // Janela avulsa de e-mail (/emails/janela): sem ligações nem tempo real (a janela principal cuida disso).
  const janelaAvulsa = useRouterState({ select: (s) => s.location.pathname.startsWith("/emails/janela") });
  const pessoa = me.data && me.data.profiles.length > 0 && !janelaAvulsa ? me.data : null;
  useEventosAoVivo(pessoa !== null);

  const [visivel, setVisivel] = useState(false);
  const [linhaPronta, setLinhaPronta] = useState(false);
  const controles = useRef<Controles | null>(null);
  const registrar = useCallback((c: Controles | null) => {
    controles.current = c;
    if (!c) setVisivel(false);
  }, []);
  const camada = useMemo<Camada>(() => ({ linhaPronta, definirVisivel: setVisivel, registrar }), [linhaPronta, registrar]);

  // Fora da tela principal, abrir o painel ou uma conversa leva para ela (o link já é tratado lá).
  const irPara = (href: string) => void router.navigate({ href });

  return (
    <Contexto.Provider value={camada}>
      {children}
      {pessoa && (
        <Chamadas
          key={pessoa.id}
          personId={pessoa.id}
          visivel={visivel}
          abrir={() => (controles.current ? controles.current.abrir() : irPara("/?chamadas=1"))}
          fechar={() => (controles.current ? controles.current.fechar() : setVisivel(false))}
          abrirConversa={(chatId) => (controles.current ? controles.current.abrirConversa(chatId) : irPara(`/?conversa=${chatId}`))}
          aoMudarLinha={setLinhaPronta}
        />
      )}
    </Contexto.Provider>
  );
}
