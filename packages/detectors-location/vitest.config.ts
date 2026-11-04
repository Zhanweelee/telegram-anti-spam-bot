import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-location",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
