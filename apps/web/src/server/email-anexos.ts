import type { AnexoParaEnviar } from "@omni/integrations/graph";
import { z } from "zod";

import { ErroParaTela } from "../lib/erros.ts";

/**
 * Anexos dos e-mails enviados pelo Omni. Vão no próprio pedido ao Graph (com a
 * permissão só de envio não há rascunho nem upload em partes), e o Graph aceita até
 * 4 MB por pedido: até 3 MB de anexos no total. Executáveis e scripts são recusados
 * (o próprio Outlook bloqueia ao receber). O conteúdo não fica no Omni.
 */

export const MAX_ANEXOS_BYTES = 3 * 1024 * 1024;
const BLOQUEADOS = /\.(exe|bat|cmd|com|scr|msi|msp|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|lnk|reg|dll)$/i;

export const anexosSchema = z
  .array(
    z.object({
      nome: z.string().trim().min(1).max(200),
      tipo: z.string().trim().max(150).default("application/octet-stream"),
      base64: z.string().max(Math.ceil((MAX_ANEXOS_BYTES * 4) / 3) + 8),
    }),
  )
  .max(10, "Até 10 anexos por e-mail.")
  .default([]);

export function lerAnexos(lista: z.infer<typeof anexosSchema>): { anexos: AnexoParaEnviar[]; registro: { nome: string; tipo: string; tamanho: number }[] } {
  let total = 0;
  const anexos = lista.map((a) => {
    const nome = a.nome.replace(/[\x00-\x1f\x7f/\\]/g, "_");
    if (BLOQUEADOS.test(nome)) throw new ErroParaTela(`O anexo "${nome}" não pode ser enviado (programas e scripts são bloqueados).`);
    const conteudo = Buffer.from(a.base64, "base64");
    if (!conteudo.length) throw new ErroParaTela(`O anexo "${nome}" está vazio.`);
    total += conteudo.length;
    const tipo = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(a.tipo) ? a.tipo.toLowerCase() : "application/octet-stream";
    return { nome, tipo, conteudo };
  });
  if (total > MAX_ANEXOS_BYTES) throw new ErroParaTela("Anexos grandes demais: até 3 MB no total por e-mail. Para arquivos maiores, use um link do SharePoint.");
  return { anexos, registro: anexos.map((a) => ({ nome: a.nome, tipo: a.tipo, tamanho: a.conteudo.length })) };
}
