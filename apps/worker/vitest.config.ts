import { defineProject } from "vitest/config";

export default defineProject({
  // Testes do worker compartilham o banco omni_test; rodar em série.
  test: { name: "worker", include: ["src/**/*.test.ts"], fileParallelism: false },
});
