import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/core",
      "packages/detectors-keyword",
      "packages/actions",
      "packages/adapters-memory",
      "packages/sdk",
      "examples/minimal-pipeline",
      "evals",
      "apps/worker",
    ],
  },
});
