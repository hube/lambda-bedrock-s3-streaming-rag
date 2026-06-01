import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  // Must come last: disables ESLint rules that conflict with Prettier.
  eslintConfigPrettier,
  globalIgnores(["cdk.out", "dist", ".pnp.*", ".yarn/**"]),
);
