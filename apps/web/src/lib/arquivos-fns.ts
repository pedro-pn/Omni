import { withPerson } from "@omni/db";
import type { ItemDrive } from "@omni/integrations/graph";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getPool } from "../server/db.ts";
import { erroDoGraph, pastaAutorizada } from "../server/arquivos.ts";
import { getGraph } from "../server/graph.ts";
import { personIdFromRequest } from "../server/session.ts";
import { ErroParaTela } from "./erros.ts";

/**
 * Arquivos da missão: pastas comerciais do SharePoint pelos vínculos do Prisma
 * (migration 0020). O navegador só manda o id da referência e o id do item;
 * o servidor confere a pessoa no banco (app.pasta_para_leitura) e, no Graph,
 * que o item está dentro da pasta autorizada. Nada de caminho textual.
 */

export type PastaVinculada = {
  id: string;
  origem: "mission" | "opportunity";
  rotulo: string;
  webUrl: string | null;
  status: "ready" | "configuration_required";
};

export type ArquivosDaMissao = { daMissao: PastaVinculada[]; doCliente: PastaVinculada[]; graphConfigurado: boolean };

export type ConteudoPasta = {
  pasta: { id: string; rotulo: string; webUrl: string | null };
  caminho: { id: string; nome: string }[];
  itens: ItemDrive[];
};

async function pessoa(): Promise<string> {
  const id = await personIdFromRequest(getRequest());
  if (!id) throw new ErroParaTela("Sessão expirada. Entre de novo.");
  return id;
}

export const listarArquivosDaMissao = createServerFn({ method: "GET" })
  .validator(z.object({ missionId: z.uuid() }))
  .handler(async ({ data }): Promise<ArquivosDaMissao> => {
    const personId = await pessoa();
    return withPerson(getPool(), personId, async (db) => {
      type Linha = { id: string; origem: PastaVinculada["origem"]; rotulo: string; web_url: string | null; status: PastaVinculada["status"] };
      const mapa = (l: Linha): PastaVinculada => ({ id: l.id, origem: l.origem, rotulo: l.rotulo, webUrl: l.web_url, status: l.status });
      const daMissao = (await db.execute<Linha>(sql`SELECT * FROM app.pastas_da_missao(${data.missionId}::uuid)`)).rows.map(mapa);
      const doCliente = (await db.execute<Linha>(sql`SELECT * FROM app.pastas_do_cliente(${data.missionId}::uuid)`)).rows.map(mapa);
      return { daMissao, doCliente, graphConfigurado: getGraph() !== null };
    });
  });

const idGraph = z.string().regex(/^[A-Za-z0-9!_.,-]{1,300}$/);

export const abrirPasta = createServerFn({ method: "GET" })
  .validator(z.object({ pastaId: z.uuid(), itemId: idGraph.optional() }))
  .handler(async ({ data }): Promise<ConteudoPasta> => {
    const personId = await pessoa();
    const graph = getGraph();
    if (!graph) throw new ErroParaTela("A leitura do SharePoint ainda não foi configurada no Omni.");
    const p = await pastaAutorizada(personId, data.pastaId);
    try {
      const alvo = data.itemId ?? p.folderId;
      const caminho = alvo === p.folderId ? null : await graph.caminhoDentro(p.driveId, p.folderId, alvo);
      if (alvo !== p.folderId && !caminho) throw new ErroParaTela("Esta pasta não faz parte das pastas vinculadas.");
      const itens = await graph.listarFilhos(p.driveId, alvo);
      return {
        pasta: { id: data.pastaId, rotulo: p.rotulo, webUrl: p.webUrl },
        // A raiz aparece pelo rótulo do vínculo; o resto, pelos nomes no SharePoint.
        caminho: (caminho ?? [{ id: p.folderId, nome: p.rotulo }]).map((c, i) => (i === 0 ? { id: c.id, nome: p.rotulo } : c)),
        itens,
      };
    } catch (error) {
      if (error instanceof ErroParaTela) throw error;
      return erroDoGraph(error);
    }
  });
