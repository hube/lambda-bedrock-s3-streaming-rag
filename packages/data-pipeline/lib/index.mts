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
// <userId>/<documentGroupId>/<filename>-<uuid>.pdf. Fails fast on a key that
// does not carry a UUID so the caller can report a PROCESSING_FAILED event
// rather than emitting a null identifier.
function parseKey(key: string): ParsedKey {
  const [userId, documentGroupId] = key.split("/");
  const match = key.match(UUID_RE);
  if (!match) {
    throw new Error(`Could not parse a document UUID from S3 key: ${key}`);
  }
  return { userId, documentGroupId, documentUuid: match[1] };
}

interface DocumentProcessedDetail {
  documentUuid: string | null;
  userId?: string;
  documentGroupId?: string;
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

  // Parsed below inside the try so the catch can still report whatever is known.
  let userId: string | undefined;
  let documentGroupId: string | undefined;
  let documentUuid: string | null = null;

  try {
    ({ userId, documentGroupId, documentUuid } = parseKey(key));

    console.log(`Downloading s3://${bucket}/${key}`);
    const tmpPath = await downloadFromS3(bucket, key);

    const pdfData = await new PDFParse({
      data: readFileSync(tmpPath),
      CanvasFactory,
    }).getText();
    const chunks = splitText(pdfData.text);
    console.log(`Extracted ${chunks.length} chunks from ${key}`);

    const count = await ingest(chunks, key);
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
};
