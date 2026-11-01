import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "example-plugin-manifest",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
