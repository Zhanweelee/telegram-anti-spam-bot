import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-price",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
