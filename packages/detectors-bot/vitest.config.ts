import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-bot",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
