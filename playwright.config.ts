import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/electron",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["html", { open: "never" }]],
});
