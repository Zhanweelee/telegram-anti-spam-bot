import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-regex",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
