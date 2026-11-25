import { defineConfig } from "vitest/config";

// Testes do servidor (sem os plugins do TanStack/Vite da aplicação).
export default defineConfig({
  test: { name: "web", environment: "node", include: ["src/**/*.test.ts"], fileParallelism: false },
});
