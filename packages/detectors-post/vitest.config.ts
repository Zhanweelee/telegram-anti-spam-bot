import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-post",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
