import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Rolagem de um chat como no WhatsApp:
 * - ao abrir, vai SEMPRE para o fim — a não ser que haja não lidas: aí para a primeira não
 *   lida, com o aviso "N mensagens não lidas";
 * - enquanto a pessoa está no fim, fica no fim mesmo quando a altura cresce depois (imagens,
 *   áudios, e-mails do contato que chegam depois);
 * - mensagem nova desce sozinha só se a pessoa estiver no fim (ou se for dela);
 * - com não lidas abaixo, a seta vira um contador ("12 não lidas") que diminui conforme a
 *   pessoa rola e lê; o clique leva à próxima não lida; sem não lidas, ao fim.
 *
 * Quem é não lida: o chamador diz (`naoLida` em cada item: o lido do WhatsApp fica no
 * servidor, o dos e-mails vem do Outlook). Sem essa informação (canais da missão), vale o
 * "visto até" guardado neste aparelho.
 */

export type ItemDoChat = { id: string; em: string; deMim: boolean; naoLida?: boolean };

const PERTO_DO_FIM = 120;
const chaveDoVisto = (chave: string) => `omni-visto:${chave}`;
/** Datas comparadas como instante (formatos ISO diferentes não podem virar "não lida" errada). */
const instante = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

function lerVisto(chave: string): number | null {
  try {
    const v = localStorage.getItem(chaveDoVisto(chave));
    return v ? instante(v) || null : null;
  } catch {
    return null;
  }
}
function gravarVisto(chave: string, em: string) {
  try {
    const atual = lerVisto(chave);
    if (!atual || instante(em) > atual) localStorage.setItem(chaveDoVisto(chave), new Date(instante(em)).toISOString());
  } catch {
    // sem armazenamento: só não lembra entre aberturas
  }
}

export function useRolagemDoChat(chave: string, itens: ItemDoChat[] | undefined, opcoes: { aoLerTudo?: () => void } = {}) {
  const caixa = useRef<HTMLDivElement>(null);
  const [noFim, setNoFim] = useState(true);
  /** Onde começam as não lidas ao abrir (o aviso fica até trocar de chat). */
  const [divisor, setDivisor] = useState<{ id: string; n: number } | null>(null);
  /** Não lidas ainda abaixo da tela (contador da seta). */
  const [restantes, setRestantes] = useState(0);
  const pendentes = useRef<string[]>([]);
  const posicionado = useRef<string | null>(null);
  // No fim na última medição: a altura que cresce depois (mídia, mensagem nova) mantém no fim.
  const fixadoNoFim = useRef(true);
  const ultima = useRef<string | null>(null);
  const itensRef = useRef(itens);
  itensRef.current = itens;
  const aoLerTudo = useRef(opcoes.aoLerTudo);
  aoLerTudo.current = opcoes.aoLerTudo;

  const elemento = useCallback((id: string) => caixa.current?.querySelector<HTMLElement>(`[data-msg="${CSS.escape(id)}"]`) ?? null, []);
  const abaixoDaTela = useCallback(
    (id: string) => {
      const el = elemento(id);
      const c = caixa.current;
      if (!el || !c) return false;
      return el.getBoundingClientRect().top > c.getBoundingClientRect().bottom - 24;
    },
    [elemento],
  );
  const irAoFim = useCallback((suave: boolean) => {
    const c = caixa.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: suave ? "smooth" : "auto" });
  }, []);

  const medir = useCallback(() => {
    const c = caixa.current;
    if (!c) return;
    const perto = c.scrollHeight - c.scrollTop - c.clientHeight < PERTO_DO_FIM;
    fixadoNoFim.current = perto;
    setNoFim(perto);
    // Não lidas que já apareceram na tela saem do contador (não voltam ao rolar para cima).
    pendentes.current = perto ? [] : pendentes.current.filter((id) => abaixoDaTela(id));
    setRestantes(pendentes.current.length);
    if (perto) {
      const ult = itensRef.current?.at(-1);
      if (ult) gravarVisto(chave, ult.em);
      aoLerTudo.current?.();
    }
  }, [abaixoDaTela, chave]);

  // Troca de chat: posiciona de novo.
  useEffect(() => {
    posicionado.current = null;
    ultima.current = null;
    pendentes.current = [];
    fixadoNoFim.current = true;
    setDivisor(null);
    setRestantes(0);
    setNoFim(true);
  }, [chave]);

  // Fica no fim enquanto a altura cresce (imagens, áudios, e-mails que chegam depois).
  useEffect(() => {
    const c = caixa.current;
    if (!c) return;
    const manter = () => {
      if (fixadoNoFim.current && posicionado.current === chave) c.scrollTop = c.scrollHeight;
    };
    const mo = new MutationObserver(manter);
    mo.observe(c, { childList: true, subtree: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(manter);
    ro?.observe(c);
    // load/loadedmetadata não sobem: escuta na captura.
    c.addEventListener("load", manter, true);
    c.addEventListener("loadedmetadata", manter, true);
    return () => {
      mo.disconnect();
      ro?.disconnect();
      c.removeEventListener("load", manter, true);
      c.removeEventListener("loadedmetadata", manter, true);
    };
  }, [chave]);

  const ultimoId = itens?.at(-1)?.id;
  useLayoutEffect(() => {
    const lista = itensRef.current;
    if (!lista?.length) return;
    const ult = lista.at(-1)!;
    if (posicionado.current !== chave) {
      posicionado.current = chave;
      ultima.current = ult.id;
      // Quem é não lida: o que o chamador disse; sem isso, o "visto até" deste aparelho.
      const informado = lista.some((x) => x.naoLida !== undefined);
      const visto = informado ? null : lerVisto(chave);
      const naoLida = (x: ItemDoChat) => (informado ? Boolean(x.naoLida) : visto !== null && !x.deMim && instante(x.em) > visto);
      const i = lista.findIndex(naoLida);
      if (i >= 0) {
        const ids = lista.slice(i).filter(naoLida).map((x) => x.id);
        setDivisor({ id: lista[i]!.id, n: ids.length });
        fixadoNoFim.current = false;
        requestAnimationFrame(() => {
          const el = elemento(lista[i]!.id);
          if (el) el.scrollIntoView({ block: "start" });
          else irAoFim(false);
          pendentes.current = ids.filter((id) => abaixoDaTela(id));
          medir();
        });
      } else {
        fixadoNoFim.current = true;
        irAoFim(false);
        requestAnimationFrame(() => irAoFim(false));
        if (!informado) gravarVisto(chave, ult.em);
      }
      return;
    }
    if (ultima.current === ult.id) return;
    // Chegou mensagem nova no fim (carregar as anteriores não muda a última).
    const anterior = ultima.current;
    ultima.current = ult.id;
    if (ult.deMim || fixadoNoFim.current) {
      fixadoNoFim.current = true;
      requestAnimationFrame(() => irAoFim(true));
      gravarVisto(chave, ult.em);
      return;
    }
    const desde = anterior ? lista.findIndex((x) => x.id === anterior) + 1 : lista.length - 1;
    const chegaram = lista.slice(Math.max(desde, 0)).filter((x) => !x.deMim).map((x) => x.id);
    if (!chegaram.length) return;
    pendentes.current = [...pendentes.current, ...chegaram];
    setRestantes(pendentes.current.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, ultimoId, itens?.length]);

  const descer = () => {
    // A próxima não lida abaixo da tela; sem nenhuma, o fim.
    const alvo = pendentes.current.find((id) => abaixoDaTela(id));
    const el = alvo ? elemento(alvo) : null;
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    else irAoFim(true);
  };

  return { caixa, aoRolar: medir, divisor, noFim, naoLidasAbaixo: restantes, descer };
}

/** Aviso "N mensagens não lidas" antes da primeira não lida. */
export function AvisoNaoLidas({ n }: { n: number }) {
  return (
    <p className="my-3 text-center" role="separator">
      <span className="rounded-full bg-azul/15 px-3 py-1 text-xs font-medium text-azul shadow-sm">
        {n} {n === 1 ? "mensagem não lida" : "mensagens não lidas"}
      </span>
    </p>
  );
}

/** A seta do canto: com não lidas abaixo, o contador ("12 não lidas"), que leva à próxima; senão, ao fim. */
export function SetaParaBaixo({ visivel, naoLidas, onClick }: { visivel: boolean; naoLidas: number; onClick: () => void }) {
  if (!visivel) return null;
  if (naoLidas > 0) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`Faltam ${naoLidas} ${naoLidas === 1 ? "mensagem não lida" : "mensagens não lidas"}: ir para a próxima`}
        title="Ir para a próxima não lida"
        className="absolute bottom-3 right-4 z-10 flex items-center gap-1 rounded-full bg-floresta py-1.5 pl-3 pr-2 text-xs font-semibold text-white shadow-lg hover:opacity-90"
      >
        <span aria-live="polite">
          {naoLidas > 99 ? "99+" : naoLidas} {naoLidas === 1 ? "não lida" : "não lidas"}
        </span>
        <ChevronDown size={18} aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Ir para o fim da conversa"
      title="Ir para o fim"
      className="absolute bottom-3 right-4 z-10 flex size-10 items-center justify-center rounded-full border border-linha bg-superficie text-muted shadow-lg hover:text-ink"
    >
      <ChevronDown size={22} aria-hidden />
    </button>
  );
}
