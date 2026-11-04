import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "detector-autodelete",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
