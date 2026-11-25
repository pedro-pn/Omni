import { createFileRoute } from "@tanstack/react-router";

import { registrarErroDoWeb } from "../../server/erros.ts";

/**
 * Relatórios de violação da CSP (E12): o navegador manda o que bloqueou (ou bloquearia, em
 * CSP_MODO=relatorio). Vira erro do sistema agrupado pela diretiva e pela origem bloqueada; nada do
 * endereço além da origem (sem caminho nem query) e nada de quem estava na tela. Público (o navegador
 * não manda sessão de forma confiável), pequeno e sujeito ao limite geral de requisições.
 */
type Violacao = { diretiva: string; bloqueado: string };

function origemDe(valor: unknown): string {
  if (typeof valor !== "string" || !valor) return "(desconhecido)";
  if (["inline", "eval", "self", "data", "blob", "wasm-eval", "trusted-types-policy"].includes(valor)) return valor;
  try {
    const u = new URL(valor);
    return u.protocol === "data:" || u.protocol === "blob:" ? u.protocol.slice(0, -1) : `${u.protocol}//${u.host}`;
  } catch {
    return valor.slice(0, 40);
  }
}

function violacoes(corpo: unknown): Violacao[] {
  // Formato antigo (report-uri): { "csp-report": { "effective-directive", "blocked-uri" } }.
  const antigo = (corpo as { "csp-report"?: Record<string, unknown> })?.["csp-report"];
  if (antigo) return [{ diretiva: String(antigo["effective-directive"] ?? antigo["violated-directive"] ?? "?"), bloqueado: origemDe(antigo["blocked-uri"]) }];
  // Reporting API: [{ type: "csp-violation", body: { effectiveDirective, blockedURL } }].
  if (Array.isArray(corpo)) {
    return corpo
      .filter((r) => r?.type === "csp-violation" && r.body)
      .slice(0, 20)
      .map((r) => ({ diretiva: String(r.body.effectiveDirective ?? "?"), bloqueado: origemDe(r.body.blockedURL) }));
  }
  return [];
}

export const Route = createFileRoute("/api/csp-relatorio")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const texto = await request.text();
        if (texto.length > 16_384) return new Response(null, { status: 413 });
        let corpo: unknown;
        try {
          corpo = JSON.parse(texto);
        } catch {
          return new Response(null, { status: 400 });
        }
        for (const v of violacoes(corpo)) {
          const diretiva = v.diretiva.replace(/[^a-z-]/gi, "").slice(0, 40) || "?";
          const erro = Object.assign(new Error(`CSP bloquearia ${v.bloqueado} em ${diretiva}`), { name: "CSP", stack: undefined });
          await registrarErroDoWeb(erro, `csp ${diretiva} ${v.bloqueado}`.slice(0, 200));
        }
        return new Response(null, { status: 204 });
      },
    },
  },
});
