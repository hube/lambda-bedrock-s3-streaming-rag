# IAM User for Frontend Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an IAM user to `DocumentWorkerStack` whose static access key allows the deployed frontend (Hetzner/Lightsail/local) to assume `frontendAccessRole` and drive the RAG system.

**Architecture:** An `iam.User` is created first, then `frontendAccessRole`'s trust policy is narrowed from `AccountPrincipal` (whole account) to `ArnPrincipal(frontendUser.userArn)`. An `iam.CfnAccessKey` and a `secretsmanager.CfnSecret` storing `{ accessKeyId, secretAccessKey }` as JSON are added to the same stack. The frontend fetches credentials from Secrets Manager at startup and calls `sts:AssumeRole` to obtain temporary credentials.

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
const frontendUser = new iam.User(this, "FrontendUser", {
  userName: `docworker-frontend-${env}`,
});

this.frontendAccessRole = new iam.Role(this, "FrontendAccessRole", {
  roleName: `docworker-frontend-access-${env}-${this.region}`,
  assumedBy: new iam.ArnPrincipal(frontendUser.userArn),
  description:
    "DocumentWorker frontend: scoped access to drive the RAG system",
});
```

`ArnPrincipal` narrows trust from the whole account to only this user. For same-account assume-role with a directly-named principal, the trust policy alone is sufficient — no identity-based `sts:AssumeRole` policy is needed on the user.

- [x] **Step 3: Add access key and Secrets Manager secret after the existing grants**

After `props.ragFunction.grantInvokeUrl(this.frontendAccessRole)`, append:

```typescript
const accessKey = new iam.CfnAccessKey(this, "FrontendUserAccessKey", {
  userName: frontendUser.userName,
});

new secretsmanager.CfnSecret(this, "FrontendUserCredentials", {
  name: `docworker-frontend-credentials-${env}`,
  description: "Access key for the docworker frontend IAM user",
  secretString: cdk.Fn.sub(
    '{"accessKeyId":"${AccessKeyId}","secretAccessKey":"${SecretAccessKey}"}',
    {
      AccessKeyId: accessKey.ref,
      SecretAccessKey: accessKey.attrSecretAccessKey,
    },
  ),
});
```

`cdk.Fn.sub` renders as CloudFormation `Fn::Sub` so tokens resolve at deploy time.

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
yarn cdk synth --all 2>&1 | head -5
```

```bash
node -e "
const t = JSON.parse(require('fs').readFileSync(
  'cdk.out/DocumentWorkerStack-dev.template.json', 'utf8'
));
const types = Object.values(t.Resources).map(r => r.Type);
console.log('FrontendUser:', types.includes('AWS::IAM::User'));
console.log('FrontendUserAccessKey:', types.includes('AWS::IAM::AccessKey'));
console.log('FrontendUserCredentials:', types.includes('AWS::SecretsManager::Secret'));
"
```

- [x] **Step 6: Commit**

```bash
git add packages/cdk/lib/document-worker-stack.ts
git commit -m "feat(cdk): add frontend IAM user and credentials for DocumentWorkerStack

Creates docworker-frontend-{env} IAM user with a static access key stored
in Secrets Manager. Narrows frontendAccessRole trust from AccountPrincipal
to the specific user ARN."
```

**Committed:** `3cbdd9c`
