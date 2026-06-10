import type { EnvironmentConfig } from "./types";

const prod: EnvironmentConfig = {
  name: "prod",
  // Replace with your AWS account ID
  account: "436705618259",
  // Must be a key in the napi-rs-canvas CfnMapping in DocumentIngestionPipelineStack
  region: "eu-central-1",
};

export default prod;
