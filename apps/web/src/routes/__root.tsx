import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { CamadaChamadas } from "../components/chamadas/CamadaChamadas.tsx";
import appCss from "../styles.css?url";

// Aplica o tema salvo antes da primeira pintura (evita piscar). Sem localStorage, segue o sistema.
const themeBootstrap = `try{var t=localStorage.getItem("omni-tema");if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Omni · Filtrovali" },
      { name: "description", content: "Conversas, missões e tarefas da Filtrovali em uma tela só" },
      { name: "theme-color", content: "#30503a" },
      { name: "robots", content: "noindex, nofollow" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "Omni" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/marca/filtrovali-simbolo-color.png", type: "image/png" },
      // App instalável (PWA): manifesto e ícone do iPhone/iPad.
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/icones/apple-touch-icon.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFound,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  return (
    <QueryClientProvider client={queryClient}>
      {/* Chamadas em qualquer tela: uma instância só, que não desmonta ao trocar de página. */}
      <CamadaChamadas>
        <Outlet />
      </CamadaChamadas>
    </QueryClientProvider>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="max-w-sm rounded-lg border border-linha bg-superficie p-6 text-center">
        <h1 className="text-lg font-semibold">Página não encontrada</h1>
        <p className="mt-1 text-muted">O endereço não existe ou mudou.</p>
        <Link
          to="/"
          className="mt-4 inline-flex rounded-md bg-floresta px-4 py-2 font-medium text-white hover:bg-floresta-escura"
        >
          Voltar ao início
        </Link>
      </div>
    </main>
  );
}
