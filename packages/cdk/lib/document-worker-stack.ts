import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

/**
 * The "document worker" consumption side: the SQS queue a downstream worker
 * polls for `DocumentProcessed` events, plus a consumer DLQ for messages the
 * worker repeatedly fails to process. The EventBridge rule that feeds this queue
 * lives in `DocumentIngestionPipelineStack` and references `queue` cross-stack.
 */
export class DocumentWorkerStack extends cdk.Stack {
  public readonly queue: sqs.Queue;
  public readonly deadLetterQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Consumer DLQ: redrive target for messages the worker repeatedly fails to
    // process (distinct from the rule's delivery-failure DLQ in the pipeline
    // stack).
    this.deadLetterQueue = new sqs.Queue(this, "DocumentProcessedDlq", {
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, "DocumentProcessedQueue", {
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 3 },
    });

    // Allow EventBridge rules in this account to deliver to the queue. The rule
    // lives in DocumentIngestionPipelineStack; scoping this policy by source
    // account (rather than the specific rule ARN that CDK would otherwise wire
    // automatically) keeps this stack free of a dependency on the pipeline
    // stack, avoiding a cross-stack dependency cycle. The pipeline stack imports
    // this queue by ARN so it does not re-add a rule-scoped policy here.
    this.queue.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("events.amazonaws.com")],
        actions: ["sqs:SendMessage"],
        resources: [this.queue.queueArn],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );

    new cdk.CfnOutput(this, "DocumentProcessedQueueUrl", {
      description: "SQS queue receiving DocumentProcessed events",
      value: this.queue.queueUrl,
    });
    new cdk.CfnOutput(this, "DocumentProcessedDlqUrl", {
      description: "Consumer dead-letter queue for DocumentProcessed messages",
      value: this.deadLetterQueue.queueUrl,
    });
  }
}
