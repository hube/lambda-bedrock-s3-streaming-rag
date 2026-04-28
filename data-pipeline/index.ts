import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { BedrockEmbeddings } from "@langchain/aws";
import * as lancedb from "@lancedb/lancedb";
import { createWriteStream, readFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (
  buffer: Buffer,
) => Promise<{ text: string }>;

const BUCKET_NAME = process.env.s3BucketName!;
const REGION = process.env.region ?? "us-east-1";
const TABLE_NAME = process.env.lanceDbTable ?? "vectorstore";
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

const s3 = new S3Client({ region: REGION });

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

async function ingest(chunks: string[], sourceS3ObjectKey: string): Promise<number> {
  console.log(`Ingesting ${chunks.length} from ${sourceS3ObjectKey} into a DB`);

  const embeddings = new BedrockEmbeddings({ region: REGION });
  console.log(`Created BedrockEmbeddings ${embeddings}`);

  const vectors = await embeddings.embedDocuments(chunks);
  console.log(`Created vectors ${vectors}`);

  const records = chunks.map((text, i) => ({ vector: vectors[i], text, sourceS3ObjectKey }));
  console.log(`Created ${records.length} records`);

  const db = await lancedb.connect(`s3://${BUCKET_NAME}/`);
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

  if (!key.toLowerCase().endsWith(".pdf")) {
    console.log(`Skipping non-PDF key: ${key}`);
    return { statusCode: 200, body: "No documents ingested." };
  }

  console.log(`Downloading s3://${bucket}/${key}`);
  const tmpPath = await downloadFromS3(bucket, key);

  const pdfData = await pdfParse(readFileSync(tmpPath));
  const chunks = splitText(pdfData.text);
  console.log(`Extracted ${chunks.length} chunks from ${key}`);

  const count = await ingest(chunks, key);
  const msg = `Ingested ${count} chunks from s3://${bucket}/${key} into s3://${BUCKET_NAME}/ table=${TABLE_NAME}`;
  console.log(msg);

  return { statusCode: 200, body: msg };
};
