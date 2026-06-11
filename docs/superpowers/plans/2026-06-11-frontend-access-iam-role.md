# Frontend Access IAM Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Centralize a least-privilege frontend IAM role in `DocumentWorkerStack` with live cross-stack ARN references, by first inverting the stack dependency graph so Worker sits last and can safely import from Pipeline and StreamingRag.

**Architecture:** Move the `DocumentProcessed` EventBridge routing rule (delivery DLQ + queue policy) out of `DocumentIngestionPipelineStack` and into `DocumentWorkerStack`, inverting the graph to `Pipeline ← StreamingRag ← Worker`. Worker then holds live construct references to `pipelineStack.unprocessedDocumentsBucket` and `streamingRagStack.lambdaFunction` for the new `FrontendAccessRole`, with no cycle.

**Tech Stack:** AWS CDK v2 (TypeScript), `aws-cdk-lib` constructs (`aws-iam`, `aws-s3`, `aws-sqs`, `aws-events`, `aws-events-targets`, `aws-lambda`).

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/cdk/config/document-vectorization-pipeline-event-source.ts` | Single-source-of-truth `documentVectorizationPipelineEventBridgeEventSourceFor(env)` pure function |
| Modify | `packages/cdk/config/index.ts` | Re-export `documentVectorizationPipelineEventBridgeEventSourceFor` so importers use `"../config"` |
| Modify | `packages/cdk/lib/document-ingestion-pipeline-stack.ts` | Import renamed function from config; remove static method; remove routing rule, delivery DLQ, queue policy, `documentProcessedQueue` prop |
| Modify | `packages/cdk/lib/document-worker-stack.ts` | Add `unprocessedDocumentsBucket`/`ragFunction` props; add routing rule + delivery DLQ; add `FrontendAccessRole` using CDK `grant*()` helpers |
| Modify | `packages/cdk/bin/app.ts` | Reorder stacks (Pipeline → StreamingRag → Worker last); pass new props to Worker; remove `documentProcessedQueue` from Pipeline |

All verification commands run from `packages/cdk`.

---

## Task 1: Extract event-source helper into config

**Files:**
- Create: `packages/cdk/config/document-vectorization-pipeline-event-source.ts`
- Modify: `packages/cdk/config/index.ts`
- Modify: `packages/cdk/lib/document-ingestion-pipeline-stack.ts`

- [x] **Step 1: Create `packages/cdk/config/document-vectorization-pipeline-event-source.ts`**

```ts
export function documentVectorizationPipelineEventBridgeEventSourceFor(
  environmentName: string,
): string {
  return `DocumentVectorizationPipeline.${environmentName}`;
}
```

- [x] **Step 2: Re-export from `packages/cdk/config/index.ts`**

Append one line to the existing file:

```ts
export { documentVectorizationPipelineEventBridgeEventSourceFor } from "./document-vectorization-pipeline-event-source";
```

- [x] **Step 3: Update Pipeline stack to import the function from config**

In `packages/cdk/lib/document-ingestion-pipeline-stack.ts`, add the import:

```ts
import { documentVectorizationPipelineEventBridgeEventSourceFor } from "../config";
```

Remove the static method from the class:

```ts
// DELETE THIS:
static eventSourceFor(environmentName: string): string {
  return `DocumentVectorizationPipeline.${environmentName}`;
}
```

Replace the usage in the Lambda `environment` block:

```ts
// OLD:
          eventSource: DocumentIngestionPipelineStack.eventSourceFor(
            props.deploymentEnvironmentName,
          ),
// NEW:
          eventSource: documentVectorizationPipelineEventBridgeEventSourceFor(
            props.deploymentEnvironmentName,
          ),
```

Replace the usage in the `DocumentProcessedRule` eventPattern (this rule will be deleted in Task 2, but must compile in the interim):

```ts
// OLD:
          source: [DocumentIngestionPipelineStack.eventSourceFor(props.deploymentEnvironmentName)],
// NEW:
          source: [documentVectorizationPipelineEventBridgeEventSourceFor(props.deploymentEnvironmentName)],
```

- [x] **Step 4: Verify Task 1 compiles and synths**

```bash
cd packages/cdk && yarn build
```

```bash
cd packages/cdk && yarn cdk synth --all
```

Expected: all three stacks synthesize, no circular-dependency error.

- [x] **Step 5: Commit Task 1**

```bash
git add packages/cdk/config/document-vectorization-pipeline-event-source.ts \
        packages/cdk/config/index.ts \
        packages/cdk/lib/document-ingestion-pipeline-stack.ts
git commit -m "refactor(cdk): extract eventSourceFor into shared config helper"
```

---

## Task 2: Migrate routing to Worker, add FrontendAccessRole, rewire app

All steps in this task must be applied before verifying. Work through all steps, then verify and commit at Step 12.

**Files:**
- Modify: `packages/cdk/lib/document-worker-stack.ts`
- Modify: `packages/cdk/lib/document-ingestion-pipeline-stack.ts`
- Modify: `packages/cdk/bin/app.ts`

- [x] **Step 1: Replace the entire `document-worker-stack.ts` with the updated implementation**

```ts
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
        source: [documentVectorizationPipelineEventBridgeEventSourceFor(env)],
        detailType: ["DocumentProcessed"],
      },
      targets: [
        new events_targets.SqsQueue(this.queue, {
          deadLetterQueue: deliveryDlq,
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
    this.queue.grantConsumeMessages(this.frontendAccessRole);
    // grantSendMessages: SendMessage + GetQueueAttributes + GetQueueUrl (park failures on consumer DLQ)
    deadLetterQueue.grantSendMessages(this.frontendAccessRole);
    props.ragFunction.grantInvoke(this.frontendAccessRole);
    props.ragFunction.grantInvokeUrl(this.frontendAccessRole);

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
```

- [x] **Step 2: Remove the routing block from `document-ingestion-pipeline-stack.ts`**

Delete the entire routing block (delivery DLQ + `fromQueueArn` + `DocumentProcessedRule` + `QueuePolicy`) and the `CfnOutput` for `VectorDbBucketName` remains.

- [x] **Step 3: Remove `documentProcessedQueue` from `DocumentIngestionPipelineStackProps`**

```ts
export interface DocumentIngestionPipelineStackProps extends cdk.StackProps {
  /** Short environment name, e.g. "dev", "prod". Embedded in resource names. */
  deploymentEnvironmentName: string;
}
```

- [x] **Step 4: Remove the unused `sqs` import from `document-ingestion-pipeline-stack.ts`**

```ts
// DELETE THIS LINE:
import * as sqs from "aws-cdk-lib/aws-sqs";
```

- [x] **Step 5: Rewrite `packages/cdk/bin/app.ts`**

```ts
#!/usr/bin/env node

import * as cdk from "aws-cdk-lib";
import { StreamingRagStack } from "../lib/streaming-rag-stack";
import { DocumentIngestionPipelineStack } from "../lib/document-ingestion-pipeline-stack";
import { DocumentWorkerStack } from "../lib/document-worker-stack";
import { getEnvironmentConfig } from "../config/index";

const app = new cdk.App();

const envName = app.node.tryGetContext("env") ?? "dev";
const cfg = getEnvironmentConfig(envName);
const env = { account: cfg.awsAccountId, region: cfg.awsRegion };

const pipelineStack = new DocumentIngestionPipelineStack(
  app,
  `DocumentIngestionPipelineStack-${cfg.deploymentEnvironmentName}`,
  {
    env,
    deploymentEnvironmentName: cfg.deploymentEnvironmentName,
    description: "Stack for document ingestion pipeline",
  },
);

const streamingRagStack = new StreamingRagStack(
  app,
  `StreamingRagStack-${cfg.deploymentEnvironmentName}`,
  {
    env,
    deploymentEnvironmentName: cfg.deploymentEnvironmentName,
    description:
      "Streaming serverless RAG demo using Lambda, LanceDB on S3, and Amazon Bedrock",
    vectorDbBucket: pipelineStack.vectorDbBucket,
  },
);

new DocumentWorkerStack(
  app,
  `DocumentWorkerStack-${cfg.deploymentEnvironmentName}`,
  {
    env,
    deploymentEnvironmentName: cfg.deploymentEnvironmentName,
    description:
      "SQS queue + DLQ for downstream DocumentProcessed consumers, plus the frontend-access role",
    unprocessedDocumentsBucket: pipelineStack.unprocessedDocumentsBucket,
    ragFunction: streamingRagStack.lambdaFunction,
  },
);
```

- [x] **Step 6: Verify TypeScript compiles**

```bash
cd packages/cdk && yarn build
```

Expected: exits 0.

- [x] **Step 7: Verify CDK synthesizes without a dependency cycle**

```bash
cd packages/cdk && yarn cdk synth --all
```

Expected: all three stacks synthesize, no circular-dependency error.

- [x] **Step 8: Confirm Worker template has FrontendAccessRole and DocumentProcessedRule**

```bash
grep -l "FrontendAccessRole" cdk.out/*.template.json
grep -l "DocumentProcessedRule" cdk.out/*.template.json
```

Expected: both print a path containing `DocumentWorkerStack` only.

- [x] **Step 9: Confirm Pipeline template no longer has routing constructs**

```bash
grep -c "DocumentProcessedRule\|DocumentProcessedDeliveryDlq\|DocumentProcessedQueuePolicy" \
  cdk.out/DocumentIngestionPipelineStack-*.template.json
```

Expected: `0`

- [x] **Step 10: Confirm FrontendAccessRoleArn output exists in Worker template**

```bash
grep -c "FrontendAccessRoleArn" cdk.out/DocumentWorkerStack-*.template.json
```

Expected: `1`

- [x] **Step 11: Confirm cross-stack references use `Fn::ImportValue`**

```bash
grep "Fn::ImportValue" cdk.out/DocumentWorkerStack-*.template.json | head -5
```

Expected: shows `Fn::ImportValue` entries for the bucket ARN and Lambda ARN.

- [x] **Step 12: Commit Task 2**

```bash
git add packages/cdk/lib/document-worker-stack.ts \
        packages/cdk/lib/document-ingestion-pipeline-stack.ts \
        packages/cdk/bin/app.ts
git commit -m "feat(cdk): add FrontendAccessRole to Worker; relocate DocumentProcessed routing"
```

---

## Post-implementation notes

**Deploy order:** `cdk deploy --all` respects the dependency graph automatically. Pipeline deploys first, StreamingRag second, Worker last. During the first deploy after this change, CloudFormation removes the routing rule and delivery DLQ from Pipeline and recreates them in Worker. The delivery DLQ is an error-path queue and is normally empty, so no message loss risk.

**grant*() action coverage:**
- `grantPut` → `s3:PutObject` + `s3:PutObjectLegalHold/Retention/Tag, AbortMultipartUpload` on `arnForObjects("*")`
- `grantDelete` → `s3:DeleteObject*`
- `grantConsumeMessages` → `sqs:ReceiveMessage`, `sqs:ChangeMessageVisibility`, `sqs:GetQueueUrl`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`
- `grantSendMessages` → `sqs:SendMessage`, `sqs:GetQueueAttributes`, `sqs:GetQueueUrl`
- `grantInvoke` → `lambda:InvokeFunction`; `grantInvokeUrl` → `lambda:InvokeFunctionUrl`

**Optional smoke test (post-deploy):** Assume the role ARN from the `FrontendAccessRoleArn` output, then:
- `aws s3 cp <file> s3://<unprocessed-bucket>/<userId>/<groupId>/test.pdf` — should succeed
- Invoke the RAG Function URL with the assumed credentials — should succeed (or return a model error, not an auth error)
