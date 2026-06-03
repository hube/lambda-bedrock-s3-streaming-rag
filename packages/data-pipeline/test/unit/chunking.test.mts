import { describe, it, expect } from "vitest";
import { __testables } from "../../lib/index.mts";

const { splitText } = __testables;

describe("splitText", () => {
  it("B.1: empty string returns empty array", () => {
    expect(splitText("")).toEqual([]);
  });

  it("B.2: text shorter than 1000 chars returns single-element array", () => {
    const text = "a".repeat(500);
    expect(splitText(text)).toEqual([text]);
  });

  it("B.3: exactly 1000 chars returns single-element array", () => {
    const text = "a".repeat(1000);
    const chunks = splitText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it("B.4: 1001 chars produces 2 chunks with 200-char overlap", () => {
    const text = "a".repeat(800) + "b".repeat(200) + "c";
    const chunks = splitText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toBe(text.slice(800));
    expect(chunks[0].slice(800)).toBe(chunks[1].slice(0, 200));
  });

  it("B.5: 2600 chars produces correct chunks with interior overlap invariant", () => {
    const text = Array.from({ length: 2600 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)),
    ).join("");
    const chunks = splitText(text);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBe(1000);
    }
    for (let i = 0; i < chunks.length - 1; i++) {
      expect(chunks[i].slice(800)).toBe(chunks[i + 1].slice(0, 200));
    }
    // Reconstruction: every character of the text appears in at least one chunk.
    const covered = new Set<number>();
    let start = 0;
    for (const chunk of chunks) {
      for (let j = 0; j < chunk.length; j++) covered.add(start + j);
      start += 800;
    }
    for (let i = 0; i < text.length; i++) expect(covered.has(i)).toBe(true);
  });

  it("B.6: 100k chars terminates with correct count and last chunk ends at text boundary", () => {
    const text = "x".repeat(100_000);
    const chunks = splitText(text);
    const expected = Math.ceil((100_000 - 1000) / 800) + 1;
    expect(chunks).toHaveLength(expected);
    const lastChunk = chunks[chunks.length - 1];
    const allText = text;
    expect(allText.endsWith(lastChunk)).toBe(true);
    expect(lastChunk[lastChunk.length - 1]).toBe(allText[allText.length - 1]);
  });
});
