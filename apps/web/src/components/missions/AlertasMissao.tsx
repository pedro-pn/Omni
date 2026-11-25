import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Siren } from "lucide-react";

import { alertasDaMissao, mudarAlerta } from "../../lib/alertas-fns.ts";

const STATUS = { rascunho: "aguardando ativação", ativo: "ativo", pausado: "pausado", cancelado: "cancelado" } as Record<string, string>;

/** Alertas pedidos à IA nesta missão (§7.6): o que vigia, estado e quantos avisos já deu. */
export function AlertasDaMissao({ missionId }: { missionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["alertas", missionId], queryFn: () => alertasDaMissao({ data: { missionId } }) });
  const mudar = useMutation({
    mutationFn: (v: { alertId: string; status: "ativo" | "pausado" | "cancelado" }) => mudarAlerta({ data: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["alertas", missionId] });
      void qc.invalidateQueries({ queryKey: ["mensagens", missionId] });
    },
  });
  if (!q.data?.length) return null;
  return (
    <section className="mb-4 rounded-lg border border-linha bg-superficie p-4">
      <h3 className="flex items-center gap-2 font-semibold">
        <Siren size={16} aria-hidden /> Alertas desta missão
      </h3>
      <ul className="mt-2 divide-y divide-linha text-sm">
        {q.data.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <span className="font-medium">{a.regra.oQue}</span>
              <span className="block text-xs text-muted">
                {a.regra.tipo === "ausencia" ? `se não vier em ${a.regra.dias} RDO${a.regra.dias > 1 ? "s" : ""} seguidos` : "quando aparecer num RDO"} · marca {a.quem} no {a.canal} · {STATUS[a.status]} ·{" "}
                {a.disparos} aviso{a.disparos === 1 ? "" : "s"}
                {a.exemplos ? ` · ${a.exemplos} exemplo${a.exemplos === 1 ? "" : "s"} aprendido${a.exemplos === 1 ? "" : "s"}` : ""} · pedido por {a.pedidoPor}
              </span>
            </span>
            {a.podeMudar && (
              <span className="flex gap-2">
                {a.status !== "ativo" && (
                  <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate({ alertId: a.id, status: "ativo" })} className="text-floresta-texto underline">
                    {a.status === "rascunho" ? "Ativar" : "Retomar"}
                  </button>
                )}
                {a.status === "ativo" && (
                  <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate({ alertId: a.id, status: "pausado" })} className="underline">
                    Pausar
                  </button>
                )}
                <button type="button" disabled={mudar.isPending} onClick={() => mudar.mutate({ alertId: a.id, status: "cancelado" })} className="text-vermelho underline">
                  Cancelar
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
