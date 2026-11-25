import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import { CAMINHO_PROXY_IMAGEM } from "./email-html.ts";

/**
 * Proxy das imagens da internet dos e-mails (como o Outlook na web): o navegador
 * pede ao Omni, e o Omni busca a imagem. O remetente não vê o IP nem o navegador
 * de quem abre, e nenhum cookie vai junto.
 *
 * Travas (o servidor busca um endereço que veio de um e-mail):
 * - só endereços assinados pelo Omni ao montar o e-mail (HMAC), e só com sessão;
 * - só http/https nas portas 80/443; nenhum IP interno, de loopback, de link local,
 *   reservado ou de nuvem (conferido no momento da conexão, também nos redirecionamentos);
 * - até 3 redirecionamentos, 10 s e 8 MB; só imagem.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const TEMPO_MS = 10_000;
const MAX_REDIRECIONAMENTOS = 3;

const b64url = (b: Buffer) => b.toString("base64url");
const chave = (segredo: string) => createHmac("sha256", segredo).update("omni-email-imagem-v1").digest();
const assinatura = (segredo: string, url: string) => b64url(createHmac("sha256", chave(segredo)).update(url).digest()).slice(0, 32);

/** Endereço do proxy para uma imagem do e-mail. */
export function enderecoDoProxy(segredo: string, url: string): string {
  return `${CAMINHO_PROXY_IMAGEM}?u=${b64url(Buffer.from(url, "utf8"))}&s=${assinatura(segredo, url)}`;
}

/** Confere a assinatura e devolve o endereço original (ou null). */
export function urlAssinada(segredo: string, u: string | null, s: string | null): string | null {
  if (!u || !s || u.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(u) || !/^[A-Za-z0-9_-]{32}$/.test(s)) return null;
  const url = Buffer.from(u, "base64url").toString("utf8");
  const esperada = Buffer.from(assinatura(segredo, url));
  const recebida = Buffer.from(s);
  return esperada.length === recebida.length && timingSafeEqual(esperada, recebida) ? url : null;
}

// Endereços que o servidor nunca busca (rede interna, loopback, nuvem, reservados).
const BLOQUEADOS = new BlockList();
for (const [rede, prefixo] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const)
  BLOQUEADOS.addSubnet(rede, prefixo, "ipv4");
for (const [rede, prefixo] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2001:db8::", 32], ["100::", 64],
] as const)
  BLOQUEADOS.addSubnet(rede, prefixo, "ipv6");

export function ipBloqueado(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return BLOQUEADOS.check(ip, "ipv4");
  if (v === 6) {
    // IPv4 dentro do IPv6 (::ffff:10.0.0.1): confere o IPv4.
    const mapeado = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return mapeado ? BLOQUEADOS.check(mapeado, "ipv4") : BLOQUEADOS.check(ip, "ipv6");
  }
  return true;
}

/** Resolve o nome e recusa se QUALQUER endereço for bloqueado (vale na hora da conexão). */
const lookupSeguro: LookupFunction = (hostname, opcoes, cb) => {
  lookup(hostname, { ...opcoes, all: true }, (erro, enderecos) => {
    if (erro) return cb(erro, "", 4);
    const lista = enderecos as unknown as { address: string; family: number }[];
    if (!lista.length || lista.some((e) => ipBloqueado(e.address))) return cb(Object.assign(new Error("endereço bloqueado"), { code: "EBLOQUEADO" }), "", 4);
    if ((opcoes as { all?: boolean }).all) return (cb as unknown as (e: null, l: typeof lista) => void)(null, lista);
    cb(null, lista[0]!.address, lista[0]!.family);
  });
};

export type ImagemBuscada = { conteudo: Buffer; tipo: string };
export class ImagemIndisponivel extends Error {}

function urlPermitida(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !ipBloqueado(host);
  return /\./.test(host) && !/\.(local|internal|localhost|lan|home|corp)$/i.test(host) && host.toLowerCase() !== "localhost";
}

function pedir(url: URL, sinal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(
      url,
      {
        lookup: lookupSeguro,
        signal: sinal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; OmniEmailImagens/1.0)", Accept: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8" },
        agent: false,
      },
      resolve,
    );
    req.on("error", reject);
  });
}

/** Busca a imagem com as travas acima. */
export async function buscarImagem(endereco: string): Promise<ImagemBuscada> {
  const sinal = AbortSignal.timeout(TEMPO_MS);
  let url: URL;
  try {
    url = new URL(endereco);
  } catch {
    throw new ImagemIndisponivel("endereço inválido");
  }
  for (let i = 0; i <= MAX_REDIRECIONAMENTOS; i += 1) {
    if (!urlPermitida(url)) throw new ImagemIndisponivel("endereço não permitido");
    const resposta = await pedir(url, sinal).catch((e: { code?: string }) => {
      throw new ImagemIndisponivel(e?.code === "EBLOQUEADO" ? "endereço bloqueado" : "não respondeu");
    });
    const status = resposta.statusCode ?? 0;
    if (status >= 300 && status < 400 && resposta.headers.location) {
      resposta.resume();
      url = new URL(resposta.headers.location, url);
      continue;
    }
    const tipo = String(resposta.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (status !== 200 || !/^image\/[a-z0-9.+-]+$/.test(tipo)) {
      resposta.resume();
      throw new ImagemIndisponivel("não é imagem");
    }
    if (Number(resposta.headers["content-length"] ?? 0) > MAX_BYTES) {
      resposta.destroy();
      throw new ImagemIndisponivel("grande demais");
    }
    const partes: Buffer[] = [];
    let total = 0;
    try {
      for await (const parte of resposta) {
        total += (parte as Buffer).length;
        if (total > MAX_BYTES) {
          resposta.destroy();
          throw new ImagemIndisponivel("grande demais");
        }
        partes.push(parte as Buffer);
      }
    } catch (e) {
      throw e instanceof ImagemIndisponivel ? e : new ImagemIndisponivel("interrompida");
    }
    return { conteudo: Buffer.concat(partes), tipo };
  }
  throw new ImagemIndisponivel("redirecionamentos demais");
}
