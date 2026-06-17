# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A streaming serverless Retrieval Augmented Generation (RAG) system using:

- **Lambda** (Node.js, ESM, TypeScript) — a streaming query function with a Function URL in `RESPONSE_STREAM` mode, plus an event-driven document-ingestion function.
- **LanceDB** backed by S3 for vector/embedding storage
- **Amazon Bedrock** for embeddings (Titan) and chat completions (Claude, Mistral, etc.)
- **LangChain** to wire retriever → prompt → LLM into a streaming chain

This is a **yarn (v4) workspaces monorepo** under `packages/`. Infrastructure is **CDK only**. TypeScript sources live in each package's `lib/*.mts` and are bundled with esbuild at CDK synth time.

## Repo Layout

| Package                       | Purpose                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `packages/rag-query-function` | Streaming RAG query Lambda (LangChain chain, Function URL)            |
| `packages/data-pipeline`      | Document-ingestion Lambda (PDF → chunks → Titan embeddings → LanceDB) |
| `packages/cdk`                | CDK app defining three stacks; environment configs in `packages/cdk/config/` |

## Architecture Flow

### Query path (`packages/rag-query-function/lib/index.mts`)

1. Client POSTs `{ userId, documentGroupId, query, model?, streamingFormat? }` to the streaming Lambda's Function URL. `userId` and `documentGroupId` are required — they select the LanceDB partition to query.
2. The handler connects to LanceDB on S3, embeds the query via Titan, retrieves relevant chunks, then streams the LLM response back token-by-token.
3. Two streaming formats are supported: raw chunks (default) and SSE (`fetch-event-source`).
4. Default model: `us.anthropic.claude-sonnet-4-6`.

### Ingestion path (`packages/data-pipeline/lib/index.mts`)

This is **event-driven**:

1. A PDF is uploaded to the **unprocessed-documents S3 bucket** (created with `eventBridgeEnabled: true`). The key convention is `<userId>/<documentGroupId>/<filename>-<uuid>.pdf`.
2. S3 emits an **`Object Created`** event to the **default EventBridge bus**.
3. An EventBridge rule (`S3ObjectAddedRule`, `source: aws.s3`, `detailType: Object Created`, scoped to the bucket) targets the ingestion Lambda.
4. The Lambda downloads the PDF to `/tmp`, extracts text with `pdf-parse` (needs the `napi-rs-canvas` Lambda layer for `DOMMatrix`), chunks it (size 1000 / overlap 200), embeds each chunk via Bedrock Titan, derives `userId`/`documentGroupId` by splitting the S3 key, and writes records to LanceDB at `s3://<vectorDbBucket>/<userId>/<documentGroupId>/`, table `vectorstore` (creates the table or appends). Each record stores `vector`, `text`, and `sourceS3ObjectKey`.
5. After writing, the Lambda publishes a `DocumentProcessed` event (source: `DocumentVectorizationPipeline.<env>`, detailType: `DocumentProcessed`) to the default EventBridge bus. On failure it publishes `PROCESSING_FAILED` instead and returns normally (no rethrow) to avoid EventBridge retrying a partially-processed document.
6. **Idempotency**: before embedding, the Lambda queries LanceDB for `sourceS3ObjectKey = '<key>'`. If found, it skips the document and publishes no event. This guards against EventBridge at-least-once redelivery.

So ingestion is **S3 → EventBridge (inbound) → Lambda → LanceDB on S3 + EventBridge (outbound)**. There are **two buckets**: the unprocessed-uploads bucket and the vector-DB bucket.

## CDK Stacks (`packages/cdk`)

Three stacks, all suffixed with the environment name (e.g., `DocumentIngestionPipelineStack-dev`). The environment is selected via `--context env=<name>` (default: `dev`); configs live in `packages/cdk/config/{dev,alpha,prod}.ts`.

- `lib/document-ingestion-pipeline-stack.ts` — `DocumentIngestionPipelineStack`: unprocessed + vector-DB buckets, ingestion Lambda (Node.js 22, x86_64, 15-min timeout, 512 MB, X-Ray active), the napi-rs-canvas layer, S3 + Bedrock IAM, `events:PutEvents` on the default bus, and the inbound EventBridge rule. Exposes `unprocessedDocumentsBucket` and `vectorDbBucket`.
- `lib/streaming-rag-stack.ts` — `StreamingRagStack`: query Lambda (Node.js 24, ARM64, 300s, 256 MB, X-Ray active), Bedrock + S3-read IAM, `aws-marketplace:ViewSubscriptions/Subscribe` (required by some Bedrock models), and the streaming Function URL with CORS. Takes `vectorDbBucket` as a prop. Exposes `lambdaFunction`.
- `lib/document-worker-stack.ts` — `DocumentWorkerStack`: SQS queue (`document-vectorization-events-<env>-<region>`) + DLQ that receives outbound `DocumentProcessed` events via an EventBridge rule; IAM user `docworker-frontend-<env>` with access key stored in Secrets Manager; IAM role `docworker-frontend-access-<env>-<region>` (assumed by the IAM user) with scoped permissions to upload/delete documents, consume the SQS queue, and invoke the RAG Function URL. Takes `unprocessedDocumentsBucket` and `ragFunction` as props.
- `bin/app.ts` — wires the three stacks.

## Lambda Environment Variables

`rag-query-function` reads:

| Variable       | Source                   |
| -------------- | ------------------------ |
| `s3BucketName` | Vector-DB S3 bucket name |
| `region`       | AWS region               |
| `lanceDbTable` | `vectorstore`            |

`data-pipeline` reads:

| Variable                | Source                                              |
| ----------------------- | --------------------------------------------------- |
| `vectorDbS3BucketName`  | Vector-DB S3 bucket name                            |
| `awsRegion`             | AWS region                                          |
| `lanceDbTableName`      | `vectorstore`                                       |
| `eventBusName`          | `default`                                           |
| `eventSource`           | `DocumentVectorizationPipeline.<env>` (required)    |

## Deploy with CDK

```bash
cd packages/cdk
yarn install
npx cdk bootstrap --context env=dev     # First time only
npx cdk deploy --all --context env=dev  # Replace "dev" with "alpha" or "prod"
```

Bundling runs `yarn build` + `yarn workspaces focus --production` for each function, locally if Node is present, otherwise inside the CDK Docker bundling image.

To deploy the query Function URL with no auth (public access), pass `functionUrlAuthType: lambda.FunctionUrlAuthType.NONE` in `bin/app.ts` when constructing `StreamingRagStack` (default is `AWS_IAM`).

## Ingest Documents

Upload a PDF to the unprocessed-documents bucket under a `<userId>/<documentGroupId>/` prefix; the ingestion Lambda fires automatically via EventBridge. (Non-`.pdf` keys are skipped.)

## Testing

```bash
# No auth
cd testing
./test-no-auth.sh <stack-name>

# IAM auth (requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION set)
./test-with-auth.sh <stack-name>

# React UI (requires the same env vars as IAM auth above)
export STACK_NAME=<stack-name>
export LAMBDA_ENDPOINT_URL=$(aws cloudformation describe-stacks --stack-name $STACK_NAME \
  --query 'Stacks[0].Outputs[?OutputKey==`StreamingRAGFunctionURL`].OutputValue' --output text)
cd testing/react && npm install && npm start
```

`testing/event.json` contains the sample POST body for curl tests.

## Key Files

| Path                                                    | Purpose                                                                |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/rag-query-function/lib/index.mts`             | Streaming RAG query handler                                            |
| `packages/data-pipeline/lib/index.mts`                  | Document-ingestion handler (S3/EventBridge-triggered)                  |
| `packages/cdk/lib/streaming-rag-stack.ts`               | Query Lambda + Function URL                                            |
| `packages/cdk/lib/document-ingestion-pipeline-stack.ts` | Buckets + ingestion Lambda + inbound EventBridge rule                  |
| `packages/cdk/lib/document-worker-stack.ts`             | SQS queue for DocumentProcessed events + frontend IAM user/role        |
| `packages/cdk/bin/app.ts`                               | CDK app entry point (wires the three stacks)                           |
| `packages/cdk/config/`                                  | Per-environment configs (`dev`, `alpha`, `prod`)                       |
| `docs/Eventbridge event schema.md`                      | Contract for the outbound `DocumentProcessed` event                    |
| `testing/react/src/App.js`                              | React client using `@microsoft/fetch-event-source` with IAM SigV4 auth |

## Bedrock Model Access

The query Lambda's IAM policy allows `anthropic.claude-*` (foundation + `us.` inference profile), `amazon.titan-*`, and `mistral.pixtral-*` (foundation + `eu.` inference profile). The ingestion Lambda is restricted to `amazon.titan-*`. Update the relevant stack to add other model families.

Pass `"model": "<model-id>"` in the request body to override the query model.

## Important Notes

- The `@lancedb` / `pdf-parse` packages contain native binaries; CDK bundling compiles/installs them for the Lambda Linux runtime (locally if Node is available, otherwise via Docker).
- LanceDB connects directly to S3 at runtime — no EFS or local disk needed.
- The LanceDB table name is always `vectorstore` (env var `lanceDbTable` in the query function, `lanceDbTableName` in the data-pipeline).
- The ingestion Lambda needs the public `napi-rs-canvas` Lambda layer; its version is region-specific (see the `CfnMapping` in the pipeline stack). Deploying to an unlisted region fails at CloudFormation time.

## Verifying Before You Commit

For Lambda code (`packages/data-pipeline`, `packages/rag-query-function`): run `yarn typecheck`, `yarn lint`, `yarn format:check`, and `yarn build`. For CDK changes (`packages/cdk`): run `yarn build` and `yarn cdk synth --all` (must succeed with no dependency cycle).
