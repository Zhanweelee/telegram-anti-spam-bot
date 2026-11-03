import { describe, expect, it } from "vitest";
import {
  auditExportDocument,
  minimumAuditExportLength,
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
    const scope = { tenantId: "t" };
    const shortest = {
      tenantId: "t",
      chatId: "c",
      eventId: "e",
      action: "log" as const,
      score: 0,
      reasons: [],
      evidence: [],
      ruleIds: [],
      createdAt: "2026-11-01T00:00:00Z",
    };
    expect(minimumAuditExportLength(scope, 0)).toBe(
      auditExportDocument(scope, []).length,
    );
    expect(minimumAuditExportLength(scope, 2)).toBe(
      auditExportDocument(scope, [shortest, shortest]).length,
    );
    expect(minimumAuditExportLength(scope, 4000)).toBeGreaterThan(3500);
    expect(minimumAuditExportLength(scope, Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => minimumAuditExportLength(scope, -1)).toThrow(
      "audit_count_invalid",
    );
    expect(minimumAuditExportLength({ tenantId: "t", chatId: "room" }, 1)).toBe(
      auditExportDocument({ tenantId: "t", chatId: "room" }, [
        { ...shortest, chatId: "room" },
      ]).length,
    );
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
