#!/usr/bin/env node

import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StreamingRagStack } from '../lib/streaming-rag-stack';

const app = new cdk.App();
new StreamingRagStack(app, 'StreamingRagStack', {
  description: 'Streaming serverless RAG demo using Lambda, LanceDB on S3, and Amazon Bedrock',
});
