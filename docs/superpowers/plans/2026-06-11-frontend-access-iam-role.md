# Frontend Access IAM Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize a least-privilege frontend IAM role in `DocumentWorkerStack` with live cross-stack ARN references, by first inverting the stack dependency graph so Worker sits last and can safely import from Pipeline and StreamingRag.

**Architecture:** Move the `DocumentProcessed` EventBridge routing rule (delivery DLQ + queue policy) out of `DocumentIngestionPipelineStack` and into `DocumentWorkerStack`, inverting the graph to `Pipeline ← StreamingRag ← Worker`. Worker then holds live construct references to `pipelineStack.unprocessedDocumentsBucket` and `streamingRagStack.lambdaFunction` for the new `FrontendAccessRole`, with no cycle.

**Tech Stack:** AWS CDK v2 (TypeScript), `aws-cdk-lib` constructs (`aws-iam`, `aws-s3`, `aws-sqs`, `aws-events`, `aws-events-targets`, `aws-lambda`).

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/cdk/config/event-source.ts` | Single-source-of-truth `eventSourceFor(env)` pure function |
| Modify | `packages/cdk/config/index.ts` | Re-export `eventSourceFor` so importers use `"../config"` |
| Modify | `packages/cdk/lib/document-ingestion-pipeline-stack.ts` | Import `eventSourceFor` from config; remove static method; remove routing rule, delivery DLQ, queue policy, `documentProcessedQueue` prop |
| Modify | `packages/cdk/lib/document-worker-stack.ts` | Add `unprocessedDocumentsBucket`/`ragFunction` props; add routing rule + delivery DLQ; add `FrontendAccessRole` with four policy statements |
| Modify | `packages/cdk/bin/app.ts` | Reorder stacks (Pipeline → StreamingRag → Worker last); pass new props to Worker; remove `documentProcessedQueue` from Pipeline |

All verification commands run from `packages/cdk`.

---

## Task 1: Extract `eventSourceFor` into config

**Files:**
- Create: `packages/cdk/config/event-source.ts`
- Modify: `packages/cdk/config/index.ts`
- Modify: `packages/cdk/lib/document-ingestion-pipeline-stack.ts`

- [ ] **Step 1: Create `packages/cdk/config/event-source.ts`**

```ts
export function eventSourceFor(environmentName: string): string {
  return `DocumentVectorizationPipeline.${environmentName}`;
}
```

- [ ] **Step 2: Re-export `eventSourceFor` from `packages/cdk/config/index.ts`**

Append one line to the existing file (do not replace existing content):

```ts
export { eventSourceFor } from "./event-source";
```

- [ ] **Step 3: Update Pipeline stack to import `eventSourceFor` from config**

In `packages/cdk/lib/document-ingestion-pipeline-stack.ts`, add the import at the top:

```ts
import { eventSourceFor } from "../config/event-source";
```

Remove the static method from the class (lines ~23–25 in the current file):

```ts
// DELETE THIS:
static eventSourceFor(environmentName: string): string {
  return `DocumentVectorizationPipeline.${environmentName}`;
}
```

Replace the two usages of the static method in the file. There are two occurrences of `DocumentIngestionPipelineStack.eventSourceFor(`:

First occurrence (Lambda `environment` block, ~line 142):
```ts
// OLD:
eventSource: DocumentIngestionPipelineStack.eventSourceFor(
  props.deploymentEnvironmentName,
),
// NEW:
eventSource: eventSourceFor(props.deploymentEnvironmentName),
```

Second occurrence (inside `DocumentProcessedRule` eventPattern, ~line 215):
```ts
// OLD:
source: [
  DocumentIngestionPipelineStack.eventSourceFor(
    props.deploymentEnvironmentName,
  ),
],
// NEW:
source: [eventSourceFor(props.deploymentEnvironmentName)],
```

- [ ] **Step 4: Verify Task 1 compiles and synths**

```bash
cd packages/cdk && yarn build
```

Expected: exits 0, no TypeScript errors.

```bash
cd packages/cdk && yarn cdk synth --all
```

Expected: synthesizes all three stacks, no dependency-cycle error. Behavior is unchanged from before this task — the routing rule and its policy are still in the Pipeline stack.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/cdk/config/event-source.ts \
        packages/cdk/config/index.ts \
        packages/cdk/lib/document-ingestion-pipeline-stack.ts
git commit -m "refactor(cdk): extract eventSourceFor into shared config helper"
```

---

## Task 2: Migrate routing to Worker, add FrontendAccessRole, rewire app

All steps in this task must be applied before verifying — the TypeScript compiler will reject intermediate states (e.g. required props on Worker not yet passed from `app.ts`). Work through all steps, then verify and commit at Step 12.

**Files:**
- Modify: `packages/cdk/lib/document-worker-stack.ts`
- Modify: `packages/cdk/lib/document-ingestion-pipeline-stack.ts`
- Modify: `packages/cdk/bin/app.ts`

- [ ] **Step 1: Replace the entire `document-worker-stack.ts` with the updated implementation**

The new file adds imports for `events`, `events-targets`, `iam`, `s3`, `lambda`; extends `DocumentWorkerStackProps` with two new required props; relocates the routing rule; and adds the `FrontendAccessRole`.

Full replacement content for `packages/cdk/lib/document-worker-stack.ts`:

```ts
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import { eventSourceFor } from "../config/event-source";

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
        new events_targets.SqsQueue(this.queue, { deadLetterQueue: deliveryDlq }),
      ],
    });

    this.frontendAccessRole = new iam.Role(this, "FrontendAccessRole", {
      roleName: `frontend-access-${env}-${this.region}`,
      assumedBy: new iam.AccountPrincipal(this.account),
      description: "Scoped access for the frontend to drive the RAG system",
    });

    // S3: upload/delete unprocessed documents (object-level only).
    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:PutObject", "s3:DeleteObject"],
        resources: [props.unprocessedDocumentsBucket.arnForObjects("*")],
      }),
    );
    // SQS: consume DocumentProcessed notifications off the worker queue.
    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
        resources: [this.queue.queueArn],
      }),
    );
    // SQS: park failures on the consumer DLQ.
    this.frontendAccessRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["sqs:SendMessage"],
        resources: [deadLetterQueue.queueArn],
      }),
    );
    // Lambda: invoke the RAG query function and its Function URL.
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
```

- [ ] **Step 2: Remove the routing block from `document-ingestion-pipeline-stack.ts`**

Delete the entire block that spans roughly lines 191–242. This is the block that starts with:

```ts
// Route DocumentProcessed events off the default bus to the consumer queue.
```

...and ends with the closing `);` of `new sqs.QueuePolicy(...)`. The exact block to delete:

```ts
    // Route DocumentProcessed events off the default bus to the consumer queue.
    // A dedicated delivery DLQ captures events EventBridge cannot deliver.
    const documentProcessedDeliveryDlq = new sqs.Queue(
      this,
      "DocumentProcessedDeliveryDlq",
      {
        queueName: `document-processed-delivery-dlq-${props.deploymentEnvironmentName}-${this.region}`,
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
          source: [eventSourceFor(props.deploymentEnvironmentName)],
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
```

After deletion, the only thing between the `S3ObjectAddedRule` block and the `CfnOutput` is the `CfnOutput` for `VectorDbBucketName`.

- [ ] **Step 3: Remove `documentProcessedQueue` from `DocumentIngestionPipelineStackProps`**

In `document-ingestion-pipeline-stack.ts`, the props interface currently looks like:

```ts
export interface DocumentIngestionPipelineStackProps extends cdk.StackProps {
  /**
   * Queue (in `DocumentWorkerStack`) that `DocumentProcessed` events are routed
   * to. This stack owns the EventBridge rule that targets it.
   */
  documentProcessedQueue: sqs.IQueue;
  /** Short environment name, e.g. "dev", "prod". Embedded in resource names. */
  deploymentEnvironmentName: string;
}
```

Replace with:

```ts
export interface DocumentIngestionPipelineStackProps extends cdk.StackProps {
  /** Short environment name, e.g. "dev", "prod". Embedded in resource names. */
  deploymentEnvironmentName: string;
}
```

- [ ] **Step 4: Remove unused imports from `document-ingestion-pipeline-stack.ts`**

The routing removal leaves `events_targets`, `iam`, and `sqs` potentially unused. Check whether each is still referenced:

- `events_targets`: still used for `LambdaFunction` target in `S3ObjectAddedRule` → **keep**
- `iam`: still used for `PolicyStatement` (Bedrock + EventBridge grants) → **keep**  
- `sqs`: no longer used (`IQueue` prop removed, `Queue` and `QueuePolicy` removed) → **remove**

Delete the `sqs` import line:

```ts
// DELETE THIS LINE:
import * as sqs from "aws-cdk-lib/aws-sqs";
```

- [ ] **Step 5: Rewrite `packages/cdk/bin/app.ts`**

Replace the entire file with the new instantiation order (Pipeline first, StreamingRag second, Worker last):

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
    description: "SQS queue + DLQ for downstream DocumentProcessed consumers",
    unprocessedDocumentsBucket: pipelineStack.unprocessedDocumentsBucket,
    ragFunction: streamingRagStack.lambdaFunction,
  },
);
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd packages/cdk && yarn build
```

Expected: exits 0 with no errors. If TypeScript reports errors, fix them before proceeding.

- [ ] **Step 7: Verify CDK synthesizes without a dependency cycle**

```bash
cd packages/cdk && yarn cdk synth --all
```

Expected output: synthesizes all three stacks (`DocumentIngestionPipelineStack-*`, `StreamingRagStack-*`, `DocumentWorkerStack-*`) with no error. The key success signal is the absence of "Circular dependency between stacks" in the output.

- [ ] **Step 8: Confirm Worker template has FrontendAccessRole and DocumentProcessedRule**

```bash
grep -l "FrontendAccessRole" cdk.out/*.template.json
```

Expected: prints a path containing `DocumentWorkerStack`.

```bash
grep -l "DocumentProcessedRule" cdk.out/*.template.json
```

Expected: prints a path containing `DocumentWorkerStack` only (not Pipeline).

- [ ] **Step 9: Confirm Pipeline template no longer has routing constructs**

```bash
grep -c "DocumentProcessedRule\|DocumentProcessedDeliveryDlq\|DocumentProcessedQueuePolicy" \
  cdk.out/DocumentIngestionPipelineStack-*.template.json
```

Expected: `0`

```bash
grep -c "S3ObjectAddedRule" cdk.out/DocumentIngestionPipelineStack-*.template.json
```

Expected: `1` or more (the S3→vectorization rule is still there).

- [ ] **Step 10: Confirm FrontendAccessRoleArn output exists in Worker template**

```bash
grep -c "FrontendAccessRoleArn" cdk.out/DocumentWorkerStack-*.template.json
```

Expected: `1`

- [ ] **Step 11: Confirm cross-stack references use `Fn::ImportValue` (not hardcoded names)**

```bash
grep "Fn::ImportValue" cdk.out/DocumentWorkerStack-*.template.json | head -5
```

Expected: shows `Fn::ImportValue` entries for the bucket ARN and Lambda ARN imported from the other stacks. This confirms CDK is wiring real exports, not embedding string literals.

- [ ] **Step 12: Commit Task 2**

```bash
git add packages/cdk/lib/document-worker-stack.ts \
        packages/cdk/lib/document-ingestion-pipeline-stack.ts \
        packages/cdk/bin/app.ts
git commit -m "feat(cdk): add FrontendAccessRole to Worker; relocate DocumentProcessed routing"
```

---

## Post-implementation notes

**Deploy order:** `cdk deploy --all` respects the dependency graph automatically. Pipeline deploys first, StreamingRag second, Worker last. During the first deploy after this change, CloudFormation removes the routing rule and delivery DLQ from Pipeline and recreates them in Worker. The delivery DLQ is an error-path queue and is normally empty, so no message loss risk.

**Optional smoke test (post-deploy):** Assume the role ARN from the `FrontendAccessRoleArn` output, then:
- `aws s3 cp <file> s3://<unprocessed-bucket>/<userId>/<groupId>/test.pdf` — should succeed
- Invoke the RAG Function URL with the assumed credentials — should succeed (or return a model error, not an auth error)
