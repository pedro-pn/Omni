import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { MeuWhatsApp as Numeros } from "../../components/conta/MeuWhatsApp.tsx";
import { getMe } from "../../lib/session-fns.ts";

/** Meu WhatsApp: o próprio número (conectar, histórico, desconectar, remover). Só o dono mexe nele. */
export const Route = createFileRoute("/conta/whatsapp")({
  beforeLoad: async () => {
    const me = await getMe();
    if (!me) throw redirect({ to: "/entrar", search: { volta: "/conta/whatsapp" } });
    if (me.senhaPendente) throw redirect({ to: "/conta/senha", search: { volta: "/conta/whatsapp" } });
    if (me.termosPendentes) throw redirect({ to: "/termos", search: { volta: "/conta/whatsapp" } });
    return { me };
  },
  head: () => ({ meta: [{ title: "Meu WhatsApp · Omni" }] }),
  component: MeuWhatsApp,
});

function MeuWhatsApp() {
  const { me } = Route.useRouteContext();
  return (
    <div className="min-h-dvh bg-fundo">
      <header className="flex items-center gap-3 bg-floresta px-4 py-3 text-white">
        <Link to="/" aria-label="Voltar ao Omni" className="rounded-md p-1.5 hover:bg-white/10">
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-lg font-semibold">Meu WhatsApp</h1>
      </header>
      <main className="mx-auto max-w-4xl p-4">
        <Numeros personId={me.id} />
      </main>
    </div>
  );
}
