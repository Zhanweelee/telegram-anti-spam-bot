import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-decline",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
