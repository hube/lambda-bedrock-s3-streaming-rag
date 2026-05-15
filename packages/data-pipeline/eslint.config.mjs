import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs", "**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  globalIgnores(["dist", ".pnp.*", ".yarn/**"]),
);
