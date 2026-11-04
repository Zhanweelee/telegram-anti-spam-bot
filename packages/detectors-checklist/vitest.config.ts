import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-checklist",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
