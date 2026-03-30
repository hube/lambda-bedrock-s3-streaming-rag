import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class DocumentIngestionPipelineStack extends cdk.Stack {
  public readonly unprocessedDocumentsBucket: s3.Bucket;
  public readonly vectorDbBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for unprocessed document uploads
    this.unprocessedDocumentsBucket = new s3.Bucket(this, 'UnprocessedDocumentsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // S3 bucket for LanceDB vector store
    this.vectorDbBucket = new s3.Bucket(this, 'VectorDbBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'VectorDbBucketName', {
      description: 'S3 bucket where LanceDB sources embeddings',
      value: this.vectorDbBucket.bucketName,
    });
  }
}
