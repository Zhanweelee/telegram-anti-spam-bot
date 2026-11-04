import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-story",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
