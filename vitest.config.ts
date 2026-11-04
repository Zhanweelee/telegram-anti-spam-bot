import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/detectors-keyword",
      "packages/detectors-join",
      "packages/detectors-bot",
      "packages/detectors-contact",
      "packages/detectors-folder",
      "packages/detectors-notice",
      "packages/detectors-via",
      "packages/detectors-rate",
      "packages/detectors-link",
      "packages/detectors-blocklist",
      "packages/detectors-llm",
      "packages/detectors-regex",
      "packages/detectors-forward",
      "packages/actions",
      "packages/adapters-memory",
      "packages/adapters-cloudflare",
      "packages/sdk",
      "packages/platform-telegram",
      "examples/minimal-pipeline",
      "examples/operator-commands",
      "examples/telegram-webhook",
      "examples/plugin-manifest",
      "evals",
      "apps/worker",
      "apps/cloud",
    ],
  },
});
