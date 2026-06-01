import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.unit.test.mts"],
          setupFiles: ["test/setup.unit.mts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "int",
          include: ["test/**/*.int.test.mts"],
          setupFiles: ["test/setup.int.mts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: ["lib/**/*.mts"],
      exclude: ["scripts/**", "dist/**", "deploy/**", "test/**", "**/*.d.ts"],
      all: true,
      thresholds: {
        lines: 85,
        functions: 90,
        branches: 80,
        statements: 85,
      },
    },
  },
});
