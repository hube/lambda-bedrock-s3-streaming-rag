import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { spawnSync } from "child_process";
import { Construct } from "constructs";
import * as path from "path";

export interface DocumentIngestionPipelineStackProps extends cdk.StackProps {
  /**
   * Queue (in `DocumentWorkerStack`) that `DocumentProcessed` events are routed
   * to. This stack owns the EventBridge rule that targets it.
   */
  documentProcessedQueue: sqs.IQueue;
  /** Short environment name, e.g. "dev", "prod". Embedded in resource names. */
  environmentName: string;
}

export class DocumentIngestionPipelineStack extends cdk.Stack {
  static eventSourceFor(environmentName: string): string {
    return `DocumentVectorizationPipeline.${environmentName}`;
  }

  public readonly unprocessedDocumentsBucket: s3.Bucket;
  public readonly vectorDbBucket: s3.Bucket;
  public readonly lambdaFunction: lambda.Function;
  public readonly eventBus: events.IEventBus;

  constructor(
    scope: Construct,
    id: string,
    props: DocumentIngestionPipelineStackProps,
  ) {
    super(scope, id, props);

    // S3 bucket for unprocessed document uploads
    this.unprocessedDocumentsBucket = new s3.Bucket(
      this,
      "UnprocessedDocumentsBucket",
      {
        bucketName: `unprocessed-documents-${props.environmentName}-${this.region}-${this.account}`,
        eventBridgeEnabled: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    // S3 bucket for LanceDB vector store
    this.vectorDbBucket = new s3.Bucket(this, "VectorDbBucket", {
      bucketName: `vector-db-${props.environmentName}-${this.region}-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const functionDir = path.join(__dirname, "../../data-pipeline");

    const localBuildCommands = (outputDir: string) =>
      [
        "yarn install --immutable --immutable-cache",
        `yarn build "${outputDir}"`,
        `cd "${outputDir}"`,
        "yarn workspaces focus --production",
      ].join(" && ");

    const dockerBuildCommands = (outputDir: string) =>
      [
        // --immutable catches lockfile drift; --immutable-cache is omitted
        // because the cache isn't committed and is populated during the build.
        "yarn install --immutable",
        `yarn build "${outputDir}"`,
        `cd "${outputDir}"`,
        "yarn workspaces focus --production",
      ].join(" && ");

    // @napi-rs/canvas (a transitive dep of pdf-parse) provides DOMMatrix,
    // which pdfjs-dist requires at runtime. The native binaries ship via a
    // public Lambda layer published by https://github.com/ShivamJoker/Canvas-Lambda-Layer.
    // Versions differ per region; deploys to a region not in this map will
    // fail at CloudFormation deploy time.
    const napiRsCanvasLayerVersionByRegion = new cdk.CfnMapping(
      this,
      "NapiRsCanvasLayerVersionByRegion",
      {
        mapping: {
          "us-east-1": { version: "888" },
          "us-west-2": { version: "886" },
          "eu-west-1": { version: "885" },
          "eu-central-1": { version: "885" },
          "ap-northeast-1": { version: "886" },
          "ap-southeast-1": { version: "886" },
          "ap-southeast-2": { version: "885" },
          "sa-east-1": { version: "886" },
        },
      },
    );
    const napiRsCanvasLayerVersion = napiRsCanvasLayerVersionByRegion.findInMap(
      this.region,
      "version",
    );
    const napiRsCanvasLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      "NapiRsCanvasLayer",
      `arn:aws:lambda:${this.region}:205979422636:layer:napi-rs-canvas:${napiRsCanvasLayerVersion}`,
    );

    this.lambdaFunction = new lambda.Function(
      this,
      "DocumentVectorizationFunction",
      {
        functionName: `document-vectorization-${props.environmentName}-${this.region}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(functionDir, {
          bundling: {
            local: {
              tryBundle(outputDir: string): boolean {
                const result = spawnSync(
                  "bash",
                  [
                    "-c",
                    `cd "${functionDir}" && ${localBuildCommands(outputDir)}`,
                  ],
                  { stdio: "inherit" },
                );
                return result.status === 0;
              },
            },
            image: lambda.Runtime.NODEJS_22_X.bundlingImage,
            command: ["bash", "-c", dockerBuildCommands("/asset-output")],
          },
        }),
        layers: [napiRsCanvasLayer],
        timeout: cdk.Duration.minutes(15),
        memorySize: 512,
        architecture: lambda.Architecture.X86_64,
        environment: {
          vectorDbS3BucketName: this.vectorDbBucket.bucketName,
          awsRegion: this.region,
          lanceDbTableName: "vectorstore",
          eventBusName: "default",
          eventSource: DocumentIngestionPipelineStack.eventSourceFor(
            props.environmentName,
          ),
        },
        tracing: lambda.Tracing.ACTIVE,
      },
    );

    // S3 permissions
    this.unprocessedDocumentsBucket.grantRead(this.lambdaFunction);
    this.vectorDbBucket.grantReadWrite(this.lambdaFunction);

    // Bedrock permission for Titan embeddings
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["bedrock:InvokeModel"],
        resources: [`arn:aws:bedrock:*:*:foundation-model/amazon.titan-*`],
      }),
    );

    // Allow the Lambda to publish DocumentProcessed events to the default bus.
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["events:PutEvents"],
        resources: [
          `arn:aws:events:${this.region}:${this.account}:event-bus/default`,
        ],
      }),
    );

    this.eventBus = events.EventBus.fromEventBusName(
      this,
      "DefaultEventBus",
      "default",
    );
    new events.Rule(this, "S3ObjectAddedRule", {
      eventBus: this.eventBus,
      eventPattern: {
        detailType: ["Object Created"],
        source: ["aws.s3"],
        detail: {
          bucket: { name: [this.unprocessedDocumentsBucket.bucketName] },
        },
      },
      targets: [new events_targets.LambdaFunction(this.lambdaFunction)],
    });

    // Route DocumentProcessed events off the default bus to the consumer queue.
    // A dedicated delivery DLQ captures events EventBridge cannot deliver.
    const documentProcessedDeliveryDlq = new sqs.Queue(
      this,
      "DocumentProcessedDeliveryDlq",
      {
        queueName: `document-processed-delivery-dlq-${props.environmentName}-${this.region}`,
        retentionPeriod: cdk.Duration.days(14),
      },
    );
    // Import the worker queue by ARN so the target does not auto-add a
    // SendMessage policy in the worker stack (which would create a cross-stack
    // dependency cycle); the grant is added explicitly below.
    const workerQueue = sqs.Queue.fromQueueArn(
      this,
      "DocumentProcessedQueueRef",
      props.documentProcessedQueue.queueArn,
    );
    const documentProcessedRule = new events.Rule(
      this,
      "DocumentProcessedRule",
      {
        eventBus: this.eventBus,
        eventPattern: {
          source: [
            DocumentIngestionPipelineStack.eventSourceFor(
              props.environmentName,
            ),
          ],
          detailType: ["DocumentProcessed"],
        },
        targets: [
          new events_targets.SqsQueue(workerQueue, {
            deadLetterQueue: documentProcessedDeliveryDlq,
          }),
        ],
      },
    );

    new sqs.QueuePolicy(this, "DocumentProcessedQueuePolicy", {
      queues: [workerQueue],
    }).document.addStatements(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("events.amazonaws.com")],
        actions: ["sqs:SendMessage"],
        resources: [workerQueue.queueArn],
        conditions: {
          ArnEquals: { "aws:SourceArn": documentProcessedRule.ruleArn },
        },
      }),
    );

    new cdk.CfnOutput(this, "VectorDbBucketName", {
      description: "S3 bucket where LanceDB sources embeddings",
      value: this.vectorDbBucket.bucketName,
    });
  }
}
