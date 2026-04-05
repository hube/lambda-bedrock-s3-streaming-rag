import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import { execSync } from "child_process";
import { Construct } from "constructs";
import * as path from "path";

export class DocumentIngestionPipelineStack extends cdk.Stack {
  public readonly unprocessedDocumentsBucket: s3.Bucket;
  public readonly vectorDbBucket: s3.Bucket;
  public readonly lambdaFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for unprocessed document uploads
    this.unprocessedDocumentsBucket = new s3.Bucket(
      this,
      "UnprocessedDocumentsBucket",
      {
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      },
    );

    // S3 bucket for LanceDB vector store
    this.vectorDbBucket = new s3.Bucket(this, "VectorDbBucket", {
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const functionDir = path.join(__dirname, "../../data-pipeline");

    // Lambda function for processing documents
    this.lambdaFunction = new lambda.Function(
      this,
      "DocumentVectorizationFunction",
      {
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "ingest.handler",
        code: lambda.Code.fromAsset(functionDir, {
          bundling: {
            local: {
              tryBundle(outputDir: string): boolean {
                try {
                  execSync("pip3 --version");
                } catch {
                  return false;
                }

                const commands = [
                  `cd ${functionDir}`,
                  `pip3 install -r requirements.txt -t ${outputDir}`,
                  `cp -a . ${outputDir}`,
                ];

                execSync(commands.join(" && "));
                return true;
              },
            },
            image: lambda.Runtime.PYTHON_3_14.bundlingImage,
          },
        }),
        timeout: cdk.Duration.seconds(300),
        architecture: lambda.Architecture.ARM_64,
      },
    );

    // TODO: add EventBridge router

    new cdk.CfnOutput(this, "VectorDbBucketName", {
      description: "S3 bucket where LanceDB sources embeddings",
      value: this.vectorDbBucket.bucketName,
    });
  }
}
