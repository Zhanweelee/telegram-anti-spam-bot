import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "cloud",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
