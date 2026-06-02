import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { BedrockEmbeddings } from "@langchain/aws";
import * as lancedb from "@lancedb/lancedb";
import { createWriteStream, readFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { CanvasFactory } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const cfg = () => ({
  bucket: process.env.s3BucketName!,
  region: process.env.region ?? "us-east-1",
  table: process.env.lanceDbTable ?? "vectorstore",
  eventBus: process.env.eventBusName ?? "default",
});

// s3BucketName has no safe default (unlike region/table/eventBus), and an
// unset value otherwise leaks downstream as an opaque "s3://undefined/..."
// LanceDB error. Validate it at handler entry so a misconfigured deployment
// fails with a clear, attributable message before any S3/Bedrock work.
function requireConfig(): void {
  const missing = (["s3BucketName"] as const).filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}`);
  }
}

let _s3: S3Client | undefined;
const s3 = () => (_s3 ??= new S3Client({ region: cfg().region }));
let _eb: EventBridgeClient | undefined;
const eventBridge = () =>
  (_eb ??= new EventBridgeClient({ region: cfg().region }));

const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

// Contract-fixed values for the outbound DocumentProcessed event
// (see docs/Eventbridge event schema.md).
const EVENT_SOURCE = "documentworker.rag";
const DETAIL_TYPE = "DocumentProcessed";
const SCHEMA_VERSION = "1";

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/i;

interface ParsedKey {
  userId: string;
  documentGroupId: string;
  documentUuid: string;
}

// Derive the business identifiers from the S3 key, which follows the convention
// <userId>/<documentGroupId>/<filename>-<uuid>.pdf. Parsing can always fail, so
// this throws (naming the missing element(s)) when any identifier is absent; the
// caller surfaces that as a PROCESSING_FAILED event rather than letting a
// malformed key pass downstream.
function parseKey(key: string): ParsedKey {
  const [userId, documentGroupId] = key.split("/");
  const documentUuid = key.match(UUID_RE)?.[1];

  const missing: string[] = [];
  if (!userId) missing.push("userId");
  if (!documentGroupId) missing.push("documentGroupId");
  if (!documentUuid) missing.push("documentUuid");
  if (!userId || !documentGroupId || !documentUuid) {
    throw new Error(
      `Could not parse [${missing.join(", ")}] from S3 key: ${key}`,
    );
  }

  return { userId, documentGroupId, documentUuid };
}

interface DocumentProcessedDetail {
  // Identifiers are non-null for PROCESSING_COMPLETED but may be null for
  // PROCESSING_FAILED when the S3 key could not be parsed (see schema doc).
  documentUuid: string | null;
  userId: string | null;
  documentGroupId: string | null;
  bucket: string;
  key: string;
  status: "PROCESSING_COMPLETED" | "PROCESSING_FAILED";
  statusDetail: string | null;
}

async function publishDocumentProcessed({
  documentUuid,
  userId,
  documentGroupId,
  bucket,
  key,
  status,
  statusDetail,
}: DocumentProcessedDetail): Promise<void> {
  const result = await eventBridge().send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: cfg().eventBus,
          Source: EVENT_SOURCE,
          DetailType: DETAIL_TYPE,
          Resources: [`arn:aws:s3:::${bucket}/${key}`],
          Detail: JSON.stringify({
            version: SCHEMA_VERSION,
            documentUuid,
            userId,
            documentGroupId,
            s3Key: key,
            status,
            statusDetail,
            processedAt: new Date().toISOString(),
          }),
        },
      ],
    }),
  );
  if (result.FailedEntryCount && result.FailedEntryCount > 0) {
    const detail =
      result.Entries?.filter((e) => e.ErrorCode)
        .map((e) => `${e.ErrorCode}: ${e.ErrorMessage}`)
        .join("; ") || "no entry detail returned";
    throw new Error(`PutEvents failed for ${key}: ${detail}`);
  }
  console.log(`Published DocumentProcessed (${status}) for ${key}`);
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks;
}

async function downloadFromS3(bucket: string, key: string): Promise<string> {
  const tmpPath = join(tmpdir(), basename(key));
  const response = await s3().send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  await pipeline(response.Body as Readable, createWriteStream(tmpPath));
  return tmpPath;
}

// Idempotency guard: returns true if this exact S3 key has already been
// ingested into the tenant's LanceDB table. EventBridge S3 delivery is
// at-least-once, so a redelivered event must not re-embed/re-append or publish a
// second DocumentProcessed event. Detection is non-atomic (two simultaneous
// duplicates could both pass), which is acceptable for ordinary redelivery.
// Takes the already-open connection and table list so the duplicate check and
// the subsequent write share a single S3 connection and table-name listing.
async function alreadyProcessed(
  db: lancedb.Connection,
  tableNames: string[],
  key: string,
): Promise<boolean> {
  if (!tableNames.includes(cfg().table)) {
    return false;
  }
  const table = await db.openTable(cfg().table);
  // Escape single quotes for the SQL filter expression.
  const escapedKey = key.replace(/'/g, "''");
  const existing = await table
    .query()
    .where(`sourceS3ObjectKey = '${escapedKey}'`)
    .limit(1)
    .toArray();
  return existing.length > 0;
}

async function ingest(
  db: lancedb.Connection,
  tableNames: string[],
  chunks: string[],
  sourceS3ObjectKey: string,
): Promise<number> {
  console.log(`Ingesting ${chunks.length} from ${sourceS3ObjectKey} into a DB`);

  const embeddings = new BedrockEmbeddings({
    region: cfg().region,
    maxRetries: 3,
    clientOptions: {
      region: cfg().region,
      // Adaptive retries gracefully handles throttling from the server side
      retryMode: "adaptive",
      maxAttempts: 10,
    },
  });
  console.log(`Created BedrockEmbeddings ${embeddings}`);

  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i++) {
    vectors.push(await embeddings.embedQuery(chunks[i]));
    if ((i + 1) % 25 === 0 || i + 1 === chunks.length) {
      console.log(`Embedded ${i + 1}/${chunks.length} chunks`);
    }
  }

  const records = chunks.map((text, i) => ({
    vector: vectors[i],
    text,
    sourceS3ObjectKey,
  }));
  console.log(`Created ${records.length} records`);

  console.log(`Searching for ${cfg().table}`);
  if (tableNames.includes(cfg().table)) {
    console.log(`Found ${cfg().table} in list of table names`);

    const table = await db.openTable(cfg().table);
    console.log(`Opened table ${cfg().table}`);

    await table.add(records);
    console.log(`Added ${records.length} records to table ${cfg().table}`);
  } else {
    console.log(`Didn't find ${cfg().table}, creating the table`);
    await db.createTable(cfg().table, records);
    console.log(`Finished creating table ${cfg().table}`);
  }

  console.log(`DONE`);

  return records.length;
}

export interface S3EventBridgeEvent {
  source: string;
  "detail-type": string;
  detail: {
    bucket: { name: string };
    object: { key: string };
  };
}

export const handler = async (
  event: S3EventBridgeEvent,
): Promise<{ statusCode: number; body: string }> => {
  console.log("Event:", JSON.stringify(event));

  const bucket = event.detail.bucket.name;
  const key = decodeURIComponent(event.detail.object.key.replace(/\+/g, " "));

  // A non-PDF upload is not a document and carries no documentUuid, so we skip
  // it silently without emitting an event.
  if (!key.toLowerCase().endsWith(".pdf")) {
    console.log(`Skipping non-PDF key: ${key}`);
    return { statusCode: 200, body: "No documents ingested." };
  }

  // Identifiers start null so a PROCESSING_FAILED event for an unparseable key
  // carries explicit nulls (per the contract). The path-derived userId and
  // documentGroupId are populated best-effort *before* parseKey runs, so a key
  // that is well-formed except for a missing UUID still attributes the failure
  // to the right user/group. parseKey then validates all three and throws
  // (naming what is missing) for a truly malformed key.
  let userId: string | null = null;
  let documentGroupId: string | null = null;
  let documentUuid: string | null = null;
  let count: number;
  try {
    requireConfig();

    const [pathUserId, pathDocumentGroupId] = key.split("/");
    userId = pathUserId || null;
    documentGroupId = pathDocumentGroupId || null;

    // parseKey re-validates all three identifiers and throws (naming what is
    // missing) for a malformed key; its return narrows them to non-null for the
    // happy path below.
    const parsed = parseKey(key);
    documentUuid = parsed.documentUuid;

    // One connection per document, shared by the idempotency check and the
    // write, so we don't open the same S3 location (and list table names) twice.
    const db = await lancedb.connect(
      `s3://${cfg().bucket}/${parsed.userId}/${parsed.documentGroupId}/`,
    );
    const tableNames = await db.tableNames();

    // Idempotency: a redelivered event for an already-ingested key does no work
    // and publishes no event.
    if (await alreadyProcessed(db, tableNames, key)) {
      console.log(`Duplicate event for ${key}; already ingested, skipping.`);
      return { statusCode: 200, body: "Duplicate event; already processed." };
    }

    console.log(`Downloading s3://${bucket}/${key}`);
    const tmpPath = await downloadFromS3(bucket, key);

    const pdfData = await new PDFParse({
      data: readFileSync(tmpPath),
      CanvasFactory,
    }).getText();
    const chunks = splitText(pdfData.text);
    console.log(`Extracted ${chunks.length} chunks from ${key}`);

    count = await ingest(db, tableNames, chunks, key);
  } catch (err) {
    const statusDetail = err instanceof Error ? err.message : String(err);
    console.error(
      `Processing failed for s3://${bucket}/${key}: ${statusDetail}`,
    );

    // Report the failure as a single event and return normally — rethrowing
    // would trigger an EventBridge retry and a duplicate event.
    await publishDocumentProcessed({
      documentUuid,
      userId,
      documentGroupId,
      bucket,
      key,
      status: "PROCESSING_FAILED",
      statusDetail,
    });

    return {
      statusCode: 500,
      body: `Failed to ingest s3://${bucket}/${key}: ${statusDetail}`,
    };
  }

  // Processing succeeded. Publish the success event *outside* the try so a
  // transient PutEvents failure cannot be misreported as PROCESSING_FAILED. If
  // the publish throws here it propagates and EventBridge retries the whole
  // invocation (see the idempotency note in the README/handler docs).
  const msg = `Ingested ${count} chunks from s3://${bucket}/${key} into s3://${cfg().bucket}/ table=${cfg().table}`;
  console.log(msg);

  await publishDocumentProcessed({
    documentUuid,
    userId,
    documentGroupId,
    bucket,
    key,
    status: "PROCESSING_COMPLETED",
    statusDetail: null,
  });

  return { statusCode: 200, body: msg };
};

// Test-only surface. Not part of the Lambda's public contract.
export const __testables = { parseKey, splitText };
