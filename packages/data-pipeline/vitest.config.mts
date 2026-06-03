import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".vitest-cache",
  test: {
    sequence: { shuffle: true },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.mts"],
          setupFiles: ["test/unit/setup.mts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "int",
          include: ["test/integration/**/*.test.mts"],
          setupFiles: ["test/integration/setup.mts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "cobertura", "json-summary"],
      include: ["lib/**/*.mts"],
      thresholds: {
        lines: 85,
        functions: 90,
        branches: 80,
        statements: 85,
      },
    },
  },
});
