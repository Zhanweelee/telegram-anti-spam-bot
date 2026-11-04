import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-giveaway",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
