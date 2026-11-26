import { buscarComTravas } from "./email-imagem.ts";

/**
 * Prévia dos links das mensagens do WhatsApp (título, descrição, imagem e site), como no
 * WhatsApp Web. A página é buscada pelo servidor com as travas do proxy de imagens (nada da rede
 * interna, tempo e tamanho limitados; só o começo do HTML) e guardada em memória por 24 h.
 */

export type PreviaDeLink = { url: string; titulo: string; descricao: string | null; imagem: string | null; site: string };

const MAX_HTML = 512 * 1024;
const VALIDADE_MS = 24 * 3600_000;
const cache = new Map<string, { em: number; previa: PreviaDeLink | null }>();

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodificar = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n: string) => ENTIDADES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .trim();

/** Lê as meta tags (Open Graph, Twitter e as comuns) do começo de uma página. */
export function metadadosDaPagina(html: string, endereco: string): PreviaDeLink | null {
  const cabeca = html.slice(0, MAX_HTML);
  const meta = (chaves: string[]) => {
    for (const tag of cabeca.match(/<meta\b[^>]*>/gi) ?? []) {
      const nome = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
      const conteudo = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
      if (nome && conteudo && chaves.includes(nome)) return decodificar(conteudo);
    }
    return null;
  };
  const titulo = meta(["og:title", "twitter:title"]) ?? (cabeca.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1] ? decodificar(cabeca.match(/<title[^>]*>([^<]{1,300})<\/title>/i)![1]!) : null);
  if (!titulo) return null;
  const url = new URL(endereco);
  let imagem = meta(["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  try {
    imagem = imagem ? new URL(imagem, url).toString() : null;
    if (imagem && !/^https?:/.test(imagem)) imagem = null;
  } catch {
    imagem = null;
  }
  return {
    url: url.toString(),
    titulo: titulo.slice(0, 200),
    descricao: (meta(["og:description", "twitter:description", "description"]) ?? "").slice(0, 300) || null,
    imagem,
    site: (meta(["og:site_name"]) ?? url.hostname.replace(/^www\./, "")).slice(0, 80),
  };
}

export async function previaDoEndereco(endereco: string): Promise<PreviaDeLink | null> {
  const guardada = cache.get(endereco);
  if (guardada && Date.now() - guardada.em < VALIDADE_MS) return guardada.previa;
  let previa: PreviaDeLink | null = null;
  try {
    const r = await buscarComTravas(endereco, { aceita: (t) => t === "text/html" || t === "application/xhtml+xml", maxBytes: MAX_HTML, accept: "text/html,application/xhtml+xml;q=0.9" });
    previa = metadadosDaPagina(r.conteudo.toString("utf8"), endereco);
  } catch {
    previa = null;
  }
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  cache.set(endereco, { em: Date.now(), previa });
  return previa;
}
