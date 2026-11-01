import { parseRuleSet } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createMemoryModerator, createMemoryStorage } from "./index.js";

const record = {
  tenantId: "tenant_a",
  chatId: "chat_1",
  eventId: "evt_1",
  textSha256: "d".repeat(64),
  action: "delete" as const,
  score: 1,
  reasons: ["keyword_match"],
  evidence: [{ kind: "keyword" as const, summary: "keyword:spam" }],
  ruleIds: ["spam_keywords"],
  createdAt: "2026-11-01T00:00:00Z",
};

describe("memory adapter", () => {
  it("isolates audits and rules by tenant and chat", async () => {
    const storage = createMemoryStorage();
    await storage.appendAudit(record);
    await storage.appendAudit({
      ...record,
      tenantId: "tenant_b",
      chatId: "chat_2",
      eventId: "evt_2",
    });
    expect(
      await storage.listAudits({ tenantId: "tenant_a", limit: 10 }),
    ).toHaveLength(1);
    expect(
      await storage.listAudits({
        tenantId: "tenant_a",
        chatId: "missing",
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(await storage.getRuleSet("tenant_a", "chat_1")).toBeNull();
    const rules = parseRuleSet({
      version: 1,
      aggregate: "max",
      rules: [
        {
          id: "spam_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete"],
        },
      ],
    });
    await storage.putRuleSet("tenant_a", "chat_1", rules);
    expect((await storage.getRuleSet("tenant_a", "chat_1"))?.rules[0]?.id).toBe(
      "spam_keywords",
    );
    expect(await storage.getRuleSet("tenant_b", "chat_1")).toBeNull();
  });

  it("records deletions", async () => {
    const moderator = createMemoryModerator();
    await moderator.deleteMessage({
      tenantId: "t",
      chatId: "c",
      messageId: "m",
    });
    expect(moderator.deleted).toEqual([
      { tenantId: "t", chatId: "c", messageId: "m" },
    ]);
  });
});
