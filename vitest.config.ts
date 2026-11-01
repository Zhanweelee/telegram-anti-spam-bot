import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/detectors-keyword",
      "packages/actions",
      "packages/adapters-memory",
      "packages/sdk",
      "packages/platform-telegram",
      "examples/minimal-pipeline",
      "examples/telegram-webhook",
      "evals",
      "apps/worker",
    ],
  },
});
