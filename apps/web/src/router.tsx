import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/** No servidor, o nonce da CSP desta requisição (apps/web/src/server/csp.ts); no navegador, nada. */
const nonce = () => (typeof window === "undefined" ? (globalThis as { __omniNonce?: () => string | undefined }).__omniNonce?.() : undefined);

export function getRouter() {
  const queryClient = new QueryClient();
  return createRouter({
    routeTree,
    ssr: { nonce: nonce() },
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
