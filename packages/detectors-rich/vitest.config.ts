import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-rich",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
