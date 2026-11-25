import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { vincularContato } from "../../lib/unica-fns.ts";

/**
 * Liga um e-mail e um telefone no mesmo contato da agenda da empresa (0067).
 * Abre a partir do e-mail (pede o telefone) ou da conversa do WhatsApp (pede o e-mail).
 */
export function VincularContato({
  nome: nomeInicial,
  email,
  telefone,
  contatoId,
  fechar,
}: {
  nome: string;
  /** Já conhecido (a partir do e-mail): pede o telefone. */
  email?: string | null;
  /** Já conhecido (a partir do WhatsApp): pede o e-mail. */
  telefone?: string | null;
  contatoId?: string | null;
  fechar: () => void;
}) {
  const qc = useQueryClient();
  const pedeTelefone = !telefone;
  const [nome, setNome] = useState(nomeInicial);
  const [empresa, setEmpresa] = useState("");
  const [valor, setValor] = useState("");
  const salvar = useMutation({
    mutationFn: () =>
      vincularContato({
        data: {
          contatoId: contatoId ?? undefined,
          nome,
          empresa: empresa || undefined,
          emails: [email, pedeTelefone ? null : valor].filter((x): x is string => Boolean(x)),
          telefones: [telefone, pedeTelefone ? valor : null].filter((x): x is string => Boolean(x)),
        },
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["unica"] });
      fechar();
    },
  });
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [fechar]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-vincular"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12dvh]"
      onClick={(e) => e.target === e.currentTarget && fechar()}
    >
      <form
        className="w-full max-w-md space-y-3 rounded-lg bg-superficie p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (valor.trim() && nome.trim()) salvar.mutate();
        }}
      >
        <div className="flex items-center justify-between">
          <h2 id="titulo-vincular" className="text-lg font-semibold">
            {pedeTelefone ? "Vincular telefone" : "Vincular e-mail"}
          </h2>
          <button type="button" onClick={fechar} aria-label="Fechar" className="rounded-md p-1.5 hover:bg-superficie-2">
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-muted">
          {pedeTelefone ? `E-mail: ${email}` : `Telefone: ${telefone}`}. O e-mail e o WhatsApp deste contato passam a aparecer juntos, para todos do Omni que
          falam com ele.
        </p>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">{pedeTelefone ? "Telefone (com DDD)" : "E-mail"}</span>
          <input
            autoFocus
            required
            type={pedeTelefone ? "tel" : "email"}
            inputMode={pedeTelefone ? "tel" : "email"}
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            placeholder={pedeTelefone ? "47 99999-0000" : "nome@empresa.com.br"}
            className="w-full rounded-md border border-linha bg-superficie px-3 py-2"
          />
        </label>
        {!contatoId && (
          <>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Nome</span>
              <input required value={nome} onChange={(e) => setNome(e.target.value)} className="w-full rounded-md border border-linha bg-superficie px-3 py-2" />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="font-medium">Empresa (opcional)</span>
              <input value={empresa} onChange={(e) => setEmpresa(e.target.value)} className="w-full rounded-md border border-linha bg-superficie px-3 py-2" />
            </label>
          </>
        )}
        {salvar.isError && (
          <p role="alert" className="text-sm text-vermelho">
            {salvar.error.message}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={fechar} className="rounded-md border border-linha px-3 py-1.5 text-sm hover:bg-superficie-2">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={salvar.isPending}
            className="flex items-center gap-1.5 rounded-md bg-floresta px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60"
          >
            <Link2 size={16} aria-hidden /> {salvar.isPending ? "Vinculando…" : "Vincular"}
          </button>
        </div>
      </form>
    </div>
  );
}
