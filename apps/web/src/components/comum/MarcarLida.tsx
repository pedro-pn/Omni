import { Mail, MailOpen, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as EventoPonteiro, type MouseEvent, type ReactNode } from "react";

/**
 * Marcar como lida / não lida nas listas (conversas, e-mails, caixa única):
 * - clique no botão que aparece ao passar o mouse (no celular ele fica sempre visível);
 * - botão direito do mouse: menu com as ações do item;
 * - deslizar para a DIREITA no celular/tablet (para a esquerda continua o "Concluir" das conversas).
 */

export type AcaoDeslize = { rotulo: string; icone: LucideIcon; acao: () => void };

/** Deslizar o item no toque: para a direita e/ou para a esquerda, com o rótulo da ação por baixo. */
export function useDeslizarLados({ direita, esquerda }: { direita?: AcaoDeslize; esquerda?: AcaoDeslize }) {
  const inicio = useRef<{ x: number; y: number } | null>(null);
  const moveu = useRef(false);
  const [dx, setDx] = useState(0);
  const fundo =
    dx > 0 && direita ? (
      <span className="absolute inset-0 flex items-center gap-2 bg-azul px-5 text-sm font-medium text-white" aria-hidden>
        <direita.icone size={18} /> {direita.rotulo}
      </span>
    ) : dx < 0 && esquerda ? (
      <span className="absolute inset-0 flex items-center justify-end gap-2 bg-floresta px-5 text-sm font-medium text-white" aria-hidden>
        <esquerda.icone size={18} /> {esquerda.rotulo}
      </span>
    ) : null;
  return {
    dx,
    moveu,
    fundo,
    handlers: {
      onPointerDown: (e: EventoPonteiro) => {
        if (e.pointerType !== "touch") return;
        inicio.current = { x: e.clientX, y: e.clientY };
        moveu.current = false;
      },
      onPointerMove: (e: EventoPonteiro) => {
        const i = inicio.current;
        if (!i) return;
        const x = e.clientX - i.x;
        if (!moveu.current && Math.abs(e.clientY - i.y) > Math.abs(x)) {
          inicio.current = null; // rolagem vertical
          return;
        }
        if (Math.abs(x) > 8) moveu.current = true;
        setDx(Math.max(esquerda ? -160 : 0, Math.min(direita ? 160 : 0, x)));
      },
      onPointerUp: () => {
        if (inicio.current) {
          if (dx > 90) direita?.acao();
          else if (dx < -90) esquerda?.acao();
        }
        inicio.current = null;
        setDx(0);
      },
      onPointerCancel: () => {
        inicio.current = null;
        setDx(0);
      },
    },
  };
}

export type ItemDeMenu = { rotulo: string; icone?: LucideIcon; acao: () => void };

/** Menu do botão direito: abre onde o mouse está; fecha com Esc, clique fora ou rolagem. */
export function useMenuDeContexto(itens: ItemDeMenu[]) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!pos) return;
    const fechar = () => setPos(null);
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
  const abrir = (e: MouseEvent) => {
    e.preventDefault();
    setPos({ x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 44 * itens.length - 16) });
  };
  const menu: ReactNode = pos ? (
    <div role="menu" className="fixed z-50 w-56 rounded-md border border-linha bg-superficie py-1 text-sm shadow-xl" style={{ left: pos.x, top: pos.y }}>
      {itens.map((i) => (
        <button
          key={i.rotulo}
          type="button"
          role="menuitem"
          onClick={() => {
            setPos(null);
            i.acao();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-superficie-2"
        >
          {i.icone && <i.icone size={16} aria-hidden className="text-muted" />} {i.rotulo}
        </button>
      ))}
    </div>
  ) : null;
  return { abrir, menu };
}

/** Rótulos e ícone de "marcar como lida/não lida" conforme o estado atual. */
export function acaoLida(lida: boolean, alternar: () => void): AcaoDeslize {
  return lida ? { rotulo: "Marcar como não lida", icone: Mail, acao: alternar } : { rotulo: "Marcar como lida", icone: MailOpen, acao: alternar };
}

/** Botão de marcar como lida/não lida que aparece ao passar o mouse sobre o item (o item precisa de `group`). */
export function BotaoLida({ lida, alternar, className = "" }: { lida: boolean; alternar: () => void; className?: string }) {
  const a = acaoLida(lida, alternar);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        a.acao();
      }}
      aria-label={a.rotulo}
      title={a.rotulo}
      className={`hidden size-7 items-center justify-center rounded-full bg-superficie text-muted shadow-sm ring-1 ring-linha hover:text-ink md:flex md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 ${className}`}
    >
      <a.icone size={15} aria-hidden />
    </button>
  );
}
