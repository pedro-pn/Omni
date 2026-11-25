import { caminhoDeVolta } from "@omni/core";
import { createFileRoute, redirect, useLocation } from "@tanstack/react-router";

import { ConsentimentoPrisma } from "../components/conta/ConsentimentoPrisma.tsx";
import { AppShell } from "../components/shell/AppShell.tsx";
import { getMe } from "../lib/session-fns.ts";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ location }) => {
    const me = await getMe();
    if (!me) {
      // Volta para o mesmo endereço depois do login (consentimento do Prisma, link de tarefa).
      const volta = caminhoDeVolta(`${location.pathname}${location.searchStr}`);
      throw redirect({ to: "/entrar", search: volta === "/" ? {} : { volta } });
    }
    // Termo de uso (LGPD) da versão atual ainda não aceito: primeiro a página do termo.
    if (me.termosPendentes) {
      const volta = caminhoDeVolta(`${location.pathname}${location.searchStr}`);
      throw redirect({ to: "/termos", search: volta === "/" ? {} : { volta } });
    }
    return { me };
  },
  component: Inicio,
});

function Inicio() {
  const { me } = Route.useRouteContext();
  const { searchStr } = useLocation();
  // Mesmo endereço do Foco para o consentimento do Prisma.
  if (new URLSearchParams(searchStr).get("integracao") === "prisma") return <ConsentimentoPrisma me={me} busca={searchStr} />;
  return <AppShell me={me} />;
}
