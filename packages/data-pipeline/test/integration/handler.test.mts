import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
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
import { handler } from "../../lib/index.mts";
import { makeEvent } from "../helpers.mts";
import { dockerAvailable } from "./setup.mts";

// Embeddings and pdf-parse are always mocked: Bedrock costs money and the
// native canvas dependency (napi-rs-canvas) is not available in CI.
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

describe.skipIf(!dockerAvailable)("handler integration (LocalStack)", () => {
  let container: StartedTestContainer;
  let s3: S3Client;
  let sqs: SQSClient;
  let sqsQueueUrl: string;

  async function putKey(key: string) {
    await s3.send(
      new PutObjectCommand({
        Bucket: UPLOAD_BUCKET,
        Key: key,
        Body: Buffer.from("dummy pdf bytes"),
      }),
    );
  }

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3")
      .withEnvironment({ SERVICES: "s3,sqs,events" })
      .withExposedPorts(4566)
      .withLogConsumer((stream) => {
        stream.on("data", (line: Buffer) =>
          process.stdout.write(`[LocalStack] ${line.toString()}`),
        );
        stream.on("err", (line: Buffer) =>
          process.stderr.write(`[LocalStack ERR] ${line.toString()}`),
        );
      })
      .withWaitStrategy(Wait.forLogMessage("Ready.", 1))
      .withStartupTimeout(120_000)
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;

    process.env.AWS_ENDPOINT_URL = endpoint;
    process.env.AWS_ALLOW_HTTP = "true";
    process.env.AWS_ACCESS_KEY_ID = "test";
    process.env.AWS_SECRET_ACCESS_KEY = "test";
    process.env.AWS_REGION = REGION;
    process.env.vectorDbS3BucketName = VECTOR_BUCKET;
    process.env.awsRegion = REGION;
    process.env.lanceDbTableName = "vectorstore";
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

  afterEach(async () => {
    // Explicit teardown: delete all S3 objects written by this test and purge
    // SQS so events don't bleed into subsequent tests.
    for (const bucket of [UPLOAD_BUCKET, VECTOR_BUCKET]) {
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      const objects = (listed.Contents ?? [])
        .filter((o) => o.Key != null)
        .map((o) => ({ Key: o.Key! }));
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects },
          }),
        );
      }
    }
    await sqs.send(new PurgeQueueCommand({ QueueUrl: sqsQueueUrl }));
  });

  it("D.1: first ingest creates LanceDB table and publishes PROCESSING_COMPLETED", async () => {
    const key =
      "user_d1/group_d1/document-550e8400-e29b-41d4-a716-446655440001.pdf";
    await putKey(key);

    const result = await handler(makeEvent(key, UPLOAD_BUCKET));
    expect(result.statusCode).toBe(200);

    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user_d1/group_d1/`);
    expect(await db.tableNames()).toContain("vectorstore");
    const rows = await (await db.openTable("vectorstore")).query().toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].sourceS3ObjectKey).toBe(key);
  });

  it("D.2: second key in same prefix appends to existing table (no re-create)", async () => {
    const keyA =
      "user_d2/group_d2/document-550e8400-e29b-41d4-a716-446655440002.pdf";
    const keyB =
      "user_d2/group_d2/document-550e8400-e29b-41d4-a716-446655440003.pdf";

    await putKey(keyA);
    await handler(makeEvent(keyA, UPLOAD_BUCKET));

    await putKey(keyB);
    const result = await handler(makeEvent(keyB, UPLOAD_BUCKET));
    expect(result.statusCode).toBe(200);

    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user_d2/group_d2/`);
    const keys = (
      await (await db.openTable("vectorstore")).query().toArray()
    ).map((r) => r.sourceS3ObjectKey as string);
    expect(keys).toContain(keyA);
    expect(keys).toContain(keyB);
  });

  it("D.3: duplicate event is idempotent — row count unchanged", async () => {
    const key =
      "user_d3/group_d3/document-550e8400-e29b-41d4-a716-446655440004.pdf";
    await putKey(key);
    await handler(makeEvent(key, UPLOAD_BUCKET));

    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user_d3/group_d3/`);
    const table = await db.openTable("vectorstore");
    const rowsBefore = (await table.query().toArray()).length;

    const result = await handler(makeEvent(key, UPLOAD_BUCKET));
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Duplicate");
    expect((await table.query().toArray()).length).toBe(rowsBefore);
  });

  it("D.4: non-PDF key returns 200 without writing to LanceDB", async () => {
    const result = await handler(
      makeEvent("user_d4/group_d4/image.png", UPLOAD_BUCKET),
    );
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("No documents ingested.");

    const db = await lancedb.connect(`s3://${VECTOR_BUCKET}/user_d4/group_d4/`);
    expect(await db.tableNames()).not.toContain("vectorstore");
  });

  it("D.5: published event matches DocumentProcessed schema contract", async () => {
    const key =
      "user_d5/group_d5/document-550e8400-e29b-41d4-a716-446655440005.pdf";
    await putKey(key);
    await handler(makeEvent(key, UPLOAD_BUCKET));

    // EventBridge→SQS routing is async. Filter by key so this test is
    // independent of events published by other tests in the shared queue.
    let event: Record<string, unknown> | undefined;
    const deadline = Date.now() + 15_000;
    while (!event && Date.now() < deadline) {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: sqsQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 2,
        }),
      );
      for (const msg of res.Messages ?? []) {
        const detail = (JSON.parse(msg.Body!) as { detail: unknown })
          .detail as Record<string, unknown>;
        if (detail.status === "PROCESSING_COMPLETED" && detail.s3Key === key) {
          event = detail;
          break;
        }
      }
    }

    expect(event).toBeDefined();
    expect(event!.version).toBe("1");
    expect(event!.s3Key).toBe(key);
    expect(typeof event!.processedAt).toBe("string");
    expect(new Date(event!.processedAt as string).toISOString()).toBe(
      event!.processedAt,
    );
  });
});
