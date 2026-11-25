import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";

import { SCRIPT_INICIAL } from "../lib/script-inicial.ts";

/**
 * Cabeçalhos de segurança das páginas (E12, pilar 6.5): CSP com nonce por requisição e
 * Permissions-Policy. HSTS, nosniff e X-Frame-Options ficam no Caddy (deploy/caddy/omni.caddy).
 *
 * - Scripts: só os do próprio Omni (/assets), os que o TanStack injeta com o nonce desta requisição
 *   (router.tsx lê por `nonceDaRequisicao`) e o script inicial (tema e Zod sem eval) pelo hash.
 * - Estilos: 'unsafe-inline' (React usa `style={...}` e os e-mails trazem <style> no quadro isolado,
 *   que herda a política). Não executa código.
 * - Imagens, áudio e PDF: do próprio Omni, `data:` e `blob:` (prévias, voz gravada, anexos).
 * - Conexões: o próprio Omni (inclui o WebSocket do áudio das chamadas em /omni/audio).
 *
 * CSP_MODO=relatorio (padrão) só relata (Content-Security-Policy-Report-Only) para
 * /api/csp-relatorio, que vira erro do sistema; CSP_MODO=aplicar bloqueia de verdade.
 */

const contexto = new AsyncLocalStorage<{ nonce: string }>();

const hashDoScriptInicial = `'sha256-${createHash("sha256").update(SCRIPT_INICIAL).digest("base64")}'`;

export function politicaCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${hashDoScriptInicial}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/csp-relatorio",
  ].join("; ");
}

/** Recursos do aparelho: só o microfone (voz e chamadas), e só para o próprio Omni. */
export const PERMISSIONS_POLICY = "camera=(), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), midi=(), display-capture=(), interest-cohort=()";

export function novoNonce(): string {
  return randomBytes(16).toString("base64");
}

/** Roda o tratamento da requisição com o nonce dela disponível para o router. */
export function comNonce<T>(nonce: string, fn: () => Promise<T>): Promise<T> {
  return contexto.run({ nonce }, fn);
}

export function nonceDaRequisicao(): string | undefined {
  return contexto.getStore()?.nonce;
}

// O router é o mesmo código no servidor e no navegador: no servidor ele lê o nonce por aqui,
// sem importar este módulo (node:async_hooks não vai para o navegador).
(globalThis as { __omniNonce?: () => string | undefined }).__omniNonce = nonceDaRequisicao;

export function cabecalhoCsp(modo: "relatorio" | "aplicar"): string {
  return modo === "aplicar" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}
