import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-proximity",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
