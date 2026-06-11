import * as cdk from "aws-cdk-lib";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

export interface DocumentWorkerStackProps extends cdk.StackProps {
  deploymentEnvironmentName: string;
}

/**
 * The "document worker" consumption side: the SQS queue a downstream worker
 * polls for `DocumentProcessed` events, plus a consumer DLQ for messages the
 * worker repeatedly fails to process. The EventBridge rule that feeds this queue
 * lives in `DocumentIngestionPipelineStack` and references `queue` cross-stack.
 */
export class DocumentWorkerStack extends cdk.Stack {
  public readonly queue: sqs.Queue;

  constructor(scope: Construct, id: string, props: DocumentWorkerStackProps) {
    super(scope, id, props);

    // Consumer DLQ: redrive target for messages the worker repeatedly fails to
    // process.
    const deadLetterQueue = new sqs.Queue(this, "DocumentProcessedDlq", {
      queueName: `document-processed-dlq-${props.deploymentEnvironmentName}-${this.region}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, "DocumentProcessedQueue", {
      queueName: `document-processed-${props.deploymentEnvironmentName}-${this.region}`,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    new cdk.CfnOutput(this, "DocumentProcessedQueueUrl", {
      description: "SQS queue receiving DocumentProcessed events",
      value: this.queue.queueUrl,
    });
  }
}
