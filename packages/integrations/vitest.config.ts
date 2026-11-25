import { defineProject } from "vitest/config";

export default defineProject({
  test: { name: "integrations", include: ["src/**/*.test.ts"] },
});
