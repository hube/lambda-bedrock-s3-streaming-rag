// Generates files needed to install the Lambda function's runtime deps:
//
// - package.json — contains the Lambda function's runtime dependencies plus a
//   pinned @lancedb/lancedb-linux-x64-gnu native binary, and copies the
//   parent's packageManager field so corepack picks yarn 4 (not legacy
//   system yarn) for the asset install.
// - .yarnrc.yml — narrower than the dev project's: only linux/x64/glibc,
//   so `yarn install` doesn't pull in other native variants we'd immediately
//   throw away.
// - yarn.lock — empty placeholder; yarn needs a lockfile to exist in the
//   install directory or it walks up looking for the parent project's.

import * as jsYaml from "js-yaml";
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outputDir = process.argv[2];
if (!outputDir) {
  throw new Error("Usage: build-deploy-package.mjs <output-dir>");
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const lanceVersion = pkg.dependencies?.["@lancedb/lancedb"];
if (!lanceVersion) {
  throw new Error(
    "package.json is missing @lancedb/lancedb in dependencies — cannot derive native binary version",
  );
}

const deployPkg = {
  packageManager: pkg.packageManager,
  dependencies: {
    ...pkg.dependencies,
    "@lancedb/lancedb-linux-x64-gnu": lanceVersion,
  },
};
writeFileSync(join(outputDir, "package.json"), JSON.stringify(deployPkg));

const deployYarnrc = {
  "nodeLinker": "node-modules",
  "supportedArchitectures": {
    "os": ["linux"],
    "cpu": ["x64"],
    "libc": ["glibc"],
  },
};
writeFileSync(join(outputDir, ".yarnrc.yml"), jsYaml.dump(deployYarnrc));

writeFileSync(join(outputDir, "yarn.lock"), "");
