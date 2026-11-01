import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-forward",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
