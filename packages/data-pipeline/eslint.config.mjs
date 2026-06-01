import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs", "**/*.mts"],
    languageOptions: { globals: globals.node },
  },
  // Must come last: disables ESLint rules that conflict with Prettier.
  eslintConfigPrettier,
  globalIgnores(["dist", ".pnp.*", ".yarn/**"]),
);
