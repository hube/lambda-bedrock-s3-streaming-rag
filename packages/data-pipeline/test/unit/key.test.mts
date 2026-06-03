import { describe, it, expect } from "vitest";
import { __testables } from "../../lib/index.mts";

const { parseKey } = __testables;

const VALID_KEY =
  "user1/groupA/document-550e8400-e29b-41d4-a716-446655440000.pdf";

describe("parseKey", () => {
  it("A.1: parses a valid key to exact identifiers", () => {
    expect(parseKey(VALID_KEY)).toEqual({
      userId: "user1",
      documentGroupId: "groupA",
      documentUuid: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("A.2: missing userId — error names userId", () => {
    expect(() =>
      parseKey("/groupA/doc-550e8400-e29b-41d4-a716-446655440000.pdf"),
    ).toThrow(/userId/);
    expect(() =>
      parseKey("/groupA/doc-550e8400-e29b-41d4-a716-446655440000.pdf"),
    ).not.toThrow(/documentGroupId/);
  });

  it("A.3: missing documentGroupId — error names documentGroupId", () => {
    expect(() =>
      parseKey("user1//doc-550e8400-e29b-41d4-a716-446655440000.pdf"),
    ).toThrow(/documentGroupId/);
  });

  it("A.4: missing uuid — error names documentUuid", () => {
    expect(() => parseKey("user1/groupA/notapdf.pdf")).toThrow(/documentUuid/);
  });

  it("A.5: empty key — error lists all three missing identifiers", () => {
    const err = () => parseKey("");
    expect(err).toThrow(/userId/);
    expect(err).toThrow(/documentGroupId/);
    expect(err).toThrow(/documentUuid/);
  });

  it("A.6: uppercase-hex UUID parses correctly (case-insensitive)", () => {
    const result = parseKey(
      "user1/groupA/doc-550E8400-E29B-41D4-A716-446655440000.pdf",
    );
    expect(result.documentUuid).toBe("550E8400-E29B-41D4-A716-446655440000");
  });

  it("A.7: non-.pdf tail after UUID throws (regex anchored)", () => {
    expect(() =>
      parseKey("user1/groupA/doc-550e8400-e29b-41d4-a716-446655440000.pdf.bak"),
    ).toThrow(/documentUuid/);
  });
});
