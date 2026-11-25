import { AlertTriangle, CircleAlert, ListFilter, Star } from "lucide-react";
import type { ReactNode } from "react";

import type { LinhaRevisao, Revisao } from "../../lib/revisao-fns.ts";

/**
 * Revisão semanal (Fase 9): o que olhar toda semana em cada missão — avanço e
 * meta, custo × avanço, equipe e horas, RDOs, Qualidade, medição/NF e Omie —
 * com os alertas.
 * Só gerentes e diretoria (o servidor recusa os demais).
 */

export type FiltroRevisao = "todas" | "graves" | "minhas";

const dia = (iso: string | null) => (iso ? iso.split("-").reverse().slice(0, 2).join("/") : "—");
const reais = (v: number | null) => (v === null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }));
const horas = (min: number) => `${Math.round(min / 60).toLocaleString("pt-BR")}h`;
const pp = (n: number) => (Math.round(n * 10) / 10).toLocaleString("pt-BR");
const MEDICAO: Record<NonNullable<LinhaRevisao["medicao"]>["situacao"], string> = {
  SEM_MEDICAO: "Sem medição",
  PREPARADA: "Preparada",
  ENVIADA: "Enviada",
  APROVADA: "Aprovada",
};

export function filtrar(linhas: LinhaRevisao[], filtro: FiltroRevisao) {
  if (filtro === "graves") return linhas.filter((l) => l.alertas.some((a) => a.gravidade === "alta"));
  if (filtro === "minhas") return linhas.filter((l) => l.minha);
  return linhas;
}

export function RevisaoNav({ dados, filtro, onFiltro }: { dados: Revisao; filtro: FiltroRevisao; onFiltro: (f: FiltroRevisao) => void }) {
  const item = (f: FiltroRevisao, rotulo: string, icone: ReactNode) => {
    const ativo = filtro === f;
    return (
      <li>
        <button
          type="button"
          onClick={() => onFiltro(f)}
          aria-current={ativo ? "true" : undefined}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-superficie-2 ${ativo ? "bg-floresta-clara" : ""}`}
        >
          {icone}
          <span className="flex-1">{rotulo}</span>
          <span className="text-sm text-muted">{filtrar(dados.linhas, f).length}</span>
        </button>
      </li>
    );
  };
  const graves = filtrar(dados.linhas, "graves").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-4 pb-2 text-sm text-muted">
        Semana de {dia(dados.semana.inicio)} a {dia(dados.semana.fim)}
      </p>
      <ul>
        {item("todas", "Todas as missões ativas", <ListFilter size={18} className="text-floresta-texto" aria-hidden />)}
        {item("graves", "Com alerta grave", <AlertTriangle size={18} className={graves ? "text-vermelho" : "text-floresta-texto"} aria-hidden />)}
        {item("minhas", "Minhas missões", <Star size={18} className="text-floresta-texto" aria-hidden />)}
      </ul>
    </div>
  );
}

function Alertas({ l }: { l: LinhaRevisao }) {
  if (!l.alertas.length) return <span className="text-xs text-muted">Em dia</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {l.alertas.map((a) => (
        <li
          key={a.codigo}
          className={`rounded-md px-1.5 py-0.5 text-xs leading-tight ${a.gravidade === "alta" ? "bg-vermelho text-white" : "bg-superficie-2 text-ink"}`}
        >
          {a.texto}
        </li>
      ))}
    </ul>
  );
}

function Avanco({ l }: { l: LinhaRevisao }) {
  if (l.avanco === null) return <span className="text-muted">—</span>;
  return (
    <span>
      {Math.round(l.avanco)}%
      {l.avancoSemana !== null && (
        <span className={`ml-1 text-xs ${l.avancoSemana > 0 ? "text-floresta-texto" : "text-muted"}`}>
          {l.avancoSemana > 0 ? "+" : ""}
          {pp(l.avancoSemana)} na semana
        </span>
      )}
    </span>
  );
}

/** Meta valendo hoje, como cadastrada no filtroAPP, e a revisão semanal de lá (só quando há). */
function MetaSemana({ l }: { l: LinhaRevisao }) {
  const meta = l.semana?.meta;
  const revisao = l.semana?.revisao === "feita" ? "revisão feita" : l.semana?.revisao === "pendente" ? "revisão pendente" : null;
  if (!meta && !revisao) return null;
  return (
    <p className="text-xs text-muted" title={meta ? `${meta.rotulo}${meta.periodo ? ` · período ${meta.periodo}` : ""}` : undefined}>
      {meta && (
        <>
          meta: <span className={meta.situacao === "BELOW" || meta.situacao === "PARTIAL" ? "text-vermelho" : "text-ink"}>{meta.texto}</span>
        </>
      )}
      {meta && revisao ? " · " : ""}
      {revisao}
    </p>
  );
}

function Custo({ l }: { l: LinhaRevisao }) {
  const c = l.custo;
  if (!c) return <span className="text-muted">—</span>;
  if (c.consumo === null) {
    return (
      <span>
        {reais(c.realizado)}
        <span className="block text-xs text-muted">sem orçamento</span>
      </span>
    );
  }
  const frente = c.avancoFisico !== null ? c.consumo - c.avancoFisico : null;
  return (
    <span title={`Gasto ${reais(c.realizado)} de ${reais(c.previsto)} previstos (até ${dia(c.ate)})`}>
      <span className={frente !== null && frente > 15 ? "font-medium text-vermelho" : ""}>{c.consumo}% do custo</span>
      <span className="block text-xs text-muted">
        {c.avancoFisico !== null ? `avanço ${Math.round(c.avancoFisico)}% · ` : ""}
        {reais(c.realizado)}
      </span>
    </span>
  );
}

function Equipe({ l }: { l: LinhaRevisao }) {
  const { alocados, ponto } = l.equipe;
  if (!alocados && !ponto) return <span className="text-muted">—</span>;
  return (
    <span>
      {alocados ? `${alocados} alocado(s)` : "—"}
      {ponto && (
        <span className="block text-xs text-muted">
          {horas(ponto.extrasMin)} extras {ponto.semanaPassada ? "sem. passada" : "nesta semana"}
        </span>
      )}
    </span>
  );
}

export function RevisaoPainel({
  dados,
  filtro,
  onFiltro,
  onAbrirMissao,
}: {
  dados: Revisao;
  filtro: FiltroRevisao;
  onFiltro: (f: FiltroRevisao) => void;
  onAbrirMissao: (id: string) => void;
}) {
  const linhas = filtrar(dados.linhas, filtro);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-linha bg-superficie px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">Revisão semanal</h2>
          <p className="text-sm text-muted">
            {linhas.length} {linhas.length === 1 ? "missão" : "missões"} · semana de {dia(dados.semana.inicio)} a {dia(dados.semana.fim)}
          </p>
        </div>
        <details className="w-full text-sm lg:order-last">
          <summary className="cursor-pointer text-floresta-texto">Como ler</summary>
          <ComoLer />
        </details>
        {/* No celular a coluna dos filtros fica escondida */}
        <label className="md:hidden">
          <span className="sr-only">Filtro</span>
          <select value={filtro} onChange={(e) => onFiltro(e.target.value as FiltroRevisao)} className="rounded-md border border-linha bg-superficie px-2 py-1.5 text-sm">
            <option value="todas">Todas ({filtrar(dados.linhas, "todas").length})</option>
            <option value="graves">Com alerta grave ({filtrar(dados.linhas, "graves").length})</option>
            <option value="minhas">Minhas ({filtrar(dados.linhas, "minhas").length})</option>
          </select>
        </label>
      </header>
      {linhas.length === 0 ? (
        <p className="px-6 py-10 text-center text-muted">Nenhuma missão neste filtro.</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {/* Telas largas: tabela */}
          <table className="hidden w-full text-left text-sm lg:table">
            <thead className="sticky top-0 bg-superficie text-xs text-muted">
              <tr>
                <th className="w-[30%] min-w-60 px-4 py-2 font-medium">Missão e alertas</th>
                <th className="px-3 py-2 font-medium">Avanço</th>
                <th className="px-3 py-2 font-medium">Custo</th>
                <th className="px-3 py-2 font-medium">Equipe</th>
                <th className="px-3 py-2 font-medium">Campo</th>
                <th className="px-3 py-2 font-medium">Faturamento</th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.id} onClick={() => onAbrirMissao(l.id)} className="cursor-pointer border-t border-linha align-top hover:bg-superficie-2">
                  <td className="px-4 py-2.5">
                    <button type="button" onClick={() => onAbrirMissao(l.id)} className="text-left font-medium hover:underline">
                      {l.titulo}
                    </button>
                    <p className="text-xs text-muted">{l.etapa}</p>
                    <div className="mt-1.5">
                      <Alertas l={l} />
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <Avanco l={l} />
                    <MetaSemana l={l} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Custo l={l} />
                  </td>
                  <td className="px-3 py-2.5">
                    <Equipe l={l} />
                  </td>
                  <td className="px-3 py-2.5">
                    {l.rdos.semana} RDO(s) na semana
                    <p className="text-xs text-muted">
                      último {dia(l.rdos.ultimo)}
                      {l.rdos.devolvidos ? ` · ${l.rdos.devolvidos} devolvido(s)` : ""}
                    </p>
                    <p className="text-xs text-muted">{l.qualidade.abertos ? `${l.qualidade.abertos} aberto(s) na Qualidade` : "Qualidade em dia"}</p>
                  </td>
                  <td className="px-3 py-2.5">
                    {l.medicao ? MEDICAO[l.medicao.situacao] : "—"}
                    <span className="text-muted"> · {l.notas.total} NF</span>
                    {l.notas.emAberto ? <p className="text-xs text-muted">{l.notas.emAberto} NF a receber</p> : null}
                    {l.pendencias ? (
                      <p className="text-xs text-muted">
                        Omie: {l.pendencias.aPagar} a pagar{l.financeiro ? ` (${reais(l.financeiro.aPagar)})` : ""} · {l.pendencias.aReceber} a receber
                        {l.financeiro ? ` (${reais(l.financeiro.aReceber)})` : ""}
                      </p>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Celular e telas médias: cartões */}
          <ul className="grid gap-2 p-3 lg:hidden">
            {linhas.map((l) => (
              <li key={l.id}>
                <button type="button" onClick={() => onAbrirMissao(l.id)} className="w-full rounded-lg border border-linha bg-superficie p-3 text-left text-sm">
                  <span className="block font-medium">{l.titulo}</span>
                  <span className="block text-xs text-muted">{l.etapa}</span>
                  <span className="mt-1 block text-xs">
                    <Avanco l={l} />
                    {l.custo?.consumo != null ? ` · ${l.custo.consumo}% do custo` : ""}
                    {l.equipe.alocados ? ` · ${l.equipe.alocados} alocado(s)` : ""} · {l.rdos.semana} RDO(s) na semana · {l.qualidade.abertos} na Qualidade
                    {l.medicao
                      ? l.medicao.situacao === "SEM_MEDICAO"
                        ? " · sem medição no filtroAPP"
                        : ` · medição ${MEDICAO[l.medicao.situacao].toLowerCase()}`
                      : ""}
                  </span>
                  <span className="mt-2 block">
                    <Alertas l={l} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ComoLer() {
  return (
    <div className="mt-2 text-sm">
      <p className="rotulo flex items-center gap-1.5 text-muted">
        <CircleAlert size={14} aria-hidden /> Colunas
      </p>
      <ul className="mt-1 grid gap-1 text-muted sm:grid-cols-2">
        <li>
          <b className="text-ink">Avanço</b> — % do filtroAPP e quanto andou nesta semana; a meta em andamento aparece como cadastrada no filtroAPP (m, L, un, colaboradores por dia), com o realizado pelos RDOs.
        </li>
        <li>
          <b className="text-ink">Custo</b> — quanto do custo previsto já foi gasto, ao lado do avanço físico (mesmo cálculo do Acompanhamento do filtroAPP).
        </li>
        <li>
          <b className="text-ink">Equipe</b> — alocados nesta semana no Efetivo e horas extras do ponto (semanas com uma pessoa só não aparecem).
        </li>
        <li>
          <b className="text-ink">Campo</b> — RDOs da semana, o último e os devolvidos sem correção; desvios, reclamações e lições abertos na Qualidade.
        </li>
        <li>
          <b className="text-ink">Faturamento</b> — medição no filtroAPP, notas do Omie ligadas à missão e pendências a pagar e a receber{" "}
          <span className="text-muted">(valores só para gerentes e diretoria)</span>.
        </li>
        <li>
          <b className="text-ink">Alertas</b> — em vermelho, o que precisa de ação já.
        </li>
      </ul>
      <p className="mt-3 text-muted">
        Custo em vermelho: gasto mais de 15 pontos à frente do avanço. Alerta grave acima de 30 pontos ou além de 100% do previsto.
      </p>
    </div>
  );
}
