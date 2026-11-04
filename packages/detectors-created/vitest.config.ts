import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-created",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
