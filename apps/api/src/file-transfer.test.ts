import { describe, expect, it } from "vitest";
import { parseRangeHeader, sanitizeFilename } from "./file-transfer.js";

describe("parseRangeHeader", () => {
  it("serves the full body without a Range header", () => {
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader(undefined, 100)).toBeNull();
    expect(parseRangeHeader("", 100)).toBeNull();
  });

  it("parses bounded ranges", () => {
    expect(parseRangeHeader("bytes=0-49", 100)).toEqual({ start: 0, end: 49 });
    expect(parseRangeHeader("bytes=40-199", 100)).toEqual({ start: 40, end: 99 });
  });

  it("parses open-ended and suffix ranges", () => {
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRangeHeader("bytes=-20", 100)).toEqual({ start: 80, end: 99 });
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("rejects unsatisfiable ranges", () => {
    expect(parseRangeHeader("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=5-3", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=0-0", 0)).toBe("unsatisfiable");
    expect(parseRangeHeader("bytes=100-200", 0)).toBe("unsatisfiable");
  });

  it("ignores malformed and multi-range headers (full body)", () => {
    expect(parseRangeHeader("items=0-5", 100)).toBeNull();
    expect(parseRangeHeader("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRangeHeader("bytes=abc-def", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-", 100)).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("strips header-breaking characters and bounds length", () => {
    expect(sanitizeFilename('a"b\\c\r\nd')).toBe("a_b_c__d");
    expect(sanitizeFilename("x".repeat(500))).toHaveLength(200);
    expect(sanitizeFilename("")).toBe("download");
    expect(sanitizeFilename('"\r\n')).toBe("___");
  });
});
