import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-rate",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
