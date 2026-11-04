import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-spoiler",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
