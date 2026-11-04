import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-community",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
