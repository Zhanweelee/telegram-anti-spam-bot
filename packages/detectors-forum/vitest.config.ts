import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-forum",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
