import { useState } from "react";

/**
 * Quem enviou, nos grupos (como no WhatsApp Web): cada pessoa com uma cor fixa (pelo identificador
 * no WhatsApp) no nome e, na primeira mensagem de uma sequência, a foto (ou as iniciais na cor).
 */

// Tons que se leem no balão claro e no escuro.
const CORES = ["#d9414f", "#e56b1f", "#c48a00", "#4c9a2a", "#0f9d74", "#0a8f9e", "#1f7ae0", "#5b5fe0", "#8e44c9", "#c03ca0", "#d1477a", "#7b6f00", "#2f8f4e", "#3b6fd6", "#a34fd1", "#c25b2f"];

export function corDoAutor(id: string | null | undefined): string {
  const s = id ?? "";
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return CORES[h % CORES.length]!;
}

const iniciais = (nome: string | null) =>
  (nome ?? "?")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("") || "?";

export function FotoDoAutor({ chatId, autorId, nome }: { chatId: string; autorId: string | null | undefined; nome: string | null }) {
  const [semFoto, setSemFoto] = useState(false);
  const cor = corDoAutor(autorId ?? nome);
  const temId = Boolean(autorId && /^\d{6,20}@(s\.whatsapp\.net|lid)$/.test(autorId));
  return (
    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white" style={{ backgroundColor: cor }} aria-hidden>
      {temId && !semFoto ? (
        <img
          src={`/api/whatsapp/foto-participante/${chatId}?p=${encodeURIComponent(autorId!)}`}
          alt=""
          loading="lazy"
          onError={() => setSemFoto(true)}
          className="size-full object-cover"
        />
      ) : (
        iniciais(nome)
      )}
    </span>
  );
}
