import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { spawnSync } from "child_process";
import { Construct } from "constructs";
import * as path from "path";

export class DocumentIngestionPipelineStack extends cdk.Stack {
  public readonly unprocessedDocumentsBucket: s3.Bucket;
  public readonly vectorDbBucket: s3.Bucket;
  public readonly lambdaFunction: lambda.Function;
  public readonly eventBus: events.IEventBus;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for unprocessed document uploads
    this.unprocessedDocumentsBucket = new s3.Bucket(
      this,
      "UnprocessedDocumentsBucket",
      {
        eventBridgeEnabled: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    // S3 bucket for LanceDB vector store
    this.vectorDbBucket = new s3.Bucket(this, "VectorDbBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const functionDir = path.join(__dirname, "../../data-pipeline");

    // Lambda function for processing documents.
    // Build flow: yarn build runs esbuild, which bundles all pure-JS deps
    // into dist/index.js. Only @lancedb/lancedb (native binaries) and its
    // apache-arrow peer dep are installed into the asset's node_modules;
    // @aws-sdk/* is provided by the Node 24 Lambda runtime. The musl variant
    // of lancedb is removed since the Lambda runtime is Amazon Linux (glibc).
    const buildCommands = (outputDir: string) =>
      [
        "yarn install",
        "yarn build",
        `cp dist/index.js "${outputDir}"`,
        `cp package.json "${outputDir}"`,
        `cd "${outputDir}"`,
        "yarn install --prod",
        "rm -rf node_modules/@lancedb/lancedb-linux-arm64-musl",
      ].join(" && ");

    this.lambdaFunction = new lambda.Function(
      this,
      "DocumentVectorizationFunction",
      {
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(functionDir, {
          bundling: {
            local: {
              tryBundle(outputDir: string): boolean {
                const result = spawnSync(
                  "bash",
                  ["-c", `cd "${functionDir}" && ${buildCommands(outputDir)}`],
                  { stdio: "inherit" },
                );
                return result.status === 0;
              },
            },
            image: lambda.Runtime.NODEJS_24_X.bundlingImage,
            command: ["bash", "-c", buildCommands("/asset-output")],
          },
        }),
        timeout: cdk.Duration.seconds(300),
        memorySize: 512,
        architecture: lambda.Architecture.ARM_64,
        environment: {
          s3BucketName: this.vectorDbBucket.bucketName,
          region: this.region,
          lanceDbTable: "vectorstore",
        },
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

    new cdk.CfnOutput(this, "VectorDbBucketName", {
      description: "S3 bucket where LanceDB sources embeddings",
      value: this.vectorDbBucket.bucketName,
    });
  }
}
