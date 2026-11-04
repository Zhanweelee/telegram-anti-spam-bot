import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-title",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
