import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-topic",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
