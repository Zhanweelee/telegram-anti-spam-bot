import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-giveaway-notice",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
