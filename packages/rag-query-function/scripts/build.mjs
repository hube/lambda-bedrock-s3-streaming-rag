import { spawnSync } from "node:child_process";
import { cpSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as esbuild from "esbuild";

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
  entryPoints: [join(projectDir, "lib", "index.mts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: join(outputDir, "index.mjs"),
  external: [
    "@aws-sdk/*", // provided by the Lambda runtime
    "@lancedb/lancedb",
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
