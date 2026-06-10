import type { EnvironmentConfig } from "./types";

const dev: EnvironmentConfig = {
  name: "dev",
  // Replace with your AWS account ID
  account: "123456789012",
  // Must be a key in the napi-rs-canvas CfnMapping in DocumentIngestionPipelineStack
  region: "us-east-1",
};

export default dev;
