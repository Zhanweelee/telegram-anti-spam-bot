import { describe, expect, it } from "vitest";
import {
  auditExportDocument,
  parseAuditQuery,
  parseAuditRecord,
  parseAuditScope,
} from "./ports.js";

describe("audit schema", () => {
  it("rejects raw message fields and oversized queries", () => {
    expect(() =>
      parseAuditRecord({
        tenantId: "t",
        chatId: "c",
        eventId: "e",
        text: "hello",
        action: "delete",
        score: 1,
        reasons: [],
        evidence: [],
        ruleIds: [],
        createdAt: "2026-11-01T00:00:00Z",
      }),
    ).toThrow();
    expect(
      parseAuditRecord({
        tenantId: "t",
        chatId: "c",
        eventId: "e",
        textSha256: "ab".repeat(32),
        action: "log",
        score: 0.2,
        reasons: ["keyword_match"],
        evidence: [{ kind: "hash", summary: "sha256" }],
        ruleIds: ["spam_keywords"],
        createdAt: "2026-11-01T00:00:00.123Z",
      }).textSha256,
    ).toHaveLength(64);
    expect(() => parseAuditQuery({ tenantId: "t", limit: 101 })).toThrow();
    expect(
      parseAuditQuery({ tenantId: "t", chatId: "c", limit: 10 }).limit,
    ).toBe(10);
    expect(() => parseAuditScope({ tenantId: "" })).toThrow();
    expect(parseAuditScope({ tenantId: "t", chatId: "c" }).chatId).toBe("c");
    const json = auditExportDocument({ tenantId: "t" }, []);
    expect(JSON.parse(json)).toEqual({ tenantId: "t", audits: [] });
    expect(() =>
      auditExportDocument({ tenantId: "t" }, [
        {
          tenantId: "t",
          chatId: "c",
          eventId: "e",
          text: "hello",
          action: "delete",
          score: 1,
          reasons: [],
          evidence: [],
          ruleIds: [],
          createdAt: "2026-11-01T00:00:00Z",
        } as never,
      ]),
    ).toThrow();
  });
});
