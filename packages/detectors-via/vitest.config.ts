import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-via",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
