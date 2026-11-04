import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-boost",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
