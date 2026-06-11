# Centralized frontend-access IAM role in DocumentWorkerStack

## Context

The frontend needs scoped AWS permissions to drive the RAG system end-to-end:
upload/delete unprocessed PDFs, consume `DocumentProcessed` notifications off the
SQS queue (and park failures on the DLQ), and invoke the streaming RAG query
Lambda. Today there is no IAM identity for the frontend.

We want a **single, centralized least-privilege `iam.Role` in `DocumentWorkerStack`**
that references the real resource ARNs via proper cross-stack references (CDK
exports) — **no hardcoded resource names**.

The blocker was a dependency cycle: the role lives in Worker, but two of its
target resources live in `DocumentIngestionPipelineStack` (upload bucket) and
`StreamingRagStack` (RAG Lambda). Worker currently sits **first** in the graph
(`Worker ← Pipeline ← StreamingRag`) because Pipeline's `DocumentProcessedRule`
targets Worker's queue. So Worker importing anything from those stacks would
cycle.

**The fix (chosen approach):** move the `DocumentProcessed` routing rule (and its
delivery DLQ + queue policy) out of Pipeline and **into Worker**. Pipeline then
no longer references Worker at all — it just emits events to the default bus, and
Worker owns its own subscription. The graph inverts to **`Pipeline ← StreamingRag ← Worker`**
(Worker last), so Worker can hold real cross-stack references to the bucket and
Lambda with no cycle. This is also a cleaner pub/sub boundary (the consumer owns
the queue *and* the rule that feeds it).

## Decisions (confirmed)

- **Role centralized in `DocumentWorkerStack`**, all four policy statements in one
  file, using **live construct ARNs** (cross-stack exports) — not hardcoded names.
- **Trust policy:** `assumedBy = new iam.AccountPrincipal(this.account)`.
- **"Document processed DLQ"** = the consumer DLQ `DocumentProcessedDlq` already
  owned by this stack (`document-worker-stack.ts:23`).
- **Explicit `PolicyStatement`s** (not `grant*()` helpers) to match the requested
  actions exactly.

## Resulting dependency graph (acyclic)

```
Pipeline   →  (no deps on Worker/RAG)
StreamingRag → Pipeline            (vectorDbBucket)
Worker      → Pipeline, StreamingRag  (bucket ARN + RAG fn ARN, for the role)
```

No back-edge to Worker ⇒ `cdk synth --all` stays acyclic.

## Changes

### A. Relocate `DocumentProcessed` routing: Pipeline → Worker

In `packages/cdk/lib/document-ingestion-pipeline-stack.ts`, **remove**
(currently lines ~191–242):
- `DocumentProcessedDeliveryDlq` queue
- the `sqs.Queue.fromQueueArn(... "DocumentProcessedQueueRef" ...)` import
- `DocumentProcessedRule`
- `DocumentProcessedQueuePolicy`

Also remove `documentProcessedQueue` from `DocumentIngestionPipelineStackProps`
(lines ~13–17). **Keep** everything else: buckets, vectorization Lambda, its
`eventSource` env var, `events:PutEvents` permission, `this.eventBus`, and the
`S3ObjectAddedRule`.

In `packages/cdk/lib/document-worker-stack.ts`, **add** the relocated routing
after the queue is created:

```ts
const deliveryDlq = new sqs.Queue(this, "DocumentProcessedDeliveryDlq", {
  queueName: `document-processed-delivery-dlq-${env}-${this.region}`,
  retentionPeriod: cdk.Duration.days(14),
});
const defaultBus = events.EventBus.fromEventBusName(this, "DefaultEventBus", "default");
new events.Rule(this, "DocumentProcessedRule", {
  eventBus: defaultBus,
  eventPattern: {
    source: [eventSourceFor(env)],          // shared helper, see step D
    detailType: ["DocumentProcessed"],
  },
  targets: [
    new events_targets.SqsQueue(this.queue, { deadLetterQueue: deliveryDlq }),
  ],
});
```

Because the rule and the queue are now in the **same** stack, the
`events_targets.SqsQueue` target auto-adds the EventBridge→queue `SendMessage`
permission in-stack — so the previous explicit `QueuePolicy` and the
`fromQueueArn` import (which existed only to keep that grant out of a different
stack) are no longer needed.

### B. Add the centralized role (in `document-worker-stack.ts`)

```ts
this.frontendAccessRole = new iam.Role(this, "FrontendAccessRole", {
  roleName: `frontend-access-${env}-${this.region}`,
  assumedBy: new iam.AccountPrincipal(this.account),
  description: "Scoped access for the frontend to drive the RAG system",
});

// S3: upload/delete unprocessed documents (object-level).
this.frontendAccessRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["s3:PutObject", "s3:DeleteObject"],
  resources: [props.unprocessedDocumentsBucket.arnForObjects("*")],
}));
// SQS: consume DocumentProcessed notifications off the worker queue.
this.frontendAccessRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
  resources: [this.queue.queueArn],
}));
// SQS: park failures on the consumer DLQ.
this.frontendAccessRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["sqs:SendMessage"],
  resources: [deadLetterQueue.queueArn],
}));
// Lambda: invoke the RAG query function (direct + Function URL).
this.frontendAccessRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ["lambda:InvokeFunction", "lambda:InvokeFunctionUrl"],
  resources: [props.ragFunction.functionArn],
}));

new cdk.CfnOutput(this, "FrontendAccessRoleArn", {
  description: "IAM role the frontend assumes to access the RAG system",
  value: this.frontendAccessRole.roleArn,
});
```

`arnForObjects("*")` and `.queueArn` / `.functionArn` are live construct
accessors — CDK emits the cross-stack exports automatically; no names are
hardcoded.

Update `DocumentWorkerStackProps` and class fields:

```ts
export interface DocumentWorkerStackProps extends cdk.StackProps {
  deploymentEnvironmentName: string;
  unprocessedDocumentsBucket: s3.IBucket;   // from Pipeline
  ragFunction: lambda.IFunction;            // from StreamingRag
}
// + public readonly frontendAccessRole: iam.Role;
```

Add imports to the worker stack: `aws-iam`, `aws-s3`, `aws-lambda`,
`aws-events`, `aws-events-targets`.

### C. Rewire and reorder `packages/cdk/bin/app.ts`

New instantiation order — Pipeline, StreamingRag, **then Worker last**:

```ts
const pipelineStack = new DocumentIngestionPipelineStack(app, `...`, {
  env, deploymentEnvironmentName: cfg.deploymentEnvironmentName, description: "...",
});                                          // documentProcessedQueue prop removed
const streamingRagStack = new StreamingRagStack(app, `...`, {
  env, deploymentEnvironmentName: cfg.deploymentEnvironmentName, description: "...",
  vectorDbBucket: pipelineStack.vectorDbBucket,
});
const workerStack = new DocumentWorkerStack(app, `...`, {
  env, deploymentEnvironmentName: cfg.deploymentEnvironmentName, description: "...",
  unprocessedDocumentsBucket: pipelineStack.unprocessedDocumentsBucket,
  ragFunction: streamingRagStack.lambdaFunction,
});
```

### D. Share the event-source name

Both the Pipeline Lambda env (`eventSource`) and Worker's new rule must use the
identical source string. Relocate the existing
`DocumentIngestionPipelineStack.eventSourceFor(env)` static helper into a small
shared pure function (e.g. in `packages/cdk/config`), and import it from both
stacks. This avoids Worker importing the Pipeline stack class just for a string,
and keeps the source name a single source of truth.

## Migration caveat

The `DocumentProcessedRule`, delivery DLQ, and queue policy move stacks, so
CloudFormation deletes them from Pipeline and recreates them in Worker. The
delivery DLQ is an error-path queue (normally empty). Deploy via
`cdk deploy --all` so ordering is handled (Pipeline → StreamingRag → Worker).

## Verification

From `packages/cdk` (per CLAUDE.md "Verifying Before You Commit"):

1. `yarn build` — TypeScript compiles.
2. `yarn cdk synth --all` — succeeds with **no dependency cycle**.
3. Inspect synthesized templates:
   - `DocumentWorkerStack-*`: has `FrontendAccessRole` with the four policy
     statements (exact actions, ARNs resolved via `Fn::ImportValue` for the
     bucket and RAG function), the relocated `DocumentProcessedRule` + delivery
     DLQ, and the `FrontendAccessRoleArn` output.
   - `DocumentIngestionPipelineStack-*`: no longer contains `DocumentProcessedRule`,
     the delivery DLQ, or the queue policy; still has `S3ObjectAddedRule`.
4. Confirm the end-to-end event path is intact: an `Object Created` on the upload
   bucket still triggers vectorization, and a `DocumentProcessed` event still
   lands on the worker queue (post-deploy smoke test, or assert the rule's
   event pattern/target in the synth output).
5. (Optional, post-deploy) assume the role; confirm a PutObject to the upload
   bucket and an invoke of the RAG Function URL succeed.
