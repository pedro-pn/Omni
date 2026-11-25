import { Mail, Paperclip } from "lucide-react";

import type { EmailDoContato } from "../../lib/unica-fns.ts";

const TZ = { timeZone: "America/Sao_Paulo" } as const;

/** E-mail na linha do tempo do contato (ao lado das mensagens do WhatsApp): só o cabeçalho e a prévia. */
export function CartaoEmail({ e, onAbrir }: { e: EmailDoContato; onAbrir: (graphId: string) => void }) {
  const enviado = e.pasta === "sentitems";
  return (
    <div className={`flex ${enviado ? "justify-end" : "justify-start"}`}>
      <button
        type="button"
        onClick={() => onAbrir(e.graphId)}
        title="Abrir o e-mail"
        className={`w-full max-w-[min(32rem,85%)] rounded-lg border px-3 py-2 text-left shadow-sm hover:brightness-95 ${
          enviado ? "border-azul/40 bg-superficie" : "border-linha bg-superficie"
        } ${!e.lido ? "ring-2 ring-azul/60" : ""}`}
      >
        <span className="flex items-center gap-1.5 text-xs text-muted">
          <Mail size={14} aria-hidden className="text-azul" />
          <span className="truncate">{enviado ? `E-mail enviado para ${e.para.join(", ") || "—"}` : `E-mail de ${e.de ?? "—"}`}</span>
          {e.anexos && <Paperclip size={13} aria-label="Com anexo" />}
        </span>
        <span className={`mt-0.5 block truncate ${e.lido ? "font-medium" : "font-semibold"}`}>{e.assunto || "(sem assunto)"}</span>
        {e.previa && <span className="line-clamp-2 text-sm text-muted">{e.previa}</span>}
        <span className="mt-1 block text-right text-[11px] text-muted">
          {new Date(e.em).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ...TZ })}
        </span>
      </button>
    </div>
  );
}
