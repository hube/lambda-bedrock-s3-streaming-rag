# IAM User for Frontend Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an IAM user to `DocumentWorkerStack` whose static access key allows the deployed frontend (Hetzner/Lightsail/local) to assume `frontendAccessRole` and drive the RAG system.

**Architecture:** An `iam.User` is created first, then `frontendAccessRole`'s trust policy is narrowed from `AccountPrincipal` (whole account) to `ArnPrincipal(documentWorkerFrontendUser.userArn)`. An `iam.AccessKey` is created and its secret access key is stored in a `secretsmanager.Secret` as a plain string. The frontend reads the secret from Secrets Manager at startup and calls `sts:AssumeRole` to obtain temporary credentials.

**Tech Stack:** AWS CDK v2, TypeScript, `aws-cdk-lib/aws-iam`, `aws-cdk-lib/aws-secretsmanager`

---

## Files

| Action | Path |
|--------|------|
| Modify | `packages/cdk/lib/document-worker-stack.ts` |

---

## Task 1: Update DocumentWorkerStack

**Files:**
- Modify: `packages/cdk/lib/document-worker-stack.ts`

- [x] **Step 1: Add `secretsmanager` import**

Add after the existing `s3` import:

```typescript
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
```

- [x] **Step 2: Create the IAM user before the role**

Replace the existing `frontendAccessRole` block with the user construct inserted immediately before it:

```typescript
const documentWorkerFrontendUser = new iam.User(
  this,
  "DocumentWorkerFrontendUser",
  {
    userName: `docworker-frontend-${env}`,
  },
);

this.frontendAccessRole = new iam.Role(this, "FrontendAccessRole", {
  roleName: `docworker-frontend-access-${env}-${this.region}`,
  assumedBy: new iam.ArnPrincipal(documentWorkerFrontendUser.userArn),
  description:
    "DocumentWorker frontend: scoped access to drive the RAG system",
});
```

`ArnPrincipal` narrows trust from the whole account to only this user. For same-account assume-role with a directly-named principal, the trust policy alone is sufficient — no identity-based `sts:AssumeRole` policy is needed on the user.

- [x] **Step 3: Add access key and Secrets Manager secret after the existing grants**

After `props.ragFunction.grantInvokeUrl(this.frontendAccessRole)`, append:

```typescript
const accessKey = new iam.AccessKey(
  this,
  "DocumentWorkerFrontendUserAccessKey",
  { user: documentWorkerFrontendUser },
);

new secretsmanager.Secret(this, "DocumentWorkerFrontendUserCredentials", {
  secretName: `docworker-frontend-credentials-${env}`,
  description: `Secret access key for the docworker-frontend-${env} IAM user`,
  secretStringValue: accessKey.secretAccessKey,
});
```

The secret stores only the secret access key as a plain string. The access key ID (not sensitive) is retrievable via `aws iam list-access-keys --user-name docworker-frontend-{env}`.

- [x] **Step 4: Run typecheck, lint, and format check**

```bash
cd packages/cdk
yarn build
yarn lint
yarn format:check
```

Expected: all three exit 0.

- [x] **Step 5: Run CDK synth and verify template**

```bash
cd packages/cdk
yarn cdk synth --all 2>&1 | tail -3
```

```bash
node -e "
const t = JSON.parse(require('fs').readFileSync(
  'cdk.out/DocumentWorkerStack-dev.template.json', 'utf8'
));
const types = Object.values(t.Resources).map(r => r.Type);
console.log('IAM::User:', types.includes('AWS::IAM::User'));
console.log('IAM::AccessKey:', types.includes('AWS::IAM::AccessKey'));
console.log('SecretsManager::Secret:', types.includes('AWS::SecretsManager::Secret'));
"
```

- [x] **Step 6: Commit**

```bash
git add packages/cdk/lib/document-worker-stack.ts
git commit -m "feat(cdk): add frontend IAM user and credentials for DocumentWorkerStack"
```

**Commits:** `3cbdd9c` (initial) → `6394d19` (rename to DocumentWorkerFrontendUser) → `f394ef1` (L2 constructs) → `aec96c4` (secret access key only)
