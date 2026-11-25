import { defineConfig } from "vitest/config";

/** Testes de ponta a ponta do app (fora do `npm test`): `npm run dev` no ar, login de desenvolvimento ligado. */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
