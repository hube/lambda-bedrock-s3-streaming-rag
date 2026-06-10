# Parameterize CDK stacks for multiple environments & regions

## Context

The three CDK stacks (`DocumentWorkerStack`, `DocumentIngestionPipelineStack`,
`StreamingRagStack`) are instantiated in `packages/cdk/bin/app.ts` with **hardcoded stack IDs**
and **no `env`**, so account/region come from whatever CLI credentials are active. There's no
way to stand up more than one isolated deployment.

Critically, deploying two environments into the **same account+region** would collide on the
shared **default EventBridge bus**: `DocumentProcessedRule` (in the pipeline stack) matches
`source: ["documentworker.rag"]` with no environment qualifier, and the handler publishes with
that same bare source (`EVENT_SOURCE = "documentworker.rag"` in `data-pipeline/lib/index.mts`).
A second environment's `DocumentProcessed` events would be cross-delivered to **both**
environments' worker queues. CDK-auto-generated physical names also make it hard to tell which
environment/region a resource in the AWS console belongs to.

The per-env qualified source is also being renamed from the bare `documentworker.rag` to
`DocumentVectorizationPipeline.<envName>` to match the pipeline's name. **This is a deliberate
break of the published event contract** — internally consistent because the rule pattern and the
publisher move in lockstep, but any *external* consumer keyed on `documentworker.rag` must be
updated. The schema doc is updated to reflect it (§8).

Goal: let the same stacks deploy to different named environments — including multiple
environments in the **same** account+region — with no resource-name collisions, no
cross-environment event leakage, and console-legible resource names.

## Locked decisions

- **Env selection:** env-keyed config files under `packages/cdk/config/`, chosen via CDK
  context (`cdk deploy -c env=alpha`); bare `cdk deploy` defaults to `dev`.
- **Account/region:** specified explicitly per environment in config. **Placeholder** values
  for now — the user fills in real account ids / regions later.
- **Event isolation:** keep the default bus; qualify the event source per env
  (`DocumentVectorizationPipeline.<envName>`). The event source is **required** (no default)
  end-to-end.
- **Naming:** append the env name to stack IDs **and** give the key resources explicit physical
  names that embed the environment and region (S3 buckets also embed the account for global
  uniqueness) so the console clearly shows what's being accessed.
- **Per-env scope (YAGNI):** only `account`, `region`, and the derived event source vary.
  Function URL auth, removal policies, Lambda sizing stay as-is for all envs.

## Shape of the change

```
config/{dev,alpha,prod}.ts ──┐
                             ├─> config/index.ts
config/types.ts ─────────────┘   getEnvironmentConfig(name)  eventSourceFor(environmentName)
                                                              => DocumentVectorizationPipeline.<env>
                                       │                          │
                                       ▼                          ▼
                 bin/app.ts: env={account,region}, environmentName, eventSource
                                       │
       ┌───────────────────────────────┼───────────────────────────────┐
       ▼                               ▼                                ▼
 DocumentWorkerStack-<env>   StreamingRagStack-<env>      DocumentIngestionPipelineStack-<env>
 (env, environmentName)      (env, environmentName)       (env, environmentName, eventSource)
   └─ named queues/dlq         └─ named function            ├─ named buckets/lambda/dlq
                                                            ├─ Lambda env var: eventSource (required)
                                                            └─ DocumentProcessedRule source: [eventSource]
                                                                       │
                                                          data-pipeline/lib/index.mts
                                                          requires eventSource; publishes Source: cfg().eventSource
```

The event source is load-bearing: the **rule pattern** (CDK) and the **published event Source**
(Lambda) must use the same per-env value, or routing breaks. Making it required means the Lambda
fails fast if the env var is ever missing rather than silently publishing the bare source.

## Changes

### 1. New config module — `packages/cdk/config/`

- `types.ts` — exported interface:
  ```ts
  export interface EnvironmentConfig {
    name: string;     // 'dev' | 'alpha' | 'prod' | ...
    account: string;  // AWS account id
    region: string;   // AWS region (must be a key in the napi-rs-canvas CfnMapping)
  }
  ```
- `dev.ts`, `alpha.ts`, `prod.ts` — one `EnvironmentConfig` each, with **placeholder**
  `account` / `region` values and a comment telling the user to fill them in (for same-account
  multi-env they repeat the same `account`; `region` must be a key in the pipeline stack's
  CfnMapping). `dev` MUST exist (it's the default). **Keep `name` short** — it is embedded in S3
  bucket names alongside region+account, which must stay ≤ 63 chars (see §4).
- `index.ts` — aggregate the env files into a `Record<string, EnvironmentConfig>` and export:
  - `getEnvironmentConfig(name: string): EnvironmentConfig` — throws a clear error listing the
    valid names when `name` is unknown.
  - `eventSourceFor(environmentName: string): string` — returns
    `` `DocumentVectorizationPipeline.${environmentName}` `` (parameter named `environmentName`).

### 2. `packages/cdk/tsconfig.json`

`include` is currently `["bin/*", "lib/*"]`. Add `"config/*"`:
```json
"include": ["bin/*", "lib/*", "config/*"]
```
Rationale: `tsc` already reaches the config files transitively via `bin/app.ts`'s import, and
`eslint .` / `prettier --check .` scan by path regardless of `include`, so this is **not
load-bearing for any check** — it's added for explicitness so the module is a first-class root of
the composite build. Harmless either way.

### 3. `packages/cdk/bin/app.ts`

- `const envName = app.node.tryGetContext("env") ?? "dev";`
- `const cfg = getEnvironmentConfig(envName);`
- `const env = { account: cfg.account, region: cfg.region };`
- Suffix every stack ID and pass `env` + `environmentName` (+ `eventSource` for the pipeline):
  - `` new DocumentWorkerStack(app, `DocumentWorkerStack-${cfg.name}`, { env, environmentName: cfg.name, description: ... }) ``
  - `` new DocumentIngestionPipelineStack(app, `DocumentIngestionPipelineStack-${cfg.name}`, { env, environmentName: cfg.name, eventSource: eventSourceFor(cfg.name), documentProcessedQueue: workerStack.queue, description }) ``
  - `` new StreamingRagStack(app, `StreamingRagStack-${cfg.name}`, { env, environmentName: cfg.name, vectorDbBucket: pipelineStack.vectorDbBucket, description }) ``

### 4. Explicit, console-legible resource names (all three stacks)

Because `env` is now pinned, `this.account` / `this.region` resolve to concrete strings at synth
(no unresolved tokens), so they can be interpolated into physical names. In each stack add
`environmentName: string` to its props interface (make `DocumentWorkerStack`'s props a required
interface instead of the current optional `cdk.StackProps`), then set explicit names:

- **SQS queues/DLQs** (`DocumentWorkerStack` queue + dlq, pipeline's `DocumentProcessedDeliveryDlq`):
  `queueName: \`<base>-${props.environmentName}-${this.region}\`` (e.g.
  `document-processed-dev-us-east-1`).
- **Lambda functions** (`DocumentVectorizationFunction`, `StreamingRAGFunction`):
  `functionName: \`<base>-${props.environmentName}-${this.region}\`` (within Lambda's 64-char limit).
- **S3 buckets** (`UnprocessedDocumentsBucket`, `VectorDbBucket`): also append the account for
  global uniqueness, all lowercase:
  `bucketName: \`<base>-${props.environmentName}-${this.region}-${this.account}\``
  (e.g. `unprocessed-documents-dev-us-east-1-123456789012`). **Length guard:** base + env +
  region + account must stay ≤ 63 chars — keep `name` short and base names compact.

Keep the existing `RemovalPolicy.DESTROY` and all other resource config unchanged. (Importing the
worker queue by ARN in the pipeline stack is unaffected by giving the queue an explicit name.)

### 5. `packages/cdk/lib/document-ingestion-pipeline-stack.ts`

- Add `environmentName: string` and `eventSource: string` to
  `DocumentIngestionPipelineStackProps` (with doc comments).
- Add `eventSource: props.eventSource` to the Lambda `environment` block (alongside the existing
  vars). Apply the explicit `functionName` / `bucketName` / `queueName` from §4.
- Replace `source: ["documentworker.rag"]` in `DocumentProcessedRule` with
  `source: [props.eventSource]`.
- IAM (`events:PutEvents` on the default bus) unchanged. `findInMap(this.region, ...)` resolves
  concretely now (behavior unchanged; still fails for an unmapped region).

### 6. `packages/data-pipeline/lib/index.mts` — make `eventSource` required

- Add `eventSource: undefined` to `ENV_DEFAULTS` (an `undefined` default marks it **required**
  in the existing `requireConfig()` logic).
- Add `eventSource: process.env.eventSource!` to the `cfg()` object (non-null, same pattern as
  `vectorDbS3BucketName`).
- In `publishDocumentProcessed`, emit `Source: cfg().eventSource`.
- **Remove the now-unused `EVENT_SOURCE` constant** (would otherwise trip no-unused-vars). Keep
  `DETAIL_TYPE` and `SCHEMA_VERSION`. Move the "contract-fixed" rationale comment to a brief note
  on the `eventSource` line in `cfg()` / the schema doc.

### 7. Tests — `packages/data-pipeline/test/...`

- `test/unit/setup.mts`: add `process.env.eventSource = "DocumentVectorizationPipeline.test";`
  alongside the other seeded vars so all unit handler tests satisfy `requireConfig()`. (C.16
  deletes only `vectorDbS3BucketName`, so its "Missing required env var(s): vectorDbS3BucketName"
  assertion still holds with `eventSource` set.)
- `test/unit/handler.test.mts`: in the "handler — EventBridge event shape" describe block (C.15
  uses the existing `getPublishedEntry` helper), add a sibling assertion that the published
  entry's `Source` equals `"DocumentVectorizationPipeline.test"` — new coverage tying the env var
  to the published source.
- `test/integration/handler.test.mts` (+ `test/integration/setup.mts`): set
  `process.env.eventSource = "DocumentVectorizationPipeline.test";` (preferably in
  `test/integration/setup.mts` for consistency with the unit setup, or `beforeAll`), and change
  the rule's `EventPattern` to
  `JSON.stringify({ source: ["DocumentVectorizationPipeline.test"] })` so the handler's published
  source still routes to the queue.

### 8. Docs — `docs/Eventbridge event schema.md`

Note that `source` is environment-qualified and renamed: `DocumentVectorizationPipeline.<env>`
(e.g. `DocumentVectorizationPipeline.dev`), not the bare `documentworker.rag`. Update the example
JSON's `"source"` and add a one-line explanation.

## Deploying to an environment (credentials)

Each env config pins `account` + `region`, so the **stack resources always land in the
configured region/account regardless of the caller's default region**, and CDK refuses to deploy
if the resolved credentials' account doesn't match the config's `account`. The user supplies
credentials through the standard AWS chain; the cleanest convention is a **named profile per
environment**:

```bash
cd packages/cdk
cdk deploy --all -c env=alpha --profile alpha   # [profile alpha] account must match alpha.ts
```

(Or SSO / `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`+`AWS_SESSION_TOKEN` env vars.) No code maps
profiles to envs — that's an ops/CLI concern, documented here and worth a line in the CDK README.
First-time deploy into a new account/region still needs `cdk bootstrap` (run with the same
`--profile` / `-c env=`).

## Files

| File | Change |
| --- | --- |
| `packages/cdk/config/types.ts` | new — `EnvironmentConfig` interface |
| `packages/cdk/config/{dev,alpha,prod}.ts` | new — per-env account/region (placeholders) |
| `packages/cdk/config/index.ts` | new — lookup + default + `eventSourceFor(environmentName)` |
| `packages/cdk/tsconfig.json` | add `config/*` to `include` |
| `packages/cdk/bin/app.ts` | context env, set `env`, suffix stack IDs, pass `environmentName` + `eventSource` |
| `packages/cdk/lib/document-worker-stack.ts` | required props w/ `environmentName`; named queue + dlq |
| `packages/cdk/lib/document-ingestion-pipeline-stack.ts` | `environmentName`+`eventSource` props → named resources, Lambda env var, rule pattern |
| `packages/cdk/lib/streaming-rag-stack.ts` | `environmentName` prop; named function |
| `packages/data-pipeline/lib/index.mts` | `eventSource` **required** via `ENV_DEFAULTS`/`cfg()`; drop `EVENT_SOURCE` |
| `packages/data-pipeline/test/unit/setup.mts` | seed `eventSource=DocumentVectorizationPipeline.test` |
| `packages/data-pipeline/test/unit/handler.test.mts` | assert published `Source` |
| `packages/data-pipeline/test/integration/{setup,handler}.test.mts` | set env var + rule pattern to `DocumentVectorizationPipeline.test` |
| `docs/Eventbridge event schema.md` | document env-qualified source |

## Verification

Per CLAUDE.md, run checks **before** committing; state only observed results.

**Data-pipeline Lambda** (`packages/data-pipeline`):
- `yarn typecheck && yarn lint && yarn format:check && yarn build`
- `yarn test` (unit only — the default `test` script = `vitest run --project unit`) → passes with
  `eventSource` seeded and the new `Source` assertion.
- `yarn test:integration` (Docker/LocalStack; skips if Docker absent) → the rule and published
  source both `DocumentVectorizationPipeline.test`, so routing still works.

**CDK** (`packages/cdk`):
- `yarn build && yarn lint && yarn format:check`
- `yarn cdk synth --all` → stacks named `*-dev`; no dependency cycle; resource names embed
  `dev` + region (buckets also account).
- `yarn cdk synth --all -c env=alpha` → stacks named `*-alpha`; in the templates confirm:
  (a) the pipeline Lambda's `eventSource` env var is `DocumentVectorizationPipeline.alpha`,
  (b) `DocumentProcessedRule` `EventPattern.source` is `["DocumentVectorizationPipeline.alpha"]`,
  (c) stack region matches `alpha`'s configured region, and (d) resource names embed
  `alpha` + region.
- `yarn cdk synth -c env=bogus` → fails with a clear "unknown environment" error listing valid
  names.

After all checks pass: commit on a branch, push with `git push -u`, and open a PR.
