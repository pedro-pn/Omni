import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle } from "lucide-react";
import type { MetaFiltroApp } from "@omni/core";
import { useState, type ReactNode } from "react";

import { getGestaoMissao, type GestaoMissao, type SemanaGestao } from "../../lib/gestao-fns.ts";
import { FalhaAoCarregar } from "../comum/TentarDeNovo.tsx";

/**
 * Aba Gestão da missão: avanço semana a semana, custo × avanço (só gerente e
 * diretoria), equipe e horas, equipamento em obra. Tudo vem do filtroAPP
 * (cópias do worker); a permissão é do banco.
 */

const dia = (iso: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().slice(0, 2).join("/") : "—");
const reais = (v: number | null) => (v === null ? "—" : v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }));
const pp = (n: number) => (Math.round(n * 10) / 10).toLocaleString("pt-BR");
const horas = (min: number) => `${Math.round(min / 60).toLocaleString("pt-BR")}h`;
const periodo = (de: string | null, ate: string | null) =>
  de && ate ? `${dia(de)} a ${dia(ate)}` : de ? `desde ${dia(de)}` : ate ? `até ${dia(ate)}` : "sem datas no Efetivo";
const ganho = (s: SemanaGestao) => (s.avancoInicio !== null && s.avancoFim !== null ? s.avancoFim - s.avancoInicio : null);

export function useGestaoMissao(missionId: string) {
  return useQuery({ queryKey: ["gestao", missionId], queryFn: () => getGestaoMissao({ data: { missionId } }) });
}

function Secao({ titulo, children, nota }: { titulo: string; children: ReactNode; nota?: string }) {
  return (
    <section className="rounded-lg border border-linha bg-superficie p-5">
      <h3 className="rotulo text-muted">{titulo}</h3>
      <div className="mt-3">{children}</div>
      {nota && <p className="mt-3 text-xs text-muted">{nota}</p>}
    </section>
  );
}

function Numero({ rotulo, valor, detalhe }: { rotulo: string; valor: string; detalhe?: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{rotulo}</dt>
      <dd className="text-xl font-semibold tabular-nums">{valor}</dd>
      {detalhe && <dd className="text-xs text-muted">{detalhe}</dd>}
    </div>
  );
}

/** Barra horizontal de uma série (uma cor; o rótulo e o valor ficam em texto). */
function BarraH({ rotulo, valor, max, texto, alerta }: { rotulo: string; valor: number; max: number; texto: string; alerta?: boolean }) {
  const largura = max > 0 ? Math.max(0, Math.min(100, (valor / max) * 100)) : 0;
  return (
    <div className="grid grid-cols-[minmax(0,10.5rem)_1fr_auto] items-center gap-3 text-sm" title={`${rotulo}: ${texto}`}>
      <span className="truncate text-muted">{rotulo}</span>
      <div className="h-3 overflow-hidden" aria-hidden>
        <div className={`h-full rounded-r-[4px] ${alerta ? "bg-vermelho" : "bg-floresta"}`} style={{ width: `${largura}%` }} />
      </div>
      <span className="tabular-nums">{texto}</span>
    </div>
  );
}

function Custos({ custo }: { custo: NonNullable<GestaoMissao["custo"]> }) {
  const frente = custo.consumo !== null && custo.avancoFisico !== null ? custo.consumo - custo.avancoFisico : null;
  const aFrente = frente !== null && frente > 15;
  const escala = Math.max(100, custo.consumo ?? 0, custo.avancoFisico ?? 0);
  return (
    <Secao titulo="Custo × avanço" nota={`Mesmo cálculo do Acompanhamento do filtroAPP, até ${dia(custo.ate)}.`}>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Numero rotulo="Custo previsto" valor={reais(custo.custoPrevisto)} detalhe={custo.diasPrevistos !== null ? `${pp(custo.diasPrevistos)} dias previstos` : undefined} />
        <Numero rotulo="Gasto até agora" valor={reais(custo.total)} />
        <Numero rotulo="Preço de venda" valor={reais(custo.precoVenda)} detalhe={custo.margemPrevista !== null ? `margem prevista ${pp(custo.margemPrevista)}%` : undefined} />
        <Numero rotulo="Consumo do custo" valor={custo.consumo === null ? "—" : `${custo.consumo}%`} detalhe={custo.consumo === null ? "sem orçamento" : undefined} />
      </dl>
      {custo.consumo !== null && custo.avancoFisico !== null && (
        <div className="mt-5 space-y-2">
          <BarraH rotulo="Custo consumido" valor={custo.consumo} max={escala} texto={`${custo.consumo}%`} alerta={aFrente} />
          <BarraH rotulo="Avanço físico" valor={custo.avancoFisico} max={escala} texto={`${Math.round(custo.avancoFisico)}%`} />
          {aFrente && (
            <p className="flex items-center gap-1.5 text-sm text-vermelho">
              <AlertTriangle size={14} aria-hidden /> Custo {Math.round(frente)} pontos à frente do avanço.
            </p>
          )}
        </div>
      )}
      {custo.porCategoria.length > 0 && (
        <div className="mt-5">
          <p className="mb-2 text-xs text-muted">Composição do gasto</p>
          <div className="space-y-2">
            {[...custo.porCategoria]
              .sort((a, b) => b.valor - a.valor)
              .map((c) => (
                <BarraH
                  key={c.codigo}
                  rotulo={c.rotulo}
                  valor={c.valor}
                  max={custo.total}
                  texto={`${reais(c.valor)} · ${custo.total > 0 ? Math.round((c.valor / custo.total) * 100) : 0}%`}
                />
              ))}
          </div>
        </div>
      )}
    </Secao>
  );
}

/** Colunas do ganho de avanço por semana (p.p.), com a meta quando há. Uma série, uma cor. */
function Evolucao({ semanas }: { semanas: SemanaGestao[] }) {
  const comDado = semanas.filter((s) => ganho(s) !== null);
  const [foco, setFoco] = useState<number | null>(null);
  if (!comDado.length) return <p className="text-sm text-muted">O filtroAPP ainda não tem avanço registrado para esta missão.</p>;
  const valores = semanas.flatMap((s) => [ganho(s) ?? 0, s.meta ?? 0]);
  const max = Math.max(1, ...valores);
  const min = Math.min(0, ...valores);
  const altura = 140;
  const y = (v: number) => ((max - v) / (max - min)) * altura;
  const zero = y(0);
  const ativa = foco !== null ? semanas[foco]! : semanas[semanas.length - 1]!;
  const g = ganho(ativa);
  return (
    <div>
      {/* Leitura da coluna em foco (passe o mouse ou use Tab) */}
      <p className="min-h-5 text-sm" aria-live="polite">
        <span className="text-muted">Semana de {dia(ativa.inicio)}: </span>
        {g === null ? (
          "sem avanço registrado"
        ) : (
          <>
            {pp(ativa.avancoInicio!)}% → {pp(ativa.avancoFim!)}% <b className="tabular-nums">({g >= 0 ? "+" : ""}
            {pp(g)} p.p.)</b>
          </>
        )}
        {ativa.meta !== null && <span className="text-muted"> · meta {pp(ativa.meta)} p.p.</span>}
      </p>
      <div className="relative mt-2" style={{ height: altura }}>
        <div className="absolute inset-x-0 border-t border-linha" style={{ top: zero }} aria-hidden />
        <ol className="absolute inset-0 flex items-stretch gap-1" aria-label="Avanço por semana">
          {semanas.map((s, i) => {
            const v = ganho(s);
            const topo = v === null ? zero : Math.min(y(v), zero);
            const alt = v === null ? 0 : Math.max(2, Math.abs(y(v) - zero));
            return (
              <li
                key={s.inicio}
                tabIndex={0}
                onMouseEnter={() => setFoco(i)}
                onFocus={() => setFoco(i)}
                onMouseLeave={() => setFoco(null)}
                onBlur={() => setFoco(null)}
                aria-label={`Semana de ${dia(s.inicio)}: ${v === null ? "sem avanço registrado" : `${pp(v)} pontos`}${s.meta !== null ? `, meta ${pp(s.meta)}` : ""}`}
                className={`relative flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-floresta ${foco === i ? "bg-superficie-2" : ""}`}
              >
                {v !== null && (
                  <span
                    className={`absolute left-1/2 w-full max-w-6 -translate-x-1/2 bg-floresta ${v >= 0 ? "rounded-t-[4px]" : "rounded-b-[4px]"}`}
                    style={{ top: topo, height: alt }}
                  />
                )}
                {s.meta !== null && <span className="absolute left-1/2 h-0.5 w-8 -translate-x-1/2 bg-ink" style={{ top: y(s.meta) }} />}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-1 flex gap-1 text-[11px] text-muted" aria-hidden>
        {semanas.map((s, i) => (
          <span key={s.inicio} className="flex-1 text-center tabular-nums">
            {i % 2 === semanas.length % 2 || semanas.length <= 6 ? dia(s.inicio) : ""}
          </span>
        ))}
      </div>
      {semanas.some((s) => s.meta !== null) && (
        <p className="mt-2 flex items-center gap-2 text-xs text-muted">
          <span className="inline-block h-0.5 w-4 bg-ink" aria-hidden /> meta da semana (p.p.)
        </p>
      )}
    </div>
  );
}

function Revisao({ semanas }: { semanas: SemanaGestao[] }) {
  const s = [...semanas].reverse().find((x) => x.revisao);
  if (!s?.revisao) return null;
  return (
    <div className="mt-5 border-t border-linha pt-4">
      <p className="text-sm">
        Revisão semanal no filtroAPP, semana de {dia(s.inicio)}:{" "}
        <b>{s.revisao.concluidaEm ? `feita em ${dia(s.revisao.concluidaEm)}` : `${s.revisao.pendencias} pendente(s)`}</b>
      </p>
      <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
        {s.revisao.itens.map((i) => (
          <li key={i.codigo} className="flex items-center gap-2">
            {i.ok ? <Check size={14} className="text-floresta-texto" aria-label="Feito" /> : <Circle size={14} className="text-muted" aria-label="Pendente" />}
            {i.rotulo}
          </li>
        ))}
      </ul>
    </div>
  );
}

const PENDENCIA_BASE: Record<string, string> = {
  MISSING_RDO_BASE: "há RDO sem as horas produtivas da equipe",
  NO_PRODUCTIVE_TIME: "sem tempo produtivo registrado nos RDOs",
};
const qtd = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

function SituacaoMeta({ m }: { m: MetaFiltroApp }) {
  const ruim = m.situacao === "BELOW" || m.situacao === "PARTIAL";
  const boa = m.situacao === "ON_TARGET" || m.situacao === "ABOVE";
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${ruim ? "text-vermelho" : boa ? "text-floresta-texto" : "text-muted"}`}>
      {ruim ? <AlertTriangle size={14} aria-hidden /> : boa ? <Check size={14} aria-hidden /> : <Circle size={14} aria-hidden />}
      {m.rotuloSituacao}
      {m.atingimentoPct !== null && m.situacao !== "NO_DATA" && m.situacao !== "PLANNED" ? ` · ${Math.round(m.atingimentoPct)}%` : ""}
    </span>
  );
}

/** Metas da semana como estão cadastradas no filtroAPP; o realizado vem dos RDOs (cálculo do filtroAPP). */
function Metas({ semanas, hoje }: { semanas: SemanaGestao[]; hoje: string }) {
  const metas = semanas
    .map((s) => s.metaFiltroApp)
    .filter((m): m is MetaFiltroApp => Boolean(m) && m!.situacao !== "NO_RULE")
    .sort((a, b) => b.periodoInicio.localeCompare(a.periodoInicio))
    .slice(0, 6);
  if (!metas.length) return null;
  return (
    <Secao titulo="Metas do filtroAPP" nota="Como cadastradas no filtroAPP; o realizado é calculado lá, pelos RDOs. O período de cada meta pode não ser de segunda a domingo.">
      <ol className="space-y-4">
        {metas.map((m) => {
          const agora = m.periodoInicio <= hoje && hoje <= m.periodoFim;
          return (
            <li key={m.periodoInicio} className="border-t border-linha pt-3 first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm">
                  <b>
                    {dia(m.periodoInicio)} a {dia(m.periodoFim)}
                  </b>
                  {agora && <span className="ml-2 rounded-sm bg-floresta-clara px-1.5 py-0.5 text-xs text-floresta-texto">em andamento</span>}
                  {m.cenario && <span className="text-muted"> · {m.cenario}</span>}
                  {m.itens.length > 1 && <span className="text-muted"> · {m.regra === "ANY" ? "basta uma linha" : "todas as linhas"}</span>}
                </p>
                <SituacaoMeta m={m} />
              </div>
              <ul className="mt-1.5 space-y-1.5 text-sm">
                {m.itens.map((i, n) => (
                  <li key={n}>
                    <p>{i.descricao}</p>
                    <p className="text-xs text-muted tabular-nums">
                      {i.realizado !== null ? `realizado ${qtd(i.realizado)} ${i.rotuloUnidade}` : "sem realizado"}
                      {i.planejado !== null ? ` de ${qtd(i.planejado)} ${i.rotuloUnidade} planejados` : ""}
                      {i.pendenciasBase.length ? ` · ${i.pendenciasBase.map((p) => PENDENCIA_BASE[p] ?? p).join("; ")}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
              {m.colaboradoresPorDia.length > 0 && (
                <p className="mt-1.5 text-xs text-muted tabular-nums">
                  Presentes por dia:{" "}
                  {m.colaboradoresPorDia
                    .map((d) => `${dia(d.data)} ${d.presentes === null ? "sem base" : d.presentes}${d.planejado !== null ? ` de ${d.planejado}` : ""}`)
                    .join(" · ")}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </Secao>
  );
}

function EquipeEHoras({ dados }: { dados: GestaoMissao }) {
  const semanas = [...dados.semanas].reverse().slice(0, 6);
  return (
    <Secao
      titulo="Equipe e horas"
      nota="Prevista: alocados no Efetivo. No ponto: pessoas com horas apropriadas na missão (semanas com uma pessoa só não vêm do filtroAPP)."
    >
      {dados.equipe.length > 0 ? (
        <ul className="mb-4 space-y-1 text-sm">
          {dados.equipe.map((e) => (
            <li key={e.funcao} className="flex flex-wrap gap-x-2">
              <b className="tabular-nums">{e.pessoas}</b> {e.funcao}
              <span className="text-muted">· {periodo(e.mobilizacao, e.desmobilizacao)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-4 text-sm text-muted">Ninguém alocado no Efetivo do filtroAPP.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Semana</th>
              <th className="px-3 py-1.5 text-right font-medium">Prevista</th>
              <th className="px-3 py-1.5 text-right font-medium">No ponto</th>
              <th className="px-3 py-1.5 text-right font-medium">Horas normais</th>
              <th className="px-3 py-1.5 text-right font-medium">Extras 70%</th>
              <th className="px-3 py-1.5 text-right font-medium">Extras 100%</th>
              <th className="px-3 py-1.5 text-right font-medium">Noturnas</th>
              <th className="py-1.5 pl-3 text-right font-medium">RDOs</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {semanas.map((s) => (
              <tr key={s.inicio} className="border-t border-linha">
                <td className="py-1.5 pr-3">{dia(s.inicio)}</td>
                <td className="px-3 py-1.5 text-right">{s.alocados || "—"}</td>
                <td className="px-3 py-1.5 text-right">{s.ponto?.pessoas ?? "—"}</td>
                <td className="px-3 py-1.5 text-right">{s.ponto ? horas(s.ponto.normais) : "—"}</td>
                <td className="px-3 py-1.5 text-right">{s.ponto ? horas(s.ponto.extra70) : "—"}</td>
                <td className="px-3 py-1.5 text-right">{s.ponto ? horas(s.ponto.extra100) : "—"}</td>
                <td className="px-3 py-1.5 text-right">{s.ponto ? horas(s.ponto.noturnos) : "—"}</td>
                <td className="py-1.5 pl-3 text-right">{s.rdos}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Secao>
  );
}

function Equipamento({ e, veCustos }: { e: NonNullable<GestaoMissao["equipamento"]>; veCustos: boolean }) {
  const alem = !e.retorno && e.permanenciaPrevista !== null && e.diasEmObra !== null && e.diasEmObra > e.permanenciaPrevista;
  return (
    <Secao titulo="Equipamento em obra" nota="Pelos romaneios do filtroAPP. O retorno nem sempre é registrado em romaneio.">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Numero rotulo="Primeira saída" valor={dia(e.saida)} />
        <Numero rotulo="Retorno" valor={e.retorno ? dia(e.retorno) : "Sem registro"} />
        <Numero
          rotulo={e.retorno ? "Ficou em obra" : "Em obra há"}
          valor={e.diasEmObra === null ? "—" : `${e.diasEmObra} dias`}
          detalhe={e.permanenciaPrevista !== null ? `previsto ${pp(e.permanenciaPrevista)} dias` : "sem permanência prevista"}
        />
        {veCustos && <Numero rotulo="Diária de stand-by" valor={e.diaria ? reais(e.diaria) : "Sem diária"} />}
      </dl>
      {alem && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-vermelho">
          <AlertTriangle size={14} aria-hidden /> Além da permanência prevista na proposta.
        </p>
      )}
    </Secao>
  );
}

const MEDICAO: Record<string, string> = { SEM_MEDICAO: "Sem medição", PREPARADA: "Preparada", ENVIADA: "Enviada ao cliente", APROVADA: "Aprovada" };
const RECEBIMENTO: Record<string, string> = { RECEBIDA: "Recebida", PARCIAL: "Recebida em parte", EM_ABERTO: "A receber", ATRASADA: "Atrasada", DESCONHECIDA: "—" };
const TIPO_QUALIDADE: Record<string, string> = { DESVIO: "Desvio", LICAO_APRENDIDA: "Lição aprendida", RECLAMACAO: "Reclamação", OPORTUNIDADE: "Oportunidade de melhoria" };
const STATUS_QUALIDADE: Record<string, string> = { ABERTO: "Aberto", EM_ACAO: "Em ação", EM_OBSERVACAO: "Em observação", FECHADO: "Fechado", DIVULGADO: "Divulgado" };
const IMPACTO: Record<string, string> = { BAIXO: "baixo", MEDIO: "médio", ALTO: "alto", CRITICO: "crítico" };
const rotulo = (mapa: Record<string, string>, v: string) => mapa[v] ?? v.toLowerCase().replaceAll("_", " ");

const qtd2 = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 2 });

/** Composição do avanço: os mesmos cartões do detalhe do projeto no filtroAPP (o Omni não recalcula). */
function Composicao({ c }: { c: NonNullable<GestaoMissao["composicao"]> }) {
  return (
    <Secao
      titulo="Composição do avanço"
      nota={`Como no detalhe do projeto no filtroAPP: por serviço e, quando há unidade ligada, por equipamento. O avanço total é o oficial do filtroAPP, não a média dos cartões. Atualizado em ${dia(c.atualizadoEm)}.`}
    >
      {c.avancoTotal !== null && (
        <p className="mb-3 text-sm">
          <span className="text-muted">Avanço total:</span> <span className="text-lg font-semibold tabular-nums">{pp(c.avancoTotal)}%</span>
        </p>
      )}
      {!c.servicos.length ? (
        <p className="text-sm text-muted">Ainda não há composição do avanço no filtroAPP.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {c.servicos.map((s, i) => {
            const pct = s.avancoPct;
            const somam = s.previsto !== null && s.realizado !== null;
            const unidade = s.rotuloUnidade ?? "";
            const excedente = somam && s.realizado! > s.previsto! ? s.realizado! - s.previsto! : 0;
            return (
              <li key={`${s.escopo ?? ""}-${s.servico}-${s.equipamento ?? ""}-${i}`} className="rounded-md border border-linha p-3">
                {s.escopo && <p className="text-xs text-muted">Escopo: {s.escopo}</p>}
                {s.equipamento && <p className="text-xs text-muted">{s.rotuloServico}</p>}
                <p className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{s.equipamento ?? s.rotuloServico}</span>
                  <span className="shrink-0 font-semibold tabular-nums">{pct === null ? "—" : `${pp(pct)}%`}</span>
                </p>
                <p className="text-sm text-muted">
                  {somam ? `${qtd2(s.realizado!)} ${unidade} de ${qtd2(s.previsto!)} ${unidade}`.replace(/\s+/g, " ") : `${s.sistemas} ${s.sistemas === 1 ? "sistema" : "sistemas"}`}
                </p>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-superficie-2" aria-hidden>
                  <div className={`h-full ${pct !== null && pct >= 100 ? "bg-floresta" : "bg-azul"}`} style={{ width: `${Math.max(0, Math.min(100, pct ?? 0))}%` }} />
                </div>
                <p className="mt-1 flex justify-between text-xs text-muted">
                  <span>{pct !== null && pct >= 100 ? "Meta atingida" : s.equipamento ? "Avanço do equipamento" : "Avanço do serviço"}</span>
                  {excedente > 0 && <span className="font-medium text-ink">+{qtd2(excedente)} {unidade} excedente</span>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Secao>
  );
}

function Faturamento({ f }: { f: GestaoMissao["faturamento"] }) {
  const v = f.valores;
  const vazio = !f.medicao && !f.notas.length && !f.pendencias;
  return (
    <Secao titulo="Faturamento" nota="Pelo filtroAPP (medição, notas e pendências no Omie). Valores em reais só para gerentes e diretoria.">
      {vazio ? (
        <p className="text-sm text-muted">Ainda sem medição, notas ou pendências no filtroAPP.</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Numero
              rotulo="Medição"
              valor={f.medicao ? rotulo(MEDICAO, f.medicao.situacao) : "—"}
              detalhe={
                f.medicao?.aprovadaEm
                  ? `aprovada em ${dia(f.medicao.aprovadaEm)}`
                  : f.medicao?.enviadaEm
                    ? `enviada em ${dia(f.medicao.enviadaEm)}`
                    : f.medicao?.preparadaEm
                      ? `preparada em ${dia(f.medicao.preparadaEm)}`
                      : undefined
              }
            />
            <Numero rotulo="Notas emitidas" valor={String(f.notas.length)} detalhe={v ? reais(v.notasEmitidas) : undefined} />
            <Numero
              rotulo="A receber no Omie"
              valor={f.pendencias ? String(f.pendencias.aReceber) : "—"}
              detalhe={v?.aReceber != null ? reais(v.aReceber) : f.pendencias?.proximoVencimento ? `próximo vencimento ${dia(f.pendencias.proximoVencimento)}` : undefined}
            />
            <Numero rotulo="A pagar no Omie" valor={f.pendencias ? String(f.pendencias.aPagar) : "—"} detalhe={v?.aPagar != null ? reais(v.aPagar) : undefined} />
          </dl>
          {v && (v.executado !== null || v.medido !== null || v.aprovado !== null) && (
            <dl className="grid grid-cols-3 gap-4 border-t border-linha pt-3 text-sm">
              <Numero rotulo="Executado" valor={reais(v.executado)} />
              <Numero rotulo="Medido" valor={reais(v.medido)} />
              <Numero rotulo="Aprovado" valor={reais(v.aprovado)} detalhe={f.medicao?.saldoPendente ? "com saldo pendente" : undefined} />
            </dl>
          )}
          {f.notas.length > 0 && (
            <ul className="divide-y divide-linha border-t border-linha text-sm">
              {f.notas.map((n) => (
                <li key={n.id} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
                  <span>
                    {n.tipo === "NFSE" ? "NFS-e" : n.tipo === "NFE" ? "NF-e" : "ND"} {n.numero} <span className="text-muted">· {dia(n.emissao)}</span>
                  </span>
                  <span className={n.recebimento === "ATRASADA" ? "font-medium text-vermelho" : n.recebimento === "RECEBIDA" ? "text-floresta-texto" : "text-muted"}>
                    {rotulo(RECEBIMENTO, n.recebimento)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Secao>
  );
}

function Desvios({ desvios }: { desvios: GestaoMissao["desvios"] }) {
  const abertos = desvios.filter((d) => d.aberto).length;
  return (
    <Secao titulo="Desvios e Qualidade" nota="Registros da Qualidade do filtroAPP desta missão (sem descrição nem responsável). Para tratar, abra no filtroAPP.">
      {!desvios.length ? (
        <p className="text-sm text-muted">Nenhum registro de Qualidade nesta missão.</p>
      ) : (
        <>
          <p className="mb-2 text-sm">
            {abertos ? (
              <span className="font-medium text-vermelho">
                {abertos} {abertos === 1 ? "aberto" : "abertos"}
              </span>
            ) : (
              <span className="text-floresta-texto">Nenhum aberto</span>
            )}{" "}
            <span className="text-muted">· {desvios.length} no total</span>
          </p>
          <ul className="divide-y divide-linha text-sm">
            {desvios.map((d) => (
              <li key={d.id} className={`flex flex-wrap items-baseline justify-between gap-2 py-1.5 ${d.aberto ? "" : "text-muted"}`}>
                <span className="min-w-0">
                  <span className="font-medium">
                    {rotulo(TIPO_QUALIDADE, d.tipo)} {d.numero}
                  </span>
                  {d.natureza && <span> · {d.natureza}</span>}
                  {d.impacto && <span> · impacto {rotulo(IMPACTO, d.impacto)}</span>}
                  {d.recorrente && <span className="text-vermelho"> · recorrente</span>}
                </span>
                <span className="shrink-0 text-xs">
                  {rotulo(STATUS_QUALIDADE, d.status)}
                  {d.data ? ` · ${dia(d.data)}` : ""}
                  {d.aberto && d.prazo ? ` · prazo ${dia(d.prazo)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Secao>
  );
}

export function GestaoDaMissao({ missionId }: { missionId: string }) {
  const q = useGestaoMissao(missionId);
  if (q.isPending) return <p className="p-5 text-sm text-muted">Carregando…</p>;
  if (q.isError) return <FalhaAoCarregar mensagem="Não foi possível carregar a gestão da missão." consulta={q} />;
  const d = q.data;
  if (!d.podeVer) return <p className="p-5 text-sm text-muted">A gestão da missão é para gerentes, diretoria e quem participa do Interno.</p>;
  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-5">
      <Secao
        titulo="Avanço semana a semana"
        nota="Pontos percentuais ganhos em cada semana, pelo Acompanhamento do filtroAPP. A linha de meta só aparece para metas em pontos percentuais; as demais estão em Metas do filtroAPP."
      >
        <Evolucao semanas={d.semanas} />
        <Revisao semanas={d.semanas} />
      </Secao>
      {d.composicao && <Composicao c={d.composicao} />}
      <Metas semanas={d.semanas} hoje={new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" })} />
      {d.veCustos && d.custo && <Custos custo={d.custo} />}
      <EquipeEHoras dados={d} />
      {d.equipamento && <Equipamento e={d.equipamento} veCustos={d.veCustos} />}
      <Faturamento f={d.faturamento} />
      <Desvios desvios={d.desvios} />
    </div>
  );
}
