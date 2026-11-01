import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "example-telegram-webhook",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
