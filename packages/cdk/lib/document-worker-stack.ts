import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { eventSourceFor } from "../config";

export interface DocumentWorkerStackProps extends cdk.StackProps {
  deploymentEnvironmentName: string;
  /** Upload bucket from DocumentIngestionPipelineStack — grants frontend PutObject/DeleteObject. */
  unprocessedDocumentsBucket: s3.IBucket;
  /** RAG query function from StreamingRagStack — grants frontend InvokeFunction/InvokeFunctionUrl. */
  ragFunction: lambda.IFunction;
}

export class DocumentWorkerStack extends cdk.Stack {
  public readonly queue: sqs.Queue;
  public readonly frontendAccessRole: iam.Role;

  constructor(scope: Construct, id: string, props: DocumentWorkerStackProps) {
    super(scope, id, props);

    const env = props.deploymentEnvironmentName;

    // Consumer DLQ: redrive target for messages the worker repeatedly fails to process.
    const deadLetterQueue = new sqs.Queue(this, "DocumentProcessedDlq", {
      queueName: `document-processed-dlq-${env}-${this.region}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.queue = new sqs.Queue(this, "DocumentProcessedQueue", {
      queueName: `document-processed-${env}-${this.region}`,
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: 3 },
    });

    // Delivery DLQ: captures events EventBridge cannot deliver to this queue.
    const deliveryDlq = new sqs.Queue(this, "DocumentProcessedDeliveryDlq", {
      queueName: `document-processed-delivery-dlq-${env}-${this.region}`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const defaultBus = events.EventBus.fromEventBusName(
      this,
      "DefaultEventBus",
      "default",
    );
    new events.Rule(this, "DocumentProcessedRule", {
      eventBus: defaultBus,
      eventPattern: {
        source: [eventSourceFor(env)],
        detailType: ["DocumentProcessed"],
      },
      targets: [
        new events_targets.SqsQueue(this.queue, {
          deadLetterQueue: deliveryDlq,
        }),
      ],
    });

    this.frontendAccessRole = new iam.Role(this, "FrontendAccessRole", {
      roleName: `frontend-access-${env}-${this.region}`,
      assumedBy: new iam.AccountPrincipal(this.account),
      description: "Scoped access for the frontend to drive the RAG system",
    });

    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [props.unprocessedDocumentsBucket.arnForObjects("*")],
      }),
    );
    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
        resources: [this.queue.queueArn],
      }),
    );
    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:SendMessage"],
        resources: [deadLetterQueue.queueArn],
      }),
    );
    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"],
        resources: [props.ragFunction.functionArn],
      }),
    );

    new cdk.CfnOutput(this, "DocumentProcessedQueueUrl", {
      description: "SQS queue receiving DocumentProcessed events",
      value: this.queue.queueUrl,
    });

    new cdk.CfnOutput(this, "FrontendAccessRoleArn", {
      description: "IAM role the frontend assumes to access the RAG system",
      value: this.frontendAccessRole.roleArn,
    });
  }
}
