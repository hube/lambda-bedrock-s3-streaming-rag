import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { documentVectorizationPipelineEventBridgeEventSourceFor } from "../config";

export interface DocumentWorkerStackProps extends cdk.StackProps {
  deploymentEnvironmentName: string;
  /** Upload bucket from DocumentIngestionPipelineStack — grants frontend PutObject/DeleteObject. */
  unprocessedDocumentsBucket: s3.IBucket;
  /** RAG query function from StreamingRagStack — grants frontend InvokeFunction/InvokeFunctionUrl. */
  ragFunction: lambda.IFunction;
}

export class DocumentWorkerStack extends cdk.Stack {
  public readonly documentVectorizationEventsQueue: sqs.Queue;
  public readonly frontendAccessRole: iam.Role;

  constructor(scope: Construct, id: string, props: DocumentWorkerStackProps) {
    super(scope, id, props);

    const env = props.deploymentEnvironmentName;

    // Consumer DLQ: redrive target for messages the worker repeatedly fails to process.
    const documentVectorizationEventsDlq = new sqs.Queue(
      this,
      "DocumentVectorizationEventsDlq",
      {
        queueName: `document-vectorization-events-dlq-${env}-${this.region}`,
        retentionPeriod: cdk.Duration.days(14),
      },
    );

    this.documentVectorizationEventsQueue = new sqs.Queue(
      this,
      "DocumentVectorizationEventsQueue",
      {
        queueName: `document-vectorization-events-${env}-${this.region}`,
        deadLetterQueue: {
          queue: documentVectorizationEventsDlq,
          maxReceiveCount: 3,
        },
      },
    );

    // Delivery DLQ: captures events EventBridge cannot deliver to this queue.
    const documentVectorizationEventsDeliveryDlq = new sqs.Queue(
      this,
      "DocumentVectorizationEventsDeliveryDlq",
      {
        queueName: `document-vectorization-events-delivery-dlq-${env}-${this.region}`,
        retentionPeriod: cdk.Duration.days(14),
      },
    );
    const defaultEventBus = events.EventBus.fromEventBusName(
      this,
      "DefaultEventBus",
      "default",
    );
    new events.Rule(this, "DocumentProcessedRule", {
      eventBus: defaultEventBus,
      eventPattern: {
        source: [documentVectorizationPipelineEventBridgeEventSourceFor(env)],
        detailType: ["DocumentProcessed"],
      },
      targets: [
        new events_targets.SqsQueue(this.documentVectorizationEventsQueue, {
          deadLetterQueue: documentVectorizationEventsDeliveryDlq,
        }),
      ],
    });

    this.frontendAccessRole = new iam.Role(this, "FrontendAccessRole", {
      roleName: `docworker-frontend-access-${env}-${this.region}`,
      assumedBy: new iam.AccountPrincipal(this.account),
      description:
        "DocumentWorker frontend: scoped access to drive the RAG system",
    });

    // CDK grant*() helpers attach identity-based statements and resolve ARNs
    // via cross-stack exports automatically.
    props.unprocessedDocumentsBucket.grantPut(this.frontendAccessRole);
    props.unprocessedDocumentsBucket.grantDelete(this.frontendAccessRole);
    // grantConsumeMessages: ReceiveMessage + DeleteMessage + ChangeMessageVisibility + GetQueue*
    this.documentVectorizationEventsQueue.grantConsumeMessages(
      this.frontendAccessRole,
    );
    // grantSendMessages: SendMessage + GetQueueAttributes + GetQueueUrl (park failures on consumer DLQ)
    documentVectorizationEventsDlq.grantSendMessages(this.frontendAccessRole);
    props.ragFunction.grantInvoke(this.frontendAccessRole);
    props.ragFunction.grantInvokeUrl(this.frontendAccessRole);
  }
}
