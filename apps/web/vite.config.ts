import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ command, mode }) => {
  // Só no `vite dev`: o .env fica na raiz do monorepo e o código de servidor lê
  // process.env. No build e em produção as variáveis vêm do ambiente (Docker).
  // NODE_ENV nunca é copiado: o build precisa sair em modo produção.
  if (command === "serve") {
    const rootEnv = loadEnv(mode, "../..", "");
    for (const [key, value] of Object.entries(rootEnv)) {
      if (key !== "NODE_ENV") process.env[key] ??= value;
    }
  }

  return {
    // host.docker.internal: o webhook da Evolution local chega pelo repasse do docker-compose.whatsapp.yml.
    server: { port: 3000, strictPort: true, allowedHosts: ["host.docker.internal"],
      proxy: { "/omni/audio": { target: process.env.CHAMADAS_SERVICO_URL || "http://127.0.0.1:8098", ws: true, changeOrigin: true } },
    },
    plugins: [tanstackStart(), nitro(), viteReact(), tailwindcss()],
  };
});
