import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-shared-chat",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
