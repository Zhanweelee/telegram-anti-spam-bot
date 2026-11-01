import { canonicalPluginPayload } from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  hmacSha256Hex,
  sha256HexUtf8,
  signaturesMatch,
} from "./plugin-digest.js";

describe("plugin digest", () => {
  it("hashes the canonical payload and compares signatures", async () => {
    const payload = canonicalPluginPayload({
      id: "keyword",
      version: "0.1.0",
      kind: "detector",
      schema: "keyword",
    });
    expect(await sha256HexUtf8(payload)).toBe(
      "4d04d928caf2d35056eb1beed553a4ca12490469fdd51ac40ff729106ce9c413",
    );
    const key = "example-key";
    const signature = await hmacSha256Hex(payload, key);
    expect(signature).toHaveLength(64);
    expect(signaturesMatch(signature, signature)).toBe(true);
    expect(signaturesMatch(signature, "ab".repeat(32))).toBe(false);
    expect(signaturesMatch(signature, `${signature}aa`)).toBe(false);
    expect(
      signaturesMatch(signature, await hmacSha256Hex(payload, "other")),
    ).toBe(false);
  });
});
