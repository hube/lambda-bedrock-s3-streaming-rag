# IAM User for Frontend Access — Design

**Date:** 2026-06-11

## Context

The DocumentWorker.com frontend (deployed on Hetzner for prod, AWS Lightsail for dev, and run locally) needs credentials to assume `frontendAccessRole` in `DocumentWorkerStack` and drive the RAG system. Previously the role's trust policy used `AccountPrincipal`, allowing any principal in the account to assume it, but no IAM user was provisioned for the frontend.

## Decision

Add an IAM user, access key, and Secrets Manager secret to `DocumentWorkerStack`, alongside the existing `frontendAccessRole`. Narrow the role's trust policy from `AccountPrincipal` (whole account) to `ArnPrincipal` scoped to the specific user.

**Rejected alternatives:**
- New `FrontendCredentialsStack` — adds deployment complexity without benefit; user and role belong together
- Lambda-backed custom resource for key generation — avoids secret in CloudFormation state but is significant overkill given Secrets Manager's own IAM controls

## Architecture

```
IAM user (docworker-frontend-{env})
  └─ sts:AssumeRole → frontendAccessRole  ← trust policy scoped to this user only
       └─ S3 PutObject/DeleteObject (unprocessed docs bucket)
       └─ SQS Consume (vectorization events queue)
       └─ SQS Send (consumer DLQ)
       └─ lambda:InvokeFunctionUrl (RAG query function)
```

When a directly-named `ArnPrincipal` is the sole entry in a role's trust policy, the trust policy alone grants `sts:AssumeRole` permission — no identity-based policy on the user is required (same-account rule).

## Resources

All added to `DocumentWorkerStack` (`packages/cdk/lib/document-worker-stack.ts`):

| Construct | CDK class | Logical name |
|---|---|---|
| IAM user | `iam.User` | `docworker-frontend-${env}` |
| Access key | `iam.CfnAccessKey` | (tied to user) |
| Secrets Manager secret | `secretsmanager.CfnSecret` | `docworker-frontend-credentials-${env}` |
| Role trust | updated `assumedBy` | `ArnPrincipal(frontendUser.userArn)` |

Secret format: `{ "accessKeyId": "...", "secretAccessKey": "..." }` stored via `cdk.Fn.sub` for CloudFormation token resolution.

## Known Limitations

`iam.CfnAccessKey`'s `SecretAccessKey` attribute is stored in CloudFormation stack state. Anyone with `cloudformation:DescribeStackResource` on this stack can retrieve it. Restrict that permission to ops roles only.

## Operator Notes

- Retrieve credentials: `aws secretsmanager get-secret-value --secret-id docworker-frontend-credentials-{env}`
- Frontend calls `sts:AssumeRole` on the role ARN to get temporary credentials (default max session: 1 hour); implement credential refresh before expiry
