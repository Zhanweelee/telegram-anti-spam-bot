import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "platform-telegram",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
