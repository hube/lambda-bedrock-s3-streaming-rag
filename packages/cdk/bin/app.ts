#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import { StreamingRagStack } from "../lib/streaming-rag-stack";
import { DocumentIngestionPipelineStack } from "../lib/document-ingestion-pipeline-stack";
import { DocumentWorkerStack } from "../lib/document-worker-stack";
import { getEnvironmentConfig } from "../config/index";

const app = new cdk.App();

const envName = app.node.tryGetContext("env") ?? "dev";
const cfg = getEnvironmentConfig(envName);
const env = { account: cfg.awsAccountId, region: cfg.awsRegion };

// Consumption side (SQS queue + consumer DLQ). Created first so the pipeline
// stack's EventBridge rule can target the queue.
const workerStack = new DocumentWorkerStack(
  app,
  `DocumentWorkerStack-${cfg.deploymentEnvironmentName}`,
  {
    env,
    environmentName: cfg.deploymentEnvironmentName,
    description: "SQS queue + DLQ for downstream DocumentProcessed consumers",
  },
);

const pipelineStack = new DocumentIngestionPipelineStack(
  app,
  `DocumentIngestionPipelineStack-${cfg.deploymentEnvironmentName}`,
  {
    env,
    environmentName: cfg.deploymentEnvironmentName,
    description: "Stack for document ingestion pipeline",
    documentProcessedQueue: workerStack.queue,
  },
);

new StreamingRagStack(
  app,
  `StreamingRagStack-${cfg.deploymentEnvironmentName}`,
  {
    env,
    environmentName: cfg.deploymentEnvironmentName,
    description:
      "Streaming serverless RAG demo using Lambda, LanceDB on S3, and Amazon Bedrock",
    vectorDbBucket: pipelineStack.vectorDbBucket,
  },
);
