import { createFileRoute } from "@tanstack/react-router";

import { getPool } from "../../server/db.ts";
import { getEnv } from "../../server/env.ts";

/** Verificação de saúde para o Caddy/monitoramento. Não expõe nada sensível. */
export const Route = createFileRoute("/api/saude")({
  server: {
    handlers: {
      GET: async () => {
        // Variável recusada: o log diz quais (só os nomes, nunca os valores); a resposta não.
        try {
          getEnv();
        } catch (error) {
          console.error("[saude]", (error as Error).message);
          return Response.json({ status: "configuracao_invalida" }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
        let banco = "ok";
        try {
          await getPool().query("SELECT 1");
        } catch (error) {
          banco = "falha";
          console.error("[saude] banco indisponível:", (error as Error).message);
        }
        // Commit publicado (deploy/publicar.sh confere que a versão nova está no ar).
        const versao = process.env.OMNI_VERSAO || "desconhecida";
        return Response.json(
          { status: banco === "ok" ? "ok" : "degradado", banco, versao },
          { status: banco === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  },
});
