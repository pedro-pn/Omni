import { LIMITES_OPERACAO } from "@omni/core";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";

import { saude, type Saude as DadosDeSaude } from "../../lib/saude-fns.ts";
import { Aviso, mensagemDeErro } from "./ui.tsx";
import { Carregando } from "../comum/Carregando.tsx";

type Nivel = "ok" | "atencao" | "problema";

const horasDesde = (iso: string | null | undefined, agora: string) =>
  iso ? (Date.parse(agora) - Date.parse(iso)) / 3_600_000 : Infinity;
const quando = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "nunca";
const ms = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(1).replace(".", ",")} s` : `${v} ms`;
const pct = (a: number, b: number) =>
  b ? `${((a / b) * 100).toFixed(1).replace(".", ",")}%` : "0%";

/** Regras dos sinais (verde, amarelo, vermelho) de cada bloco. */
export function niveis(s: DadosDeSaude) {
  const taxaErro = s.web.ultimoDia.n
    ? s.web.ultimoDia.erros / s.web.ultimoDia.n
    : 0;
  const web: Nivel =
    taxaErro > 0.05 || s.web.ultimoDia.p95Ms > 2500
      ? "problema"
      : taxaErro > 0.01 || s.web.ultimoDia.p95Ms > 1000
        ? "atencao"
        : "ok";
  const worker: Nivel =
    !s.worker || horasDesde(s.worker.visto, s.agora) > 0.25 ? "problema" : "ok";
  let backup: Nivel | null = null;
  if (s.backup) {
    const falhou = [s.backup.local, s.backup.remoto, s.backup.ensaio].some(
      (e) => e?.status && e.status !== "SUCCESS",
    );
    backup =
      falhou ||
      horasDesde(s.backup.remoto?.em, s.agora) >
        LIMITES_OPERACAO.backupRemotoHoras
        ? "problema"
        : horasDesde(s.backup.ensaio?.em, s.agora) >
            LIMITES_OPERACAO.ensaioDias * 24
          ? "atencao"
          : "ok";
  }
  const jobs: Nivel =
    s.jobs.some((j) => j.falhas24h > 0) || s.jobs.some((j) => j.naFila > 50)
      ? "atencao"
      : "ok";
  const banco: Nivel =
    s.banco.conexoes > s.banco.conexoesMax * 0.8
      ? "problema"
      : s.banco.conexoes > s.banco.conexoesMax * 0.6
        ? "atencao"
        : "ok";
  const erros: Nivel = s.errosAbertos > 0 ? "atencao" : "ok";
  const filtroapp: Nivel =
    horasDesde(s.filtroapp.ultimaSincronizacao, s.agora) > 2 ? "atencao" : "ok";
  return { web, worker, backup, jobs, banco, erros, filtroapp };
}

const ICONE: Record<
  Nivel,
  { Icone: typeof CircleCheck; cor: string; rotulo: string }
> = {
  ok: { Icone: CircleCheck, cor: "text-floresta", rotulo: "Tudo certo" },
  atencao: { Icone: CircleAlert, cor: "text-ink", rotulo: "Atenção" },
  problema: { Icone: CircleX, cor: "text-vermelho", rotulo: "Problema" },
};

function Bloco({
  titulo,
  nivel,
  children,
}: {
  titulo: string;
  nivel: Nivel | null;
  children: ReactNode;
}) {
  const i = nivel ? ICONE[nivel] : null;
  return (
    <section
      className={`rounded-lg border bg-superficie p-4 text-sm ${nivel === "problema" ? "border-vermelho" : "border-linha"}`}
    >
      <h2 className="flex items-center gap-2 font-medium">
        {i && <i.Icone size={18} aria-hidden className={i.cor} />}
        {titulo}
        {i && <span className="sr-only">: {i.rotulo}</span>}
      </h2>
      <div className="mt-2 space-y-1 text-muted">{children}</div>
    </section>
  );
}

/**
 * Saúde (E20, pilar 12.3): os números vitais do Omni num lugar só, atualizados a cada minuto.
 * Os logs completos (pesquisáveis, já mascarados) ficam no Grafana Cloud: docs/producao/logs.md.
 */
export function Saude() {
  const q = useQuery({
    queryKey: ["admin", "saude"],
    queryFn: () => saude(),
    refetchInterval: 60_000,
  });
  if (q.isPending) return <Carregando />;
  if (q.isError) return <Aviso tipo="erro">{mensagemDeErro(q.error)}</Aviso>;
  const s = q.data;
  const n = niveis(s);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Atualizado {quando(s.agora)}. Logs completos e pesquisáveis no Grafana
        Cloud (docs/producao/logs.md).
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Bloco titulo="Web" nivel={n.web}>
          <p>
            Versão {s.web.versao ?? "?"} · no ar desde {quando(s.web.desde)} ·{" "}
            {s.web.memoriaMb} MB
          </p>
          <p>
            Última hora: {s.web.ultimaHora.n.toLocaleString("pt-BR")} chamadas,
            p95 {ms(s.web.ultimaHora.p95Ms)}, erros{" "}
            {pct(s.web.ultimaHora.erros, s.web.ultimaHora.n)}
          </p>
          <p>
            24 horas: {s.web.ultimoDia.n.toLocaleString("pt-BR")} chamadas,
            média {ms(s.web.ultimoDia.mediaMs)}, p95 {ms(s.web.ultimoDia.p95Ms)}
            , erros {pct(s.web.ultimoDia.erros, s.web.ultimoDia.n)}
          </p>
        </Bloco>
        <Bloco titulo="Worker" nivel={n.worker}>
          {s.worker ? (
            <>
              <p>
                Versão {s.worker.versao ?? "?"} · no ar desde{" "}
                {quando(s.worker.desde)} · {s.worker.memoriaMb} MB
              </p>
              <p>
                Último sinal {quando(s.worker.visto)} (a cada 5 min; mais de 15
                min sem sinal é problema)
              </p>
            </>
          ) : (
            <p>O worker ainda não mandou sinal.</p>
          )}
        </Bloco>
        <Bloco titulo="Backup" nivel={n.backup}>
          {s.backup ? (
            <>
              <p>
                Cópia local: {s.backup.local?.status ?? "—"} em{" "}
                {quando(s.backup.local?.em)}
              </p>
              <p>
                No B2: {s.backup.remoto?.status ?? "—"} em{" "}
                {quando(s.backup.remoto?.em)} (limite{" "}
                {LIMITES_OPERACAO.backupRemotoHoras} h)
              </p>
              <p>
                Ensaio de restauração: {s.backup.ensaio?.status ?? "—"} em{" "}
                {quando(s.backup.ensaio?.em)} (limite{" "}
                {LIMITES_OPERACAO.ensaioDias} dias)
              </p>
            </>
          ) : (
            <p>Não conferido neste ambiente (OPERACAO_STATUS desligado).</p>
          )}
        </Bloco>
        <Bloco titulo="Banco" nivel={n.banco}>
          <p>
            {s.banco.tamanhoMb.toLocaleString("pt-BR")} MB · {s.banco.conexoes}{" "}
            de {s.banco.conexoesMax} conexões
          </p>
          <p>
            Maiores:{" "}
            {s.banco.maiores
              .map((t) => `${t.tabela} (${t.mb.toLocaleString("pt-BR")} MB)`)
              .join(", ")}
          </p>
        </Bloco>
        <Bloco titulo="Erros do sistema" nivel={n.erros}>
          <p>
            {s.errosAbertos
              ? `${s.errosAbertos} sem revisão (aba Erros).`
              : "Nenhum erro sem revisão."}
          </p>
        </Bloco>
        <Bloco titulo="filtroAPP" nivel={n.filtroapp}>
          <p>
            {s.filtroapp.missoesAtivas} missões ativas · última leitura{" "}
            {quando(s.filtroapp.ultimaSincronizacao)} (a cada 30 min)
          </p>
        </Bloco>
      </div>

      <Bloco titulo="Tarefas automáticas (worker)" nivel={n.jobs}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left">
              <tr>
                <th className="py-1 pr-2 font-medium">Tarefa</th>
                <th className="py-1 pr-2 font-medium">Última com sucesso</th>
                <th className="py-1 pr-2 text-right font-medium">
                  Falhas (24 h)
                </th>
                <th className="py-1 pr-2 text-right font-medium">Na fila</th>
                <th className="py-1 text-right font-medium">Rodando</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-linha text-ink">
              {s.jobs.map((j) => (
                <tr key={j.nome}>
                  <td className="py-1 pr-2 font-mono text-xs">{j.nome}</td>
                  <td className="py-1 pr-2">{quando(j.ultimaOk)}</td>
                  <td
                    className={`py-1 pr-2 text-right tabular-nums ${j.falhas24h ? "font-semibold text-vermelho" : ""}`}
                  >
                    {j.falhas24h}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {j.naFila}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {j.emExecucao}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Bloco>
    </div>
  );
}
