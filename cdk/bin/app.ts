#!/usr/bin/env node

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StreamingRagStack } from '../lib/streaming-rag-stack';
import { DocumentIngestionPipelineStack } from '../lib/document-ingestion-pipeline-stack';

const app = new cdk.App();

const pipelineStack = new DocumentIngestionPipelineStack(app, 'DocumentIngestionPipelineStack', {
  description: 'Stack for document ingestion pipeline',
});

new StreamingRagStack(app, 'StreamingRagStack', {
  description: 'Streaming serverless RAG demo using Lambda, LanceDB on S3, and Amazon Bedrock',
  vectorDbBucket: pipelineStack.vectorDbBucket,
});
