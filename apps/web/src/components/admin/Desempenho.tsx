import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { desempenho } from "../../lib/desempenho-fns.ts";
import { Aviso, mensagemDeErro } from "./ui.tsx";

const PERIODOS = [
  { horas: 1, rotulo: "1 hora" },
  { horas: 24, rotulo: "24 horas" },
  { horas: 24 * 7, rotulo: "7 dias" },
] as const;

const ms = (v: number) =>
  v >= 1000 ? `${(v / 1000).toFixed(1).replace(".", ",")} s` : `${v} ms`;
const lento = (p95: number) =>
  p95 > 2500
    ? "text-vermelho font-semibold"
    : p95 > 1000
      ? "font-semibold"
      : "";

/**
 * Desempenho (E19, pilar 11.1): tempo de resposta por rota e por ação (server function) e as
 * consultas mais lentas do banco. Para otimizar pelo que a medição aponta, não pelo que parece lento.
 */
export function Desempenho() {
  const [horas, setHoras] = useState<number>(24);
  const q = useQuery({
    queryKey: ["admin", "desempenho", horas],
    queryFn: () => desempenho({ data: { horas } }),
  });
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-linha bg-superficie p-4 text-sm">
        <p className="font-medium">Como ler</p>
        <p className="mt-1 text-muted">
          Cada linha é uma página, rota ou ação do Omni, com os identificadores
          trocados por <code>:id</code>. O tempo vai até a resposta começar. O
          p95 é aproximado pela faixa: 95% das chamadas levaram até esse tempo.
          Em negrito, acima de 1 s; em vermelho, acima de 2,5 s.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Período">
        {PERIODOS.map((p) => (
          <button
            key={p.horas}
            type="button"
            onClick={() => setHoras(p.horas)}
            aria-pressed={horas === p.horas}
            className={`rounded-full border px-3 py-1 text-sm ${horas === p.horas ? "border-floresta bg-floresta/10 text-floresta-texto" : "border-linha hover:bg-superficie-2"}`}
          >
            {p.rotulo}
          </button>
        ))}
      </div>

      {q.isPending ? (
        <p className="text-muted">Carregando…</p>
      ) : q.isError ? (
        <Aviso tipo="erro">{mensagemDeErro(q.error)}</Aviso>
      ) : (
        <>
          <section>
            <h2 className="mb-2 font-medium">Tempo por rota e ação</h2>
            {!q.data.rotas.length ? (
              <p className="text-sm text-muted">
                Nada medido neste período ainda (a medição é gravada a cada
                minuto).
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-linha bg-superficie">
                <table className="w-full text-sm">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="p-2 font-medium">Rota ou ação</th>
                      <th className="p-2 text-right font-medium">Chamadas</th>
                      <th className="p-2 text-right font-medium">Média</th>
                      <th className="p-2 text-right font-medium">p95</th>
                      <th className="p-2 text-right font-medium">Máximo</th>
                      <th className="p-2 text-right font-medium">Erros</th>
                      <th className="p-2 text-right font-medium">
                        Tempo total
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-linha">
                    {q.data.rotas.map((r) => (
                      <tr key={r.rota}>
                        <td
                          className="max-w-[28rem] truncate p-2 font-mono text-xs"
                          title={r.rota}
                        >
                          {r.rota}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.chamadas.toLocaleString("pt-BR")}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {ms(r.mediaMs)}
                        </td>
                        <td
                          className={`p-2 text-right tabular-nums ${lento(r.p95Ms)}`}
                        >
                          {ms(r.p95Ms)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {ms(r.maxMs)}
                        </td>
                        <td
                          className={`p-2 text-right tabular-nums ${r.erros ? "text-vermelho" : ""}`}
                        >
                          {r.erros}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.totalS.toLocaleString("pt-BR")} s
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-2 font-medium">Consultas mais lentas no banco</h2>
            {!q.data.consultasLigadas ? (
              <p className="text-sm text-muted">
                A estatística de consultas (pg_stat_statements) não está ligada
                neste banco. Passo a passo em docs/producao/desempenho.md.
              </p>
            ) : !q.data.consultas.length ? (
              <p className="text-sm text-muted">
                Nenhuma consulta com 5 chamadas ou mais desde que a estatística
                foi zerada.
              </p>
            ) : (
              <ul className="divide-y divide-linha rounded-lg border border-linha bg-superficie">
                {q.data.consultas.map((c, i) => (
                  <li key={i} className="p-3 text-sm">
                    <p className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                      <span className={lento(c.mediaMs)}>
                        média {ms(Math.round(c.mediaMs))}
                      </span>
                      <span className="text-muted">
                        máx. {ms(Math.round(c.maxMs))}
                      </span>
                      <span className="text-muted">
                        {c.chamadas.toLocaleString("pt-BR")} chamadas
                      </span>
                      <span className="text-muted">
                        {Math.round(c.totalMs / 1000).toLocaleString("pt-BR")} s
                        no total
                      </span>
                    </p>
                    <code className="mt-1 block break-all font-mono text-xs text-muted">
                      {c.consulta}
                    </code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
