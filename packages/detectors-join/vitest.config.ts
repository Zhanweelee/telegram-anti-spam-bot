import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-join",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
