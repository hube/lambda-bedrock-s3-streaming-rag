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

    const buildCommands = (outputDir: string) =>
      [
        "yarn install --immutable --immutable-cache",
        "yarn build",
        `cp dist/index.mjs "${outputDir}"`,
        `yarn node scripts/build-deploy-package.mjs "${outputDir}"`,
        `cd "${outputDir}"`,
        "yarn install",
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
        runtime: lambda.Runtime.NODEJS_22_X,
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
            image: lambda.Runtime.NODEJS_22_X.bundlingImage,
            command: ["bash", "-c", buildCommands("/asset-output")],
          },
        }),
        layers: [napiRsCanvasLayer],
        timeout: cdk.Duration.minutes(15),
        memorySize: 512,
        architecture: lambda.Architecture.X86_64,
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
