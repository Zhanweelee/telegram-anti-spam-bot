import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-effect",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
