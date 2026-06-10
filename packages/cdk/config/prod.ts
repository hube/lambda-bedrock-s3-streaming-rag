import type { EnvironmentConfig } from "./types";

const prod: EnvironmentConfig = {
  deploymentEnvironmentName: "prod",
  // Replace with your AWS account ID
  awsAccountId: "436705618259",
  // Must be a key in the napi-rs-canvas CfnMapping in DocumentIngestionPipelineStack
  awsRegion: "eu-central-1",
};

export default prod;
