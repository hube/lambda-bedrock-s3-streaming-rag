# EventBridge event contract

This is the contract this system MUST publish and that `DocumentEventWorker`
consumes

```json
{
  "version": "0",
  "id": "a8e2c1f0-7d3b-4f9a-b1c2-3e4f5a6b7c8d",
  "detail-type": "DocumentProcessed",
  "source": "DocumentVectorizationPipeline.dev",
  "account": "123456789012",
  "time": "2026-05-26T12:34:56Z",
  "region": "eu-central-1",
  "resources": ["arn:aws:s3:::<bucket>/42/7/2025-tax-return-<uuid>.pdf"],
  "detail": {
    "version": "1",
    "documentUuid": "2b1ae9c0-1234-4567-89ab-cdef01234567",
    "userId": "42",
    "documentGroupId": "7",
    "s3Key": "42/7/2025-tax-return-2b1ae9c0-1234-4567-89ab-cdef01234567.pdf",
    "status": "PROCESSING_COMPLETED",
    "statusDetail": null,
    "processedAt": "2026-05-26T12:34:55Z"
  }
}
```

**Envelope fields:**

- `version` — the EventBridge envelope version. Always `"0"` for custom
  `PutEvents` events; EventBridge sets it and it is not settable by the
  publisher. **Not** the message-schema version — consumers should not rely on
  it for schema versioning (see `detail.version` below).
- `id` — globally unique per-event identifier (a UUID). **Not** a business
  identifier — `detail.documentUuid` is the lookup key.
- `detail-type` — the discriminator for what kind of event this is. The only
  valid value for this field is `"DocumentProcessed"` at this time. Any other
  value should be considered an error
- `source` — the EventBridge source string, environment-qualified:
  `DocumentVectorizationPipeline.<env>` (e.g. `DocumentVectorizationPipeline.dev`).
  Any external consumer previously keyed on `documentworker.rag` must update to the
  environment-qualified value.

**Required `detail` fields:**

- `version` (string) — message-schema version. Set to `"1"` for this initial
  contract. If we ever change the `detail` shape, we will bump this.
- `documentUuid` (string | null) — the lookup key. A non-null string when
  `status="PROCESSING_COMPLETED"`. **May be `null`** when
  `status="PROCESSING_FAILED"` and the S3 key could not be parsed (no UUID); in
  that case `statusDetail` explains why.
- `status` (string) - the only valid values are `"PROCESSING_COMPLETED"` and
  `"PROCESSING_FAILED"`
- `userId` (string | null) - identifies the user the document belongs to.
  Non-null for `PROCESSING_COMPLETED`. For `PROCESSING_FAILED` it is populated
  best-effort from the S3 key prefix (so a key missing only its UUID still
  carries it) and is **`null`** only when the key prefix itself could not be
  parsed.
- `documentGroupId` (string | null) - identifies the document group the document
  belongs to. Non-null for `PROCESSING_COMPLETED`. For `PROCESSING_FAILED` it is
  populated best-effort from the S3 key prefix (so a key missing only its UUID
  still carries it) and is **`null`** only when the key prefix itself could not
  be parsed.
- `s3Key` (string) — the full S3 key to the document. Should be of the form:
  `<userId>/<documentGroupId>/<documentFilename>-<documentUuid>.pdf`
- `statusDetail` (string | null) — **optional, nullable in the JSON**. When
  `status="PROCESSING_FAILED"` the publisher SHOULD include a human-readable
  failure reason here. When `status="PROCESSING_COMPLETED"`, this field may be
  omitted or be null
- `processedAt` (ISO-8601 string) — timestamp when processing of the document
  completed
