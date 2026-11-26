import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";

import { previaDeLink } from "../../lib/conversas-fns.ts";

/** Links nas mensagens do WhatsApp: clicáveis (abrem em outra aba) e, o primeiro, com prévia, como no WhatsApp Web. */

const LINK = /\b((?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]}'"])/gi;
const endereco = (bruto: string) => (/^www\./i.test(bruto) ? `https://${bruto}` : bruto);

/** Primeiro link do texto (para a prévia), já com https:// quando começa por www. */
export function primeiroLink(texto: string | null): string | null {
  const m = texto?.match(LINK)?.[0];
  if (!m) return null;
  try {
    const u = new URL(endereco(m));
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function TextoComLinks({ texto, deMim }: { texto: string; deMim: boolean }) {
  const partes = texto.split(LINK);
  return (
    <p className="whitespace-pre-wrap break-words">
      {partes.map((p, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={endereco(p)}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={`underline underline-offset-2 ${deMim ? "text-white" : "text-azul"} break-all`}
          >
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </p>
  );
}

export function PreviaDoLink({ url, deMim }: { url: string; deMim: boolean }) {
  const q = useQuery({ queryKey: ["whatsapp", "link-previa", url], queryFn: () => previaDeLink({ data: { url } }), staleTime: Infinity, gcTime: 3600_000, retry: false });
  const p = q.data;
  if (!p) return null;
  return (
    <a
      href={p.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className={`mb-1 block overflow-hidden rounded-md ${deMim ? "bg-black/15" : "bg-superficie-2"} hover:opacity-90`}
    >
      {p.imagem && <img src={p.imagem} alt="" loading="lazy" className="max-h-48 w-full object-cover" />}
      <span className="block px-2.5 py-2">
        <span className="line-clamp-2 block text-[13px] font-semibold">{p.titulo}</span>
        {p.descricao && <span className={`mt-0.5 line-clamp-2 block text-xs ${deMim ? "text-white/80" : "text-muted"}`}>{p.descricao}</span>}
        <span className={`mt-0.5 block text-[11px] ${deMim ? "text-white/70" : "text-muted"}`}>{p.site}</span>
      </span>
    </a>
  );
}
