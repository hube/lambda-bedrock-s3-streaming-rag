import type { EnvironmentConfig } from "./types";

const dev: EnvironmentConfig = {
  name: "dev",
  // Replace with your AWS account ID
  account: "059872197780",
  // Must be a key in the napi-rs-canvas CfnMapping in DocumentIngestionPipelineStack
  region: "us-west-2",
};

export default dev;
