import { readFileSync } from "node:fs";

import { GraphClient } from "@omni/integrations/graph";

import { getEnv } from "./env.ts";

let cliente: GraphClient | null | undefined;

/** Cliente do Graph do app "Omni – Integrações"; `null` enquanto não estiver configurado. */
export function getGraph(): GraphClient | null {
  if (cliente !== undefined) return cliente;
  const env = getEnv();
  if (!env.GRAPH_TENANT_ID || !env.GRAPH_CLIENT_ID || !env.GRAPH_PRIVATE_KEY_PATH || !env.GRAPH_CERT_SHA256_THUMBPRINT) {
    cliente = null;
    return cliente;
  }
  cliente = new GraphClient({
    tenantId: env.GRAPH_TENANT_ID,
    clientId: env.GRAPH_CLIENT_ID,
    privateKeyPem: readFileSync(env.GRAPH_PRIVATE_KEY_PATH, "utf8"),
    thumbprintSha256: env.GRAPH_CERT_SHA256_THUMBPRINT,
  });
  return cliente;
}
