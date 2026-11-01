import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-contact",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
