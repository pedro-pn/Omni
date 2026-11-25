import { addDays } from "@omni/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { Tarefa } from "../../lib/tarefas-fns.ts";

/**
 * Semana e mês das Tarefas — porta de `WeekBoard` e `MonthBoard` do Foco
 * (`../foco/foco/src/features/foco/task-app.tsx`): semana de segunda a domingo,
 * mês em 6 linhas, até 4 tarefas por dia no mês (+N), cor do projeto e hora.
 */

export type LayoutTarefas = "lista" | "quadro" | "semana" | "mes";

const COR_PRIORIDADE: Record<1 | 2 | 3 | 4, string> = { 1: "#d1453b", 2: "#eb8909", 3: "#246fe0", 4: "var(--color-linha)" };
const DIAS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

const diaDaSemana = (iso: string) => (new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = segunda
const inicioDaSemana = (iso: string) => addDays(iso, -diaDaSemana(iso));
const diaDoMes = (iso: string) => Number(iso.slice(8, 10));
const nomeDoMes = (mes: string) =>
  new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${mes}-01T12:00:00Z`));
const curta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

function Navegacao({ titulo, resumo, hoje, aoHoje, aoMudar }: { titulo: string; resumo: string; hoje: string; aoHoje: () => void; aoMudar: (passo: number) => void }) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-linha px-4 py-2">
      <div className="min-w-0 flex-1">
        <strong className="block first-letter:uppercase">{titulo}</strong>
        <span className="text-xs text-muted">{resumo}</span>
      </div>
      <nav className="flex items-center gap-1" aria-label="Navegar no calendário">
        <button type="button" onClick={aoHoje} className="rounded-md border border-linha px-2.5 py-1 text-sm hover:bg-superficie-2" title={`Hoje é ${curta(hoje)}`}>
          {hoje ? "Hoje" : ""}
        </button>
        <button type="button" onClick={() => aoMudar(-1)} aria-label="Anterior" className="rounded-md p-1.5 hover:bg-superficie-2">
          <ChevronLeft size={18} />
        </button>
        <button type="button" onClick={() => aoMudar(1)} aria-label="Próximo" className="rounded-md p-1.5 hover:bg-superficie-2">
          <ChevronRight size={18} />
        </button>
      </nav>
    </header>
  );
}

function Cartao({ t, compacto, onAbrir }: { t: Tarefa; compacto?: boolean; onAbrir: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onAbrir(t.id)}
      title={t.titulo}
      className={`flex w-full ${compacto ? "items-center" : "items-start"} gap-1.5 rounded-sm border-l-2 bg-superficie px-1.5 text-left hover:bg-superficie-2 ${compacto ? "py-0.5 text-xs" : "py-1 text-sm"}`}
      style={{ borderLeftColor: COR_PRIORIDADE[t.prioridade] }}
    >
      {t.projeto && <i className="size-2 shrink-0 rounded-full" style={{ background: t.projeto.cor }} aria-hidden />}
      {t.hora && <small className="shrink-0 text-muted">{t.hora}</small>}
      <span className={`min-w-0 ${compacto ? "truncate" : "line-clamp-3 break-words"}`}>{t.titulo}</span>
    </button>
  );
}

export function SemanaTarefas({ tarefas, hoje, onAbrir }: { tarefas: Tarefa[]; hoje: string; onAbrir: (id: string) => void }) {
  const [inicio, setInicio] = useState(() => inicioDaSemana(hoje));
  const dias = Array.from({ length: 7 }, (_, i) => addDays(inicio, i));
  const nestaSemana = tarefas.filter((t) => dias.includes(t.data)).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Navegacao
        titulo={`${curta(dias[0]!)} a ${curta(dias[6]!)}`}
        resumo={`${nestaSemana} tarefa${nestaSemana === 1 ? "" : "s"} nesta semana`}
        hoje={hoje}
        aoHoje={() => setInicio(inicioDaSemana(hoje))}
        aoMudar={(p) => setInicio(addDays(inicio, 7 * p))}
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-linha sm:grid-cols-7">
        {dias.map((dia, i) => {
          const doDia = tarefas.filter((t) => t.data === dia);
          return (
            <section key={dia} aria-label={`${DIAS[i]} ${curta(dia)}`} className={`flex min-h-24 flex-col gap-1 p-1.5 ${dia === hoje ? "bg-floresta-clara" : "bg-fundo"}`}>
              <header className="flex items-baseline gap-1.5 px-0.5 text-xs text-muted">
                <span>{DIAS[i]}</span>
                <strong className={`text-base ${dia === hoje ? "text-floresta-texto" : "text-ink"}`}>{diaDoMes(dia)}</strong>
                {dia === hoje && <span className="text-floresta-texto">Hoje</span>}
              </header>
              {doDia.map((t) => (
                <Cartao key={t.id} t={t} onAbrir={onAbrir} />
              ))}
              {!doDia.length && <span className="px-0.5 text-xs text-muted">Livre</span>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function MesTarefas({ tarefas, hoje, onAbrir }: { tarefas: Tarefa[]; hoje: string; onAbrir: (id: string) => void }) {
  const [mes, setMes] = useState(hoje.slice(0, 7));
  const primeiro = `${mes}-01`;
  const inicio = inicioDaSemana(primeiro);
  const dias = Array.from({ length: 42 }, (_, i) => addDays(inicio, i));
  const mudar = (passo: number) => {
    const [a, m] = mes.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(a, m - 1 + passo, 1));
    setMes(d.toISOString().slice(0, 7));
  };
  const noMes = tarefas.filter((t) => t.data.startsWith(mes)).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Navegacao titulo={nomeDoMes(mes)} resumo={`${noMes} tarefa${noMes === 1 ? "" : "s"} no mês`} hoje={hoje} aoHoje={() => setMes(hoje.slice(0, 7))} aoMudar={mudar} />
      <div className="grid grid-cols-7 border-b border-linha text-center text-xs text-muted">
        {DIAS.map((d) => (
          <span key={d} className="py-1">
            {d}
          </span>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px overflow-y-auto bg-linha">
        {dias.map((dia) => {
          const doDia = tarefas.filter((t) => t.data === dia);
          const fora = !dia.startsWith(mes);
          return (
            <section key={dia} aria-label={curta(dia)} className={`flex min-h-20 min-w-0 flex-col gap-0.5 p-1 ${dia === hoje ? "bg-floresta-clara" : "bg-fundo"} ${fora ? "opacity-50" : ""}`}>
              <header className={`px-0.5 text-xs ${dia === hoje ? "font-semibold text-floresta-texto" : "text-muted"}`}>{diaDoMes(dia)}</header>
              {doDia.slice(0, 4).map((t) => (
                <Cartao key={t.id} t={t} compacto onAbrir={onAbrir} />
              ))}
              {doDia.length > 4 && <span className="px-0.5 text-[11px] text-muted">+{doDia.length - 4} tarefas</span>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
