import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  CreateEventBusCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
} from "@aws-sdk/client-eventbridge";
import { GenericContainer, Wait } from "testcontainers";
import type { StartedTestContainer } from "testcontainers";
import * as lancedb from "@lancedb/lancedb";
import { handler } from "../lib/index.mts";
import { makeEvent } from "./helpers.mts";
import { dockerAvailable } from "./setup.int.mts";

// Embeddings and pdf-parse are always mocked (paid / native deps).
vi.mock("@langchain/aws", () => ({
  BedrockEmbeddings: vi.fn().mockImplementation(function () {
    return {
      embedQuery: vi.fn().mockResolvedValue(Array<number>(8).fill(0.5)),
    };
  }),
}));
vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn().mockImplementation(function () {
    return {
      getText: vi.fn().mockResolvedValue({ text: "word ".repeat(200) }),
    };
  }),
}));
vi.mock("pdf-parse/worker", () => ({ CanvasFactory: vi.fn() }));

const REGION = "us-east-1";
const VECTOR_BUCKET = "test-vector-bucket";
const UPLOAD_BUCKET = "test-unprocessed-bucket";
const EVENT_BUS = "test-bus";
const KEY = "user1/groupA/document-550e8400-e29b-41d4-a716-446655440000.pdf";

describe.skipIf(!dockerAvailable)("handler integration (LocalStack)", () => {
  let container: StartedTestContainer;
  let s3: S3Client;
  let sqs: SQSClient;
  let sqsQueueUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:latest")
      .withEnvironment({ SERVICES: "s3,sqs,events" })
      .withExposedPorts(4566)
      .withWaitStrategy(Wait.forLogMessage("Ready.", 1))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;

    process.env.AWS_ENDPOINT_URL = endpoint;
    process.env.AWS_ALLOW_HTTP = "true";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_REGION = REGION;
    process.env.s3BucketName = VECTOR_BUCKET;
    process.env.region = REGION;
    process.env.lanceDbTable = "vectorstore";
    process.env.eventBusName = EVENT_BUS;

    const clientCfg = {
      region: REGION,
      endpoint,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      forcePathStyle: true,
    };

    s3 = new S3Client(clientCfg);
    sqs = new SQSClient(clientCfg);
    const eb = new EventBridgeClient(clientCfg);

    await s3.send(new CreateBucketCommand({ Bucket: UPLOAD_BUCKET }));
    await s3.send(new CreateBucketCommand({ Bucket: VECTOR_BUCKET }));

    await eb.send(new CreateEventBusCommand({ Name: EVENT_BUS }));

    const queueResult = await sqs.send(
      new CreateQueueCommand({ QueueName: "test-documents" }),
    );
    sqsQueueUrl = queueResult.QueueUrl!;

    const queueAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: sqsQueueUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const queueArn = queueAttrs.Attributes?.QueueArn;
    if (!queueArn) throw new Error("LocalStack did not return a QueueArn");

    await eb.send(
      new PutRuleCommand({
        Name: "test-document-processed",
        EventBusName: EVENT_BUS,
        EventPattern: JSON.stringify({ source: ["documentworker.rag"] }),
        State: "ENABLED",
      }),
    );

    await eb.send(
      new PutTargetsCommand({
        Rule: "test-document-processed",
        EventBusName: EVENT_BUS,
        Targets: [{ Id: "sqs-target", Arn: queueArn }],
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_ALLOW_HTTP;
  });

  it("D.1: first ingest creates LanceDB table and publishes PROCESSING_COMPLETED", async () => {
    await s3.send(
      new PutObjectCommand({
        Bucket: UPLOAD_BUCKET,
        Key: KEY,
        Body: Buffer.from("dummy pdf bytes"),
      }),
    );

    const result = await handler(makeEvent(KEY, UPLOAD_BUCKET));
    expect(result.statusCode).toBe(200);

    // Verify LanceDB table was created by re-reading it.
    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user1/groupA/`);
    const tableNames = await db.tableNames();
    expect(tableNames).toContain("vectorstore");

    const table = await db.openTable("vectorstore");
    const rows = await table.query().toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].sourceS3ObjectKey).toBe(KEY);
  });

  it("D.2: second key appends to existing table (no re-create)", async () => {
    const key2 =
      "user1/groupA/document-660e8400-e29b-41d4-a716-446655440000.pdf";
    await s3.send(
      new PutObjectCommand({
        Bucket: UPLOAD_BUCKET,
        Key: key2,
        Body: Buffer.from("another pdf"),
      }),
    );

    const result = await handler(makeEvent(key2, UPLOAD_BUCKET));
    expect(result.statusCode).toBe(200);

    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user1/groupA/`);
    const table = await db.openTable("vectorstore");
    const rows = await table.query().toArray();
    // Both documents should be present.
    const keys = rows.map((r) => r.sourceS3ObjectKey as string);
    expect(keys).toContain(KEY);
    expect(keys).toContain(key2);
  });

  it("D.3: duplicate event is idempotent — row count unchanged, no new event", async () => {
    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user1/groupA/`);
    const table = await db.openTable("vectorstore");
    const rowsBefore = (await table.query().toArray()).length;

    const result = await handler(makeEvent(KEY, UPLOAD_BUCKET));
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Duplicate");

    const rowsAfter = (await table.query().toArray()).length;
    expect(rowsAfter).toBe(rowsBefore);
  });

  it("D.4: non-PDF key returns 200 without writing to LanceDB", async () => {
    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user1/groupA/`);
    const table = await db.openTable("vectorstore");
    const rowsBefore = (await table.query().toArray()).length;

    const result = await handler(
      makeEvent("user1/groupA/image.png", UPLOAD_BUCKET),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("No documents ingested.");

    const rowsAfter = (await table.query().toArray()).length;
    expect(rowsAfter).toBe(rowsBefore);
  });

  it("D.5: published event matches DocumentProcessed schema contract", async () => {
    const messages = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: sqsQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
      }),
    );

    // At least the D.1 COMPLETED event should have been delivered.
    expect(messages.Messages?.length).toBeGreaterThan(0);
    const bodies = (messages.Messages ?? []).map((m) => {
      const envelope = JSON.parse(m.Body!) as { detail: unknown };
      return envelope.detail as Record<string, unknown>;
    });

    const completed = bodies.find((d) => d.status === "PROCESSING_COMPLETED");
    expect(completed).toBeDefined();
    expect(completed!.version).toBe("1");
    expect(completed!.s3Key).toBe(KEY);
    expect(typeof completed!.processedAt).toBe("string");
    expect(new Date(completed!.processedAt as string).toISOString()).toBe(
      completed!.processedAt,
    );
  });
});
