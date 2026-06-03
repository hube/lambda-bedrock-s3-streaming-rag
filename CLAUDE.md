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
| `packages/cdk`                | CDK app defining two stacks                                           |

## Architecture Flow

### Query path (`packages/rag-query-function/lib/index.mts`)

1. Client POSTs `{ query, model?, streamingFormat? }` to the streaming Lambda's Function URL.
2. The handler connects to LanceDB on S3, embeds the query via Titan, retrieves relevant chunks, then streams the LLM response back token-by-token.
3. Two streaming formats are supported: raw chunks (default) and SSE (`fetch-event-source`).

### Ingestion path (`packages/data-pipeline/lib/index.mts`)

This is **event-driven**:

1. A PDF is uploaded to the **unprocessed-documents S3 bucket** (created with `eventBridgeEnabled: true`). The key convention is `<userId>/<documentGroupId>/<filename>-<uuid>.pdf`.
2. S3 emits an **`Object Created`** event to the **default EventBridge bus**.
3. An EventBridge rule (`S3ObjectAddedRule`, `source: aws.s3`, `detailType: Object Created`, scoped to the bucket) targets the ingestion Lambda.
4. The Lambda downloads the PDF to `/tmp`, extracts text with `pdf-parse` (needs the `napi-rs-canvas` Lambda layer for `DOMMatrix`), chunks it (size 1000 / overlap 200), embeds each chunk via Bedrock Titan, derives `userId`/`documentGroupId` by splitting the S3 key, and writes records to LanceDB at `s3://<vectorDbBucket>/<userId>/<documentGroupId>/`, table `vectorstore` (creates the table or appends).

So ingestion is **S3 → EventBridge (inbound) → Lambda → LanceDB on S3**. There are **two buckets**: the unprocessed-uploads bucket and the vector-DB bucket.

## CDK Stacks (`packages/cdk`)

- `lib/document-ingestion-pipeline-stack.ts` — `DocumentIngestionPipelineStack`: unprocessed + vector-DB buckets, ingestion Lambda (Node.js 22, x86_64, 15-min timeout, 512 MB, X-Ray active), the napi-rs-canvas layer, S3 + Bedrock IAM, and the inbound EventBridge rule. Exposes `vectorDbBucket` (consumed by the query stack).
- `lib/streaming-rag-stack.ts` — `StreamingRagStack`: query Lambda (Node.js 24, ARM64, 300s, 256 MB, X-Ray active), Bedrock + S3-read IAM, and the streaming Function URL with CORS. Takes `vectorDbBucket` as a prop.
- `bin/app.ts` — wires the two stacks; the pipeline stack's `vectorDbBucket` is passed into the query stack.

## Lambda Environment Variables

`rag-query-function` reads:

| Variable       | Source                   |
| -------------- | ------------------------ |
| `s3BucketName` | Vector-DB S3 bucket name |
| `region`       | AWS region               |
| `lanceDbTable` | `vectorstore`            |

`data-pipeline` reads:

| Variable                | Source                   |
| ----------------------- | ------------------------ |
| `vectorDbS3BucketName`  | Vector-DB S3 bucket name |
| `awsRegion`             | AWS region               |
| `lanceDbTableName`      | `vectorstore`            |
| `eventBusName`          | `default`                |

## Deploy with CDK

```bash
cd packages/cdk
yarn install
npx cdk bootstrap     # First time only
npx cdk deploy --all  # Deploys both stacks
```

Bundling runs `yarn build` + `yarn workspaces focus --production` for each function, locally if Node is present, otherwise inside the CDK Docker bundling image.

To deploy the query Function URL with no auth (public access), set `functionUrlAuthType: lambda.FunctionUrlAuthType.NONE` for `StreamingRagStack` in `bin/app.ts` (default is `AWS_IAM`).

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
| `packages/cdk/bin/app.ts`                               | CDK app entry point (wires the two stacks)                             |
| `docs/Eventbridge event schema.md`                      | Contract for the outbound `DocumentProcessed` event                    |
| `testing/react/src/App.js`                              | React client using `@microsoft/fetch-event-source` with IAM SigV4 auth |

## Bedrock Model Access

The query Lambda's IAM policy allows `anthropic.claude-*` (foundation + `us.` inference profile), `amazon.titan-*`, and `mistral.pixtral-*` (foundation + `eu.` inference profile). The ingestion Lambda is restricted to `amazon.titan-*`. Update the relevant stack to add other model families.

Pass `"model": "<model-id>"` in the request body to override the query model.

## Important Notes

- Confirm the state of the filesystem and git repo prior to making any assumptions about the code
- When adding new dependencies, check for and add the latest versions of those dependencies
- Clearly distinguish between guesses or hypotheses and verified claims. Describe how verified claims were verified
- The `@lancedb` / `pdf-parse` packages contain native binaries; CDK bundling compiles/installs them for the Lambda Linux runtime (locally if Node is available, otherwise via Docker).
- LanceDB connects directly to S3 at runtime — no EFS or local disk needed.
- The LanceDB table name is always `vectorstore` (env var `lanceDbTable` in the query function, `lanceDbTableName` in the data-pipeline).
- The ingestion Lambda needs the public `napi-rs-canvas` Lambda layer; its version is region-specific (see the `CfnMapping` in the pipeline stack). Deploying to an unlisted region fails at CloudFormation time.

## Code Comments

- Keep comments minimal and focused on _why_, not _what_. Don't narrate what the code plainly does (e.g. `// Emit one event to EventBridge` above an obvious publish call).
- Don't restate the same rationale in more than one place. When a non-obvious choice (such as importing the worker queue by ARN to avoid a cross-stack dependency cycle) is already explained where it's made, don't repeat that explanation at each related call site — one comment at the source is enough.

## Responding to PR Review Comments

- **Fetch all comment threads before replying to any.** The GitHub API default page size is 30; a PR with many threads silently truncates. Always use `per_page=100` (or paginate) when listing review comments: `gh api "repos/{owner}/{repo}/pulls/{pr}/comments?per_page=100"`. Replying to a partial list leaves threads unanswered and requires another round.
- **Reply in the thread, not as a top-level PR comment.** Use `gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies` with the original comment's ID as `{id}`.
- Provide a summary of changes as a top-level PR comment

## Verifying Before You Commit

- **Run the checks before committing or pushing, not after.** For Lambda code (`packages/data-pipeline`, `packages/rag-query-function`): `yarn typecheck`, `yarn lint`, `yarn format:check`, and `yarn build`. For CDK changes (`packages/cdk`): `yarn build` and `yarn cdk synth --all` (must succeed with no dependency cycle). A change that doesn't compile must never reach a commit.
- **Never state that verification passed unless that exact command ran and succeeded in this session.** Don't write "typecheck/lint/build all pass" in a commit message, PR body, or review reply on the basis of expectation — quote only results you actually observed. Claiming unverified results is worse than saying nothing.
- **Confirm an edit actually applied before relying on it.** If an `Edit` reports the target string wasn't found, the file is unchanged — re-read and redo it; don't assume it landed.
- **Read the real file state, not a remembered or display-garbled version, before editing.** Tool output can be truncated or show artifacts; verify against the file itself.
