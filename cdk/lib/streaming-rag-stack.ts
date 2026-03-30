import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export interface StreamingRagStackProps extends cdk.StackProps {
  /**
   * Auth type for the Lambda Function URL.
   * @default 'AWS_IAM'
   */
  functionUrlAuthType?: lambda.FunctionUrlAuthType;

  vectorDbBucket: s3.Bucket;
}

export class StreamingRagStack extends cdk.Stack {
  public readonly functionUrl: lambda.FunctionUrl;
  public readonly lambdaFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: StreamingRagStackProps) {
    super(scope, id, props);

    const authType = props.functionUrlAuthType ?? lambda.FunctionUrlAuthType.AWS_IAM;

    const functionDir = path.join(__dirname, '../../function');

    // Lambda function using the AWS-provided nodejs24.x runtime
    this.lambdaFunction = new lambda.Function(this, 'StreamingRAGFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(functionDir, {
        bundling: {
          local: {
            tryBundle(outputDir: string): boolean {
              const result = spawnSync(
                'bash',
                [
                  '-c',
                  `cp -r ${functionDir}/. "${outputDir}" && cd "${outputDir}" && npm install --omit=dev`,
                ],
                { stdio: 'inherit' },
              );
              return result.status === 0;
            },
          },
          // Docker fallback (used in CI environments without local Node)
          image: lambda.Runtime.NODEJS_24_X.bundlingImage,
          command: [
            'bash',
            '-c',
            'cp -r . /asset-output/ && cd /asset-output && npm install --omit=dev',
          ],
        },
      }),
      timeout: cdk.Duration.seconds(300),
      memorySize: 256,
      architecture: lambda.Architecture.ARM_64,
      environment: {
        s3BucketName: props.vectorDbBucket.bucketName,
        region: this.region,
        lanceDbTable: 'vectorstore',
      },
    });

    // Bedrock permissions
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*:*:inference-profile/us.anthropic.claude-*`,
          `arn:aws:bedrock:*:*:foundation-model/anthropic.claude-*`,
          `arn:aws:bedrock:*:*:foundation-model/amazon.titan-*`,
          `arn:aws:bedrock:*:*:inference-profile/eu.mistral.pixtral-*`,
          `arn:aws:bedrock:*:*:foundation-model/mistral.pixtral-*`,
        ],
      }),
    );

    // S3 permissions
    props.vectorDbBucket.grantRead(this.lambdaFunction);

    // AWS Marketplace permissions (required by some Bedrock models)
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aws-marketplace:ViewSubscriptions', 'aws-marketplace:Subscribe'],
        resources: ['*'],
      }),
    );

    // Function URL with streaming
    this.functionUrl = this.lambdaFunction.addFunctionUrl({
      authType,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowCredentials: true,
        allowedHeaders: [
          'x-amz-security-token',
          'x-amz-date',
          'x-amz-content-sha256',
          'referer',
          'content-type',
          'accept',
          'authorization',
        ],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedOrigins: ['*'],
        maxAge: cdk.Duration.seconds(0),
      },
    });
  }
}
