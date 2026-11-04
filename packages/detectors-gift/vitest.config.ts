import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-gift",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
