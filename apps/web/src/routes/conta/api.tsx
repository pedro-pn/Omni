import { createFileRoute, redirect } from "@tanstack/react-router";

import { ChavesApi } from "../../components/conta/ChavesApi.tsx";
import { getMe } from "../../lib/session-fns.ts";

export const Route = createFileRoute("/conta/api")({
  beforeLoad: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar", search: { volta: "/conta/api" } });
    if (me.termosPendentes) throw redirect({ to: "/termos", search: { volta: "/conta/api" } });
    return { me };
  },
  head: () => ({ meta: [{ title: "API e automações · Omni" }] }),
  component: () => <ChavesApi />,
});
