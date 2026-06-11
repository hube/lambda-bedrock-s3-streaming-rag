import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { Readable } from "stream";
import * as lancedb from "@lancedb/lancedb";
import { PDFParse } from "pdf-parse";
import { BedrockEmbeddings } from "@langchain/aws";
import { handler } from "../../lib/index.mts";
import {
  makeEvent,
  getPublishedDetail,
  getPublishedEntry,
} from "../helpers.mts";

vi.mock("@lancedb/lancedb", () => ({ connect: vi.fn() }));
vi.mock("pdf-parse", () => ({ PDFParse: vi.fn() }));
vi.mock("pdf-parse/worker", () => ({ CanvasFactory: vi.fn() }));
vi.mock("@langchain/aws", () => ({ BedrockEmbeddings: vi.fn() }));

const s3Mock = mockClient(S3Client);
const ebMock = mockClient(EventBridgeClient);

const VALID_KEY =
  "user1/groupA/document-550e8400-e29b-41d4-a716-446655440000.pdf";
const FIXED_TIME = "2026-05-31T00:00:00.000Z";
const VECTOR = Array<number>(8).fill(0.1);

let mockQueryChain: {
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  toArray: ReturnType<typeof vi.fn>;
};
let mockTable: {
  add: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};
let mockDb: {
  tableNames: ReturnType<typeof vi.fn>;
  openTable: ReturnType<typeof vi.fn>;
  createTable: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  // Only fake Date — faking the full scheduler (setImmediate etc.) interferes
  // with Node stream completion in the happy-path tests that pipe real Readables.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_TIME);

  s3Mock
    .on(GetObjectCommand)
    .resolves({ Body: Readable.from(Buffer.from("pdf bytes")) as never });
  ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [] });

  mockQueryChain = {
    where: vi.fn(),
    limit: vi.fn(),
    toArray: vi.fn().mockResolvedValue([]),
  };
  mockQueryChain.where.mockReturnValue(mockQueryChain);
  mockQueryChain.limit.mockReturnValue(mockQueryChain);

  mockTable = {
    add: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockReturnValue(mockQueryChain),
  };

  mockDb = {
    tableNames: vi.fn().mockResolvedValue([]),
    openTable: vi.fn().mockResolvedValue(mockTable),
    createTable: vi.fn().mockResolvedValue(undefined),
  };

  vi.mocked(lancedb.connect).mockResolvedValue(mockDb as never);

  vi.mocked(PDFParse).mockImplementation(function () {
    return {
      getText: vi.fn().mockResolvedValue({ text: "word ".repeat(200) }),
    };
  } as never);

  vi.mocked(BedrockEmbeddings).mockImplementation(function () {
    return { embedQuery: vi.fn().mockResolvedValue(VECTOR) };
  } as never);
});

afterEach(() => {
  s3Mock.reset();
  ebMock.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("handler — non-PDF skip", () => {
  it("C.1: non-PDF returns 200 without calling AWS or LanceDB", async () => {
    const result = await handler(makeEvent("user1/groupA/image.png"));
    expect(result).toEqual({ statusCode: 200, body: "No documents ingested." });
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    expect(lancedb.connect).not.toHaveBeenCalled();
  });

  it("C.2: uppercase .PDF extension is processed, not skipped", async () => {
    const key =
      "user1/groupA/document-550e8400-e29b-41d4-a716-446655440000.PDF";
    const result = await handler(makeEvent(key));
    expect(result.statusCode).toBe(200);
    // Positive assertion: ingestion actually ran (not just "returned something").
    expect(mockDb.createTable).toHaveBeenCalled();
    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_COMPLETED");
  });
});

describe("handler — key parsing failures", () => {
  it("C.3: bare filename (no slashes) → 500, PROCESSING_FAILED with best-effort ids", async () => {
    const result = await handler(makeEvent("justafile.pdf"));
    expect(result.statusCode).toBe(500);

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_FAILED");
    // userId is "justafile.pdf" (best-effort from path split before parseKey throws)
    expect(detail.userId).toBe("justafile.pdf");
    expect(detail.documentGroupId).toBeNull();
    expect(detail.documentUuid).toBeNull();
    expect(detail.s3Key).toBe("justafile.pdf");
    expect(String(detail.statusDetail)).toContain("Could not parse");
    expect(detail.processedAt).toBe(FIXED_TIME);
    expect(detail.version).toBe("1");
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
  });

  it("C.4: key with user+group but missing UUID → FAILED with userId and documentGroupId set", async () => {
    const result = await handler(makeEvent("user1/groupA/badname.pdf"));
    expect(result.statusCode).toBe(500);

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_FAILED");
    expect(detail.userId).toBe("user1");
    expect(detail.documentGroupId).toBe("groupA");
    expect(detail.documentUuid).toBeNull();
  });
});

describe("handler — happy path", () => {
  it("C.5: table absent → createTable called, add not called, PROCESSING_COMPLETED published", async () => {
    mockDb.tableNames.mockResolvedValue([]);

    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(200);

    expect(mockDb.createTable).toHaveBeenCalledWith(
      "vectorstore",
      expect.arrayContaining([
        expect.objectContaining({ text: expect.any(String), vector: VECTOR }),
      ]),
    );
    expect(mockTable.add).not.toHaveBeenCalled();

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_COMPLETED");
    expect(detail.statusDetail).toBeNull();
    expect(detail.processedAt).toBe(FIXED_TIME);
  });

  it("C.6: table present → add called, createTable not called, PROCESSING_COMPLETED published", async () => {
    mockDb.tableNames.mockResolvedValue(["vectorstore"]);

    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(200);

    expect(mockTable.add).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.any(String),
          vector: VECTOR,
          sourceS3ObjectKey: VALID_KEY,
        }),
      ]),
    );
    expect(mockDb.createTable).not.toHaveBeenCalled();

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_COMPLETED");
  });
});

describe("handler — idempotency", () => {
  it("C.7: duplicate → 200 'Duplicate...', no PutEvents/add/createTable/GetObject", async () => {
    mockDb.tableNames.mockResolvedValue(["vectorstore"]);
    mockQueryChain.toArray.mockResolvedValue([
      { sourceS3ObjectKey: VALID_KEY },
    ]);

    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain("Duplicate");
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(mockTable.add).not.toHaveBeenCalled();
    expect(mockDb.createTable).not.toHaveBeenCalled();
  });
});

describe("handler — error paths", () => {
  it("C.8: embedding rejects → 500 + PROCESSING_FAILED, no COMPLETED or write", async () => {
    vi.mocked(BedrockEmbeddings).mockImplementation(function () {
      return {
        embedQuery: vi.fn().mockRejectedValue(new Error("Bedrock throttled")),
      };
    } as never);

    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(500);

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_FAILED");
    expect(String(detail.statusDetail)).toContain("Bedrock throttled");
    expect(mockTable.add).not.toHaveBeenCalled();
    expect(mockDb.createTable).not.toHaveBeenCalled();
  });

  it("C.9: table.add rejects → 500 + PROCESSING_FAILED", async () => {
    mockDb.tableNames.mockResolvedValue(["vectorstore"]);
    mockTable.add.mockRejectedValue(new Error("LanceDB write error"));

    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(500);

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_FAILED");
    expect(String(detail.statusDetail)).toContain("LanceDB write error");
  });

  it("C.10: lancedb.connect rejects → 500 + PROCESSING_FAILED", async () => {
    vi.mocked(lancedb.connect).mockRejectedValue(
      new Error("S3 connection refused"),
    );

    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(500);

    const detail = getPublishedDetail(ebMock);
    expect(detail.status).toBe("PROCESSING_FAILED");
    expect(String(detail.statusDetail)).toContain("S3 connection refused");
  });
});

describe("handler — PutEvents failure propagation", () => {
  it("C.11: PutEvents FailedEntryCount>0 on success path → handler rejects (no catch wraps it)", async () => {
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "InternalFailure", ErrorMessage: "EB error" }],
    });

    await expect(handler(makeEvent(VALID_KEY))).rejects.toThrow(
      /PutEvents failed/,
    );
  });

  it("C.12: PutEvents FailedEntryCount>0 on failure path → throw propagates out of catch", async () => {
    vi.mocked(lancedb.connect).mockRejectedValue(new Error("connect error"));
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: "Throttling", ErrorMessage: "rate exceeded" }],
    });

    await expect(handler(makeEvent(VALID_KEY))).rejects.toThrow(
      /PutEvents failed/,
    );
  });
});

describe("handler — URL decoding", () => {
  it("C.13: %20-encoded key is decoded before S3 GetObject, LanceDB, and EventBridge event", async () => {
    const encodedKey =
      "user1/group%20A/document-550e8400-e29b-41d4-a716-446655440000.pdf";
    const decodedKey =
      "user1/group A/document-550e8400-e29b-41d4-a716-446655440000.pdf";

    await handler(makeEvent(encodedKey));

    const s3Call = s3Mock.commandCalls(GetObjectCommand)[0];
    expect(s3Call?.args[0].input.Key).toBe(decodedKey);

    const detail = getPublishedDetail(ebMock);
    expect(detail.s3Key).toBe(decodedKey);
  });

  it("C.13b: + in key is treated as space, decoded key used throughout", async () => {
    const plusKey =
      "user1/group+A/document-550e8400-e29b-41d4-a716-446655440000.pdf";
    const decodedKey =
      "user1/group A/document-550e8400-e29b-41d4-a716-446655440000.pdf";

    await handler(makeEvent(plusKey));

    const s3Call = s3Mock.commandCalls(GetObjectCommand)[0];
    expect(s3Call?.args[0].input.Key).toBe(decodedKey);
  });
});

describe("handler — SQL injection guard", () => {
  it("C.14: single quotes in key are doubled in the where() filter argument", async () => {
    const apostropheKey =
      "user1/group'A/document-550e8400-e29b-41d4-a716-446655440000.pdf";
    mockDb.tableNames.mockResolvedValue(["vectorstore"]);

    await handler(makeEvent(apostropheKey));

    // The where() argument must escape ' as '' to prevent SQL injection.
    // This is the one white-box assertion: we capture the literal SQL string
    // because the escaping logic is non-obvious and security-relevant.
    const whereArg = mockQueryChain.where.mock.calls[0]?.[0] as string;
    expect(whereArg).toContain("group''A");
    expect(whereArg).not.toContain("group'A");
  });
});

describe("handler — EventBridge event shape", () => {
  it("C.15: Resources ARN is arn:aws:s3:::<bucket>/<decodedKey>", async () => {
    const result = await handler(
      makeEvent(VALID_KEY, "test-unprocessed-bucket"),
    );
    expect(result.statusCode).toBe(200);

    const entry = getPublishedEntry(ebMock);
    expect(entry.Resources).toEqual([
      `arn:aws:s3:::test-unprocessed-bucket/${VALID_KEY}`,
    ]);
  });

  it("C.15b: published Source equals the eventSource env var", async () => {
    const result = await handler(makeEvent(VALID_KEY));
    expect(result.statusCode).toBe(200);

    const entry = getPublishedEntry(ebMock);
    expect(entry.Source).toBe("DocumentVectorizationPipeline.test");
  });
});

describe("handler — missing env var", () => {
  it("C.16: missing vectorDbS3BucketName fails fast via the handler's own config check", async () => {
    const original = process.env.vectorDbS3BucketName;
    delete process.env.vectorDbS3BucketName;

    try {
      const result = await handler(makeEvent(VALID_KEY));
      expect(result.statusCode).toBe(500);

      // The handler validates config itself and reports the missing var by
      // name — it does not rely on a downstream service to reveal the gap.
      const detail = getPublishedDetail(ebMock);
      expect(detail.status).toBe("PROCESSING_FAILED");
      expect(String(detail.statusDetail)).toContain(
        "Missing required env var(s): vectorDbS3BucketName",
      );

      // Fail-fast: no S3/LanceDB work is attempted with invalid config.
      expect(lancedb.connect).not.toHaveBeenCalled();
    } finally {
      process.env.vectorDbS3BucketName = original;
    }
  });
});
