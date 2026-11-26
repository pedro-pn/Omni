import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";

import { previaDeLink } from "../../lib/conversas-fns.ts";
import type { Mencao } from "../../lib/nomes-whatsapp.ts";

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

const MENCAO = /@(\d{5,20})\b/g;

/** O texto em pedaços: texto puro e marcações conhecidas ("@<chave>" de uma das menções). */
export function pedacosComMencoes(texto: string, mencoes: Mencao[] | undefined): Array<string | Mencao> {
  if (!mencoes?.length) return [texto];
  const porChave = new Map(mencoes.map((m) => [m.chave, m]));
  const r: Array<string | Mencao> = [];
  let ultimo = 0;
  for (const x of texto.matchAll(MENCAO)) {
    const m = porChave.get(x[1]!);
    if (!m) continue;
    if (x.index > ultimo) r.push(texto.slice(ultimo, x.index));
    r.push(m);
    ultimo = x.index + x[0].length;
  }
  if (ultimo < texto.length) r.push(texto.slice(ultimo));
  return r;
}

export function TextoComLinks({
  texto,
  deMim,
  mencoes,
  onMencao,
}: {
  texto: string;
  deMim: boolean;
  mencoes?: Mencao[];
  /** Clique numa marcação com telefone: abrir a conversa com a pessoa. */
  onMencao?: (m: Mencao) => void;
}) {
  return (
    <p className="whitespace-pre-wrap break-words">
      {pedacosComMencoes(texto, mencoes).map((p, j) =>
        typeof p === "string" ? (
          <Fragment key={j}>
            <ComLinks texto={p} deMim={deMim} />
          </Fragment>
        ) : p.telefone && onMencao ? (
          <button
            key={j}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMencao(p);
            }}
            title={`Conversar com ${p.nome}`}
            className={`font-semibold hover:underline ${deMim ? "text-white" : "text-azul"}`}
          >
            @{p.nome}
          </button>
        ) : (
          <span key={j} className={`font-semibold ${deMim ? "text-white" : "text-azul"}`}>
            @{p.nome}
          </span>
        ),
      )}
    </p>
  );
}

function ComLinks({ texto, deMim }: { texto: string; deMim: boolean }) {
  const partes = texto.split(LINK);
  return (
    <>
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
    </>
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
