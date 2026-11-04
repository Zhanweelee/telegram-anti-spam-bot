import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-pin",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
