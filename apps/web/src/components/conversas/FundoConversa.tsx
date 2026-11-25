import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Palette } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { CORES_DE_FUNDO, meusFundos, PADROES_DE_FUNDO, salvarFundo, type MeusFundos } from "../../lib/fundos-fns.ts";

/**
 * Plano de fundo das conversas (0061): cor da lista (com versão escura) ou uma cor
 * escolhida, com um padrão leve por cima. Geral para todas as conversas ou só desta;
 * o da conversa vale sobre o geral. Guardado por pessoa (vale em todos os aparelhos).
 */

const CHAVE = ["whatsapp", "fundos"] as const;

const NOME_DA_COR: Record<(typeof CORES_DE_FUNDO)[number], string> = {
  padrao: "Padrão",
  areia: "Areia",
  menta: "Menta",
  ceu: "Céu",
  lavanda: "Lavanda",
  rosa: "Rosa",
  pessego: "Pêssego",
  cinza: "Cinza",
  grafite: "Grafite",
};
const NOME_DO_PADRAO: Record<(typeof PADROES_DE_FUNDO)[number], string> = { nenhum: "Liso", pontos: "Pontos", grade: "Grade", listras: "Listras" };

const corCss = (cor: string) => (cor.startsWith("#") ? cor : cor === "padrao" ? undefined : `var(--fundo-${cor})`);

/** Estilo do fundo (`"<cor>|<padrão>"`); sem fundo, nada (fica o da tela). */
export function estiloDoFundo(fundo: string | null | undefined): CSSProperties {
  if (!fundo) return {};
  const [cor = "padrao", padrao = "nenhum"] = fundo.split("|");
  const estilo: CSSProperties = { backgroundColor: corCss(cor) };
  if (padrao === "pontos") Object.assign(estilo, { backgroundImage: "radial-gradient(var(--fundo-traco) 1.3px, transparent 1.5px)", backgroundSize: "16px 16px" });
  if (padrao === "grade")
    Object.assign(estilo, {
      backgroundImage: "linear-gradient(var(--fundo-traco) 1px, transparent 1px), linear-gradient(90deg, var(--fundo-traco) 1px, transparent 1px)",
      backgroundSize: "24px 24px",
    });
  if (padrao === "listras") Object.assign(estilo, { backgroundImage: "repeating-linear-gradient(45deg, var(--fundo-traco) 0 1px, transparent 1px 12px)" });
  return estilo;
}

export function useFundos() {
  return useQuery({ queryKey: CHAVE, queryFn: () => meusFundos(), staleTime: 5 * 60_000 });
}

/** Fundo que vale nesta conversa: o dela ou o geral. */
export function useFundoDaConversa(chatId: string) {
  const q = useFundos();
  return q.data?.conversas[chatId] ?? q.data?.geral ?? null;
}

/** Botão do cabeçalho da conversa que abre a escolha do plano de fundo. */
export function EscolherFundo({ chatId }: { chatId: string }) {
  const qc = useQueryClient();
  const q = useFundos();
  const [aberto, setAberto] = useState(false);
  const [alcance, setAlcance] = useState<"conversa" | "geral">("conversa");
  const caixa = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aberto) return;
    const fora = (e: PointerEvent) => !caixa.current?.contains(e.target as Node) && setAberto(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAberto(false);
    document.addEventListener("pointerdown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);
  const salvar = useMutation({
    mutationFn: (v: { chatId: string | null; fundo: string | null }) => salvarFundo({ data: v }),
    // Muda na hora; o servidor confirma (e, se falhar, volta ao que estava).
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: CHAVE });
      const antes = qc.getQueryData<MeusFundos>(CHAVE);
      const base = antes ?? { geral: null, conversas: {} };
      const conversas = { ...base.conversas };
      if (v.chatId) {
        if (v.fundo) conversas[v.chatId] = v.fundo;
        else delete conversas[v.chatId];
      }
      qc.setQueryData<MeusFundos>(CHAVE, { geral: v.chatId ? base.geral : v.fundo, conversas });
      return { antes };
    },
    onError: (_e, _v, ctx) => qc.setQueryData(CHAVE, ctx?.antes),
    onSettled: () => void qc.invalidateQueries({ queryKey: CHAVE }),
  });
  const proprio = q.data?.conversas[chatId] ?? null;
  const atual = alcance === "conversa" ? (proprio ?? q.data?.geral ?? null) : (q.data?.geral ?? null);
  const [cor, padrao] = (atual ?? "padrao|nenhum").split("|") as [string, string];
  const escolher = (novaCor: string, novoPadrao: string) => {
    const fundo = novaCor === "padrao" && novoPadrao === "nenhum" ? null : `${novaCor}|${novoPadrao}`;
    salvar.mutate({ chatId: alcance === "conversa" ? chatId : null, fundo });
  };
  return (
    <div ref={caixa} className="relative">
      <button
        type="button"
        onClick={() => setAberto((a) => !a)}
        aria-expanded={aberto}
        aria-label="Plano de fundo"
        title="Plano de fundo"
        className="flex size-9 items-center justify-center rounded-md border border-linha hover:bg-superficie-2"
      >
        <Palette size={18} aria-hidden />
      </button>
      {aberto && (
        <div role="dialog" aria-label="Plano de fundo" className="absolute right-0 top-11 z-30 w-72 rounded-lg border border-linha bg-superficie p-3 shadow-xl">
          <div role="radiogroup" aria-label="Onde vale" className="mb-3 grid grid-cols-2 rounded-md bg-superficie-2 p-0.5 text-sm">
            {(["conversa", "geral"] as const).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={alcance === a}
                onClick={() => setAlcance(a)}
                className={`rounded px-2 py-1 ${alcance === a ? "bg-superficie font-medium shadow-sm" : "text-muted"}`}
              >
                {a === "conversa" ? "Esta conversa" : "Todas as conversas"}
              </button>
            ))}
          </div>
          <p className="rotulo mb-1.5 text-muted">Cor</p>
          <div className="grid grid-cols-5 gap-2">
            {CORES_DE_FUNDO.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => escolher(c, padrao)}
                aria-label={NOME_DA_COR[c]}
                aria-pressed={cor === c}
                title={NOME_DA_COR[c]}
                className={`flex size-10 items-center justify-center rounded-full border ${cor === c ? "border-floresta ring-2 ring-floresta" : "border-linha"}`}
                style={{ background: corCss(c) ?? "var(--superficie-2)" }}
              >
                {cor === c && <Check size={16} aria-hidden className="text-ink" />}
              </button>
            ))}
            <label
              title="Outra cor"
              className={`relative flex size-10 cursor-pointer items-center justify-center overflow-hidden rounded-full border ${cor.startsWith("#") ? "border-floresta ring-2 ring-floresta" : "border-linha"}`}
              style={{ background: cor.startsWith("#") ? cor : "conic-gradient(#f87171, #fbbf24, #34d399, #60a5fa, #a78bfa, #f87171)" }}
            >
              <span className="sr-only">Outra cor</span>
              <input
                type="color"
                value={cor.startsWith("#") ? cor : "#dcefe3"}
                onChange={(e) => escolher(e.target.value.toLowerCase(), padrao)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </label>
          </div>
          <p className="rotulo mb-1.5 mt-3 text-muted">Padrão</p>
          <div className="grid grid-cols-4 gap-2">
            {PADROES_DE_FUNDO.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => escolher(cor, p)}
                aria-pressed={padrao === p}
                className={`flex flex-col items-center gap-1 rounded-md border p-1 text-xs ${padrao === p ? "border-floresta ring-1 ring-floresta" : "border-linha"}`}
              >
                <span className="h-8 w-full rounded" style={{ backgroundColor: "var(--superficie-2)", ...estiloDoFundo(`${cor}|${p}`) }} aria-hidden />
                {NOME_DO_PADRAO[p]}
              </button>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2 text-sm">
            {alcance === "conversa" && proprio && (
              <button type="button" onClick={() => salvar.mutate({ chatId, fundo: null })} className="rounded-md px-2 py-1 text-floresta-texto hover:bg-superficie-2">
                Usar o fundo geral
              </button>
            )}
            {alcance === "geral" && q.data?.geral && (
              <button type="button" onClick={() => salvar.mutate({ chatId: null, fundo: null })} className="rounded-md px-2 py-1 text-floresta-texto hover:bg-superficie-2">
                Voltar ao padrão
              </button>
            )}
          </div>
          {salvar.isError && <p className="mt-1 text-xs text-vermelho">Não foi possível salvar o fundo.</p>}
        </div>
      )}
    </div>
  );
}
