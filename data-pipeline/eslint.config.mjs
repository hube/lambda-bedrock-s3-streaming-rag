import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs", "**/*.ts"],
  },
  globalIgnores(["dist", ".pnp.*", ".yarn/**"]),
);
