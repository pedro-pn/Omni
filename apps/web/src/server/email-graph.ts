import type { getGraph } from "./graph.ts";

/** Peças comuns para abrir e-mails pelo Graph (e-mails da missão e caixa da pessoa). */

export const nomeEEndereco = (d: { emailAddress: { name?: string | null; address?: string | null } }) =>
  d.emailAddress.name && d.emailAddress.address ? `${d.emailAddress.name} <${d.emailAddress.address}>` : (d.emailAddress.address ?? d.emailAddress.name ?? "");

/** Imagens embutidas (cid:) como data:, com teto de tamanho para não pesar a tela. */
export async function imagensEmbutidas(
  graph: NonNullable<ReturnType<typeof getGraph>>,
  caixa: string,
  graphId: string,
  anexos: { id: string; inline: boolean; mime: string | null; contentId: string | null; tamanho: number | null }[],
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  let total = 0;
  for (const a of anexos.filter((x) => x.contentId && x.mime?.startsWith("image/")).slice(0, 20)) {
    if ((a.tamanho ?? 0) > 2_000_000 || total > 6_000_000) continue;
    try {
      const bytes = Buffer.from(await (await graph.anexo(caixa, graphId, a.id)).arrayBuffer());
      total += bytes.length;
      mapa.set(a.contentId!.toLowerCase(), `data:${a.mime};base64,${bytes.toString("base64")}`);
    } catch {
      // Imagem que não veio: o e-mail aparece sem ela.
    }
  }
  return mapa;
}
