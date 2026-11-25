import { schema, withPerson } from "@omni/db";
import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";

import { getPool } from "../../../../server/db.ts";
import { filtroAppDocumentos } from "../../../../server/filtroapp.ts";
import { personIdFromRequest } from "../../../../server/session.ts";
import { registrarDownload } from "../../../../server/downloads.ts";

/**
 * PDF de um RDO ou relatório técnico (spec 038 do filtroAPP). Só para quem vê a
 * missão (RLS de `reports`, app.ve_missao); o arquivo vem do filtroAPP na hora e
 * não fica no Omni. RDO de manutenção: o documento de manutenção ligado (?anexo=).
 * `?baixar=1` baixa; sem ele, abre no navegador.
 */
const texto = (status: number, mensagem: string, extra: Record<string, string> = {}) =>
  new Response(mensagem, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

const nomeSeguro = (nome: string) => nome.replace(/[\r\n"\\/]/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "relatorio.pdf";

export const Route = createFileRoute("/api/relatorios/$id/pdf")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const me = await personIdFromRequest(request);
        if (!me) return texto(401, "Entre no Omni para ver o relatório.");
        const fonte = filtroAppDocumentos();
        if (!fonte) return texto(503, "O PDF dos relatórios não está configurado neste ambiente.");
        const [r] = await withPerson(getPool(), me, (db) =>
          db
            .select({ id: schema.reports.id, tipo: schema.reports.reportType, nome: schema.reports.pdfNome, anexos: schema.reports.pdfAnexosManutencao })
            .from(schema.reports)
            .where(eq(schema.reports.id, params.id)),
        );
        if (!r) return texto(404, "Relatório não encontrado.");
        const url = new URL(request.url);
        let resposta: Response;
        try {
          if (r.tipo === "RDO_MAINTENANCE") {
            const pedido = url.searchParams.get("anexo");
            const anexo = pedido && r.anexos.includes(pedido) ? pedido : r.anexos[0];
            if (!anexo) return texto(404, "Este RDO de manutenção ainda não tem documento no filtroAPP.");
            resposta = await fonte.arquivo("manutencao", anexo);
          } else {
            resposta = await fonte.arquivo("relatorio", r.id);
          }
        } catch {
          return texto(502, "Não foi possível falar com o filtroAPP agora. Tente de novo em instantes.");
        }
        if (resposta.status === 409) {
          return texto(409, "O PDF deste relatório ainda não está pronto no filtroAPP. Tente de novo em alguns minutos.", { "Retry-After": resposta.headers.get("retry-after") ?? "30" });
        }
        if (resposta.status === 404) return texto(404, "O filtroAPP não tem PDF para este relatório.");
        if (resposta.status === 413) return texto(413, "O PDF é grande demais para abrir pelo Omni. Abra no filtroAPP.");
        if (resposta.status === 403) return texto(403, "O token do Omni no filtroAPP não tem acesso a este documento.");
        if (!resposta.ok || !resposta.body) return texto(502, "O filtroAPP não devolveu o PDF.");
        const nome = nomeSeguro(r.nome ?? `${r.tipo} ${r.id}.pdf`);
        const headers = new Headers({
          "Content-Type": "application/pdf",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Disposition": `${url.searchParams.get("baixar") === "1" ? "attachment" : "inline"}; filename="relatorio.pdf"; filename*=UTF-8''${encodeURIComponent(nome)}`,
        });
        const tamanho = resposta.headers.get("content-length");
        if (tamanho) headers.set("Content-Length", tamanho);
        await registrarDownload(request, me, "relatorio_pdf", params.id);
        return new Response(resposta.body, { status: 200, headers });
      },
    },
  },
});
