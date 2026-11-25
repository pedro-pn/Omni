import { createHash } from "node:crypto";

import {
  ehUpload,
  LIMITE_GERAL_ANONIMO,
  LIMITE_GERAL_SESSAO,
  LIMITE_UPLOAD,
  Limitador,
  LIMITES_FUNCOES,
  regraDaRota,
  semLimite,
  type RegraDeLimite,
} from "@omni/core";

import { registrarErroDoWeb } from "./erros.ts";
import { clientIp, parseCookies } from "./http.ts";
import { SESSION_COOKIE } from "./session.ts";

/**
 * Limite de requisições no web (E10, pilar 10.1; regras em packages/core/src/limites.ts). Um contador
 * em memória por processo. Quem passa recebe 429 com Retry-After; o primeiro bloqueio de cada janela
 * vira erro do sistema (aviso a quem administra), sem IP nem sessão no texto (pilar 10.3).
 */
const limitador = new Limitador();

/** Sessão (resumo do cookie, não o token) ou, sem sessão, o IP. */
function chave(request: Request): { porSessao: boolean; valor: string } {
  const token = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (token) return { porSessao: true, valor: `s:${createHash("sha256").update(token).digest("base64url").slice(0, 22)}` };
  return { porSessao: false, valor: `ip:${clientIp(request) ?? "desconhecido"}` };
}

const porIp = (request: Request) => `ip:${clientIp(request) ?? "desconhecido"}`;

function avisarBloqueio(regra: RegraDeLimite): void {
  const minutos = Math.round(regra.janelaMs / 60_000);
  const erro = Object.assign(new Error(`Limite de ${regra.max} por ${minutos} min atingido; bloqueio temporário.`), { name: "LimiteExcedido", stack: undefined });
  void registrarErroDoWeb(erro, `limite ${regra.nome}`);
}

function usar(valor: string, regra: RegraDeLimite): number {
  const r = limitador.usar(valor, regra);
  if (r.ok) return 0;
  if (r.primeiroBloqueio) avisarBloqueio(regra);
  return r.esperarSegundos;
}

const recusa = (segundos: number) =>
  new Response(JSON.stringify({ error: "muitas_requisicoes", mensagem: `Muitas requisições seguidas. Tente de novo em ${segundos} s.` }), {
    status: 429,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": String(segundos), "Cache-Control": "no-store" },
  });

/** Antes de tratar a requisição: devolve a recusa 429 ou `null` para seguir. */
export function limitarRequisicao(request: Request): Response | null {
  let caminho = "/";
  try {
    caminho = new URL(request.url).pathname;
  } catch {
    return null;
  }
  if (semLimite(caminho)) return null;
  const daRota = regraDaRota(caminho);
  if (daRota) {
    const s = usar(porIp(request), daRota);
    if (s) return recusa(s);
  }
  const k = chave(request);
  if (ehUpload(request.method, caminho)) {
    const s = usar(k.valor, LIMITE_UPLOAD);
    if (s) return recusa(s);
  }
  const s = usar(k.valor, k.porSessao ? LIMITE_GERAL_SESSAO : LIMITE_GERAL_ANONIMO);
  return s ? recusa(s) : null;
}

/** Ação cara (server function pelo nome): segundos a esperar, ou 0 para seguir. */
export function limitarFuncao(nome: string | undefined, request: Request): number {
  const regras = nome ? LIMITES_FUNCOES[nome] : undefined;
  if (!regras) return 0;
  const k = chave(request);
  let esperar = 0;
  for (const regra of regras) esperar = Math.max(esperar, usar(`${k.valor}|${nome}`, regra));
  return esperar;
}
