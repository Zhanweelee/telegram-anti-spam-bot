import { describe, expect, it } from "vitest";
import { RawContentError } from "./errors.js";
import { assertNoRawContent, redactExactText } from "./privacy.js";

describe("privacy", () => {
  it("rejects forbidden keys and exact raw text", () => {
    expect(() => assertNoRawContent({ nested: [{ text: "x" }] })).toThrow(
      RawContentError,
    );
    expect(() => assertNoRawContent(["hello"], "hello")).toThrow(
      RawContentError,
    );
    expect(() => assertNoRawContent("hello", "hello")).toThrow(RawContentError);
    expect(() =>
      assertNoRawContent({ summary: "keyword:hi" }, "hello"),
    ).not.toThrow();
    expect(() => assertNoRawContent(1)).not.toThrow();
    expect(() => assertNoRawContent(null)).not.toThrow();
    expect(redactExactText("hello", "hello")).toBe("redacted");
    expect(redactExactText("keyword:hi", "hello")).toBe("keyword:hi");
    expect(redactExactText("hello", undefined)).toBe("hello");
  });
});
