import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-background",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
