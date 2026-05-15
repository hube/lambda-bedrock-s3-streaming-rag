// Bundles the Lambda handler with esbuild

import * as esbuild from "esbuild";
import { cpSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.argv[2] ?? join(projectDir, "dist");

await esbuild.build({
  entryPoints: [join("src", "lambda", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(outputDir, "index.mjs"),
  external: [
    "@aws-sdk/*", // provided by the Lambda runtime
    "@lancedb/lancedb",
    "@napi-rs/canvas", // provided as a Lambda layer
  ],
});

/**
 * Copy configuration needed to build the package that will be deployed to
 * Lambda
 */

cpSync(join(projectDir, "src", "deploy"), outputDir, {
  recursive: true,
});
copyFileSync(join(projectDir, "package.json"), join(outputDir, "package.json"));
