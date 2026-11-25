import { FiltroAppClient } from "@omni/integrations/filtroapp";

import { getEnv } from "./env.ts";

/** Cliente do filtroAPP no servidor web, só para buscar documentos (PDF dos relatórios). Escrita nunca passa por aqui. */
let cliente: FiltroAppClient | null | undefined;

export function filtroAppDocumentos(): FiltroAppClient | null {
  if (cliente !== undefined) return cliente;
  const env = getEnv();
  cliente = env.FILTROAPP_API_TOKEN ? new FiltroAppClient({ baseUrl: env.FILTROAPP_API_URL, token: env.FILTROAPP_API_TOKEN, escrita: "desligada" }) : null;
  return cliente;
}
