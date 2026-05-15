// Bundles the Lambda handler with esbuild

import { spawnSync } from "node:child_process";
import * as esbuild from "esbuild";
import { cpSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = process.argv[2] ?? join(projectDir, "dist");

const tsc = spawnSync("tsc", ["--noEmit"], {
  stdio: "inherit",
  cwd: projectDir,
});
if (tsc.status !== 0) {
  console.log("tsc exited with non-zero status %o", tsc.status);
  console.log("tsc output: %o", tsc.output);
  console.log("tsc signal: %o", tsc.signal);
  console.log("tsc error: %o", tsc.error);
  console.log("Exiting");
  process.exit(tsc.status ?? 1);
}

await esbuild.build({
  entryPoints: [join("lib", "index.mts")],
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

cpSync(join(projectDir, "deploy"), outputDir, {
  recursive: true,
});
copyFileSync(join(projectDir, "package.json"), join(outputDir, "package.json"));
