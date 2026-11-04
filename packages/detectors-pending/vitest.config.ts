import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-pending",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
