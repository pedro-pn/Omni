/**
 * Conferência de origem contra CSRF (E16, pilar 4.3), para toda requisição que altera algo.
 *
 * O cookie de sessão é SameSite=Lax, mas Lax considera "o mesmo site" qualquer subdomínio de
 * filtrovali.com.br: uma página do staging (ou de outro app da empresa) conseguiria disparar uma ação
 * na produção com o cookie de quem estivesse logado. Aqui, POST/PUT/PATCH/DELETE só passam se vierem
 * da própria origem do Omni.
 *
 * - Com `Origin`: precisa ser igual a APP_ORIGIN.
 * - Sem `Origin` (clientes que não são navegador): recusa só se o navegador disser que veio de outro
 *   site (`Sec-Fetch-Site: cross-site` ou `same-site`). Sem cookie de navegador, não há CSRF.
 * - Rotas chamadas por servidores, cada uma com a própria credencial (chave de API, segredo no
 *   cabeçalho, assinatura do Graph, PKCE), ficam de fora.
 */

const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);

const DE_SERVIDOR = [
  "/api/v1/", // chave de API (Bearer), chamada pelo Prisma e integrações
  "/api/prisma-authorization/", // troca PKCE com o servidor do Prisma (conferência de origem própria)
  "/api/whatsapp/webhook", // Evolution, pela rede interna, com segredo no cabeçalho
  "/api/graph/avisos", // Microsoft Graph, com clientState conferido
  "/api/chamadas/eventos", // serviço de voz, pela rede interna, com chave
  "/api/csp-relatorio", // relatório de violação enviado pelo navegador (sem sessão, sem efeito)
];

export type Veredito = { ok: true } | { ok: false; motivo: string };

export function conferirOrigem(r: { metodo: string; caminho: string; origin: string | null; secFetchSite: string | null; appOrigin: string }): Veredito {
  if (METODOS_SEGUROS.has(r.metodo.toUpperCase())) return { ok: true };
  if (DE_SERVIDOR.some((p) => r.caminho === p || r.caminho.startsWith(p))) return { ok: true };
  const esperada = new URL(r.appOrigin).origin;
  if (r.origin !== null) {
    return r.origin === esperada ? { ok: true } : { ok: false, motivo: r.origin === "null" ? "origem nula" : "outra origem" };
  }
  if (r.secFetchSite === "cross-site" || r.secFetchSite === "same-site") return { ok: false, motivo: `sem Origin e Sec-Fetch-Site ${r.secFetchSite}` };
  return { ok: true };
}
