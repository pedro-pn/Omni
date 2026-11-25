import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "db",
    include: ["src/**/*.test.ts"],
    // Testes de RLS compartilham o banco omni_test; rodar em série.
    fileParallelism: false,
  },
});
