import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "actions",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
