import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";

import { JanelaDeEmail } from "../../components/emails/CaixaDeEmail.tsx";
import { getMe } from "../../lib/session-fns.ts";

/**
 * Um e-mail da própria caixa numa janela à parte (duplo clique na lista, como no
 * Outlook). A caixa continua sendo a da sessão: o id só escolhe a mensagem dentro dela.
 */
export const Route = createFileRoute("/emails/janela")({
  validateSearch: z.object({ id: z.string().min(1).max(600) }),
  beforeLoad: async ({ location }) => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar", search: { volta: location.href } });
    if (me.termosPendentes) throw redirect({ to: "/termos", search: { volta: location.href } });
    return { me };
  },
  head: () => ({ meta: [{ title: "E-mail · Omni" }] }),
  component: Janela,
});

function Janela() {
  const { id } = Route.useSearch();
  return <JanelaDeEmail id={id} />;
}
