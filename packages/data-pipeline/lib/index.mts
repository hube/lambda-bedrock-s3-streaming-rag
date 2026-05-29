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

const BUCKET_NAME = process.env.s3BucketName!;
const REGION = process.env.region ?? "us-east-1";
const TABLE_NAME = process.env.lanceDbTable ?? "vectorstore";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

// Contract-fixed values for the outbound DocumentProcessed event
// (see docs/Eventbridge event schema.md).
const EVENT_BUS_NAME = process.env.eventBusName ?? "default";
const EVENT_SOURCE = "documentworker.rag";
const DETAIL_TYPE = "DocumentProcessed";

const s3 = new S3Client({ region: REGION });
const eventBridge = new EventBridgeClient({ region: REGION });

const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.pdf$/i;

interface ParsedKey {
  userId: string;
  documentGroupId: string;
  documentUuid: string;
}

// Derive the business identifiers from the S3 key, which follows the convention
// <userId>/<documentGroupId>/<filename>-<uuid>.pdf. Parsing can always fail, so
// this throws on a key that does not carry a trailing UUID; the caller surfaces
// that as a PROCESSING_FAILED event (with null identifiers) rather than letting
// a malformed key pass downstream.
function parseKey(key: string): ParsedKey {
  const [userId, documentGroupId] = key.split("/");
  const match = key.match(UUID_RE);
  if (!match) {
    throw new Error(`Could not parse a document UUID from S3 key: ${key}`);
  }
  return { userId, documentGroupId, documentUuid: match[1] };
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

// Emit exactly one DocumentProcessed event to EventBridge. The schema version
// we control lives inside `detail`; the envelope `version` is set by
// EventBridge itself (always "0" for custom PutEvents) and is not settable here.
async function publishDocumentProcessed({
  documentUuid,
  userId,
  documentGroupId,
  bucket,
  key,
  status,
  statusDetail,
}: DocumentProcessedDetail): Promise<void> {
  const result = await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: EVENT_BUS_NAME,
          Source: EVENT_SOURCE,
          DetailType: DETAIL_TYPE,
          Resources: [`arn:aws:s3:::${bucket}/${key}`],
          Detail: JSON.stringify({
            version: "1",
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
    throw new Error(
      `PutEvents failed for ${key}: ${JSON.stringify(result.Entries)}`,
    );
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
  const response = await s3.send(
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
async function alreadyProcessed(
  userId: string,
  documentGroupId: string,
  key: string,
): Promise<boolean> {
  const db = await lancedb.connect(
    `s3://${BUCKET_NAME}/${userId}/${documentGroupId}/`,
  );
  const tableNames = await db.tableNames();
  if (!tableNames.includes(TABLE_NAME)) {
    return false;
  }
  const table = await db.openTable(TABLE_NAME);
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
  chunks: string[],
  sourceS3ObjectKey: string,
): Promise<number> {
  console.log(`Ingesting ${chunks.length} from ${sourceS3ObjectKey} into a DB`);

  const embeddings = new BedrockEmbeddings({
    region: REGION,
    maxRetries: 3,
    clientOptions: {
      region: REGION,
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

  const [userId, documentGroupId] = sourceS3ObjectKey.split("/");
  console.log(`userId=${userId} and documentGroupId=${documentGroupId}`);

  const db = await lancedb.connect(
    `s3://${BUCKET_NAME}/${userId}/${documentGroupId}/`,
  );
  console.log(`Connected to DB in ${BUCKET_NAME}`);

  const tableNames = await db.tableNames();
  console.log(`Queried table names ${tableNames}`);

  console.log(`Searching for ${TABLE_NAME}`);
  if (tableNames.includes(TABLE_NAME)) {
    console.log(`Found ${TABLE_NAME} in list of table names`);

    const table = await db.openTable(TABLE_NAME);
    console.log(`Opened table ${TABLE_NAME}`);

    await table.add(records);
    console.log(`Added ${records.length} records to table ${TABLE_NAME}`);
  } else {
    console.log(`Didn't find ${TABLE_NAME}, creating the table`);
    await db.createTable(TABLE_NAME, records);
    console.log(`Finished creating table ${TABLE_NAME}`);
  }

  console.log(`DONE`);

  return records.length;
}

interface S3EventBridgeEvent {
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

  // Identifiers are parsed inside the try (parseKey throws on a malformed key).
  // They start null so a PROCESSING_FAILED event for an unparseable key carries
  // explicit nulls (per the contract) rather than omitting the fields.
  let userId: string | null = null;
  let documentGroupId: string | null = null;
  let documentUuid: string | null = null;
  let count: number;
  try {
    ({ userId, documentGroupId, documentUuid } = parseKey(key));

    // Idempotency: a redelivered event for an already-ingested key does no work
    // and publishes no event.
    if (await alreadyProcessed(userId, documentGroupId, key)) {
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

    count = await ingest(chunks, key);
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
  const msg = `Ingested ${count} chunks from s3://${bucket}/${key} into s3://${BUCKET_NAME}/ table=${TABLE_NAME}`;
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
