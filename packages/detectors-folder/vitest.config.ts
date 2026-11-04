import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-folder",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
