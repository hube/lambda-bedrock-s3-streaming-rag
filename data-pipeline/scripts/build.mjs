// Bundles the Lambda handler with esbuild

import * as esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await esbuild.build({
  entryPoints: [join(root, "index.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(root, "dist/index.mjs"),
  external: [
    "@aws-sdk/*", // provided by the Lambda runtime
    "@lancedb/lancedb",
    "@napi-rs/canvas", // provided as a Lambda layer
  ],
});
