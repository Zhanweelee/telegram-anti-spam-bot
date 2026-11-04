import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-owner",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
