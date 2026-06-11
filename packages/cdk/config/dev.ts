import type { EnvironmentConfig } from "./types";

const dev: EnvironmentConfig = {
  deploymentEnvironmentName: "dev",
  // Replace with your AWS account ID
  awsAccountId: "059872197780",
  // Must be a key in the napi-rs-canvas CfnMapping in DocumentIngestionPipelineStack
  awsRegion: "us-west-2",
};

export default dev;
