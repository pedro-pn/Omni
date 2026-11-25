import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Send } from "lucide-react";

import { noPrisma, registrarNoPrisma } from "../../lib/prisma-fase6-fns.ts";

/**
 * Bloco "No Prisma" (contrato 1.67.0): o contato no Prisma, a empresa, as
 * oportunidades abertas e os últimos feedbacks. Só para quem vê dados
 * comerciais; sem acesso ou sem credencial, não aparece.
 */
export function NoPrismaInfo({ email, telefone, compacto = false }: { email?: string | null; telefone?: string | null; compacto?: boolean }) {
  const q = useQuery({
    queryKey: ["no-prisma", email ?? null, telefone ?? null],
    queryFn: () => noPrisma({ data: { ...(email ? { email } : {}), ...(telefone ? { telefone } : {}) } }),
    enabled: Boolean(email || telefone),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!q.data?.podeVer) return null;
  const quando = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("pt-BR") : "");
  return (
    <div className={`rounded-md bg-superficie-2 text-sm ${compacto ? "p-2" : "p-3"}`}>
      <p className="rotulo text-muted">No Prisma</p>
      {!q.data.contatos.length && <p className="text-muted">Não há contato com este {email ? "e-mail" : "telefone"} no Prisma.</p>}
      {q.data.ambiguo && <p className="text-xs text-vermelho">Há mais de um contato com este {email ? "e-mail" : "telefone"} no Prisma.</p>}
      {q.data.contatos.map((c) => (
        <div key={c.id} className="mt-1 space-y-1">
          <p className="font-medium">
            {c.nome ?? "Sem nome"}
            {(c.cargo || c.empresa) && <span className="font-normal text-muted"> · {[c.cargo, c.empresa].filter(Boolean).join(" · ")}</span>}
          </p>
          {c.oportunidades.length > 0 && (
            <p className="text-xs">
              <span className="text-muted">Oportunidades abertas: </span>
              {c.oportunidades.map((o) => o.titulo ?? o.id).join(" · ")}
            </p>
          )}
          {c.feedbacks.length > 0 && (
            <ul className="space-y-0.5 text-xs">
              {c.feedbacks.slice(0, compacto ? 2 : 5).map((f) => (
                <li key={f.id} className="truncate" title={f.texto}>
                  <span className="text-muted">{[quando(f.quando), f.autor].filter(Boolean).join(" · ")}:</span> {f.texto}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

/** "Registrar no Prisma": a ligação ou o e-mail vira feedback em nome de quem clicou (não duplica). */
export function RegistrarNoPrisma(props: { origem: "chamada"; id: string } | { origem: "email"; id: string; missionId: string }) {
  const r = useMutation({ mutationFn: () => registrarNoPrisma({ data: props }) });
  if (r.isSuccess) {
    return (
      <span className="flex items-center gap-1 text-xs text-floresta-texto">
        <Check size={14} aria-hidden /> {r.data.jaRegistrado ? "Já estava registrado no Prisma" : "Registrado no Prisma"}
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={r.isPending}
        onClick={() => r.mutate()}
        title="Vira um feedback no Prisma, no contato, em seu nome"
        className="flex items-center gap-1.5 rounded-md border border-linha bg-superficie px-2.5 py-1 text-xs font-medium hover:bg-superficie-2"
      >
        <Send size={14} aria-hidden /> {r.isPending ? "Registrando…" : "Registrar no Prisma"}
      </button>
      {r.isError && <span className="text-xs text-vermelho">{r.error instanceof Error ? r.error.message : "Não foi possível registrar."}</span>}
    </span>
  );
}
