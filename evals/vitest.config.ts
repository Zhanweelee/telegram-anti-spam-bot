import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "evals",
    environment: "node",
    include: ["src/**/*.test.ts"],
    disableConsoleIntercept: true,
  },
});
