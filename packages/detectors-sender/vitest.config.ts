import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-sender",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
