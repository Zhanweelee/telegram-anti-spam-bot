import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-script",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
