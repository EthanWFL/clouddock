import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __OPSDOCK_E2E__: "true",
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
