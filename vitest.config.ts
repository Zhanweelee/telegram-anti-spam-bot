import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/detectors-keyword",
      "packages/detectors-join",
      "packages/detectors-rate",
      "packages/detectors-link",
      "packages/detectors-blocklist",
      "packages/detectors-llm",
      "packages/actions",
      "packages/adapters-memory",
      "packages/adapters-cloudflare",
      "packages/sdk",
      "packages/platform-telegram",
      "examples/minimal-pipeline",
      "examples/operator-commands",
      "examples/telegram-webhook",
      "evals",
      "apps/worker",
    ],
  },
});
