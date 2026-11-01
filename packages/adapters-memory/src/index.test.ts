import { parseRuleSet } from "@tasb/core";
import { bindPolicyStoreContract } from "@tasb/core/testing";
import { describe, expect, it } from "vitest";
import {
  createMemoryCache,
  createMemoryModerator,
  createMemoryPolicyStore,
  createMemoryReply,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "./index.js";

bindPolicyStoreContract(createMemoryPolicyStore);

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

  it("expires cache entries from the injected clock", async () => {
    let now = 1_000;
    const cache = createMemoryCache(() => now);
    await cache.set("rules:local:chat", "ok", 10);
    expect(await cache.get("rules:local:chat")).toBe("ok");
    now = 11_000;
    expect(await cache.get("rules:local:chat")).toBeNull();
    expect(await cache.get("missing")).toBeNull();
  });

  it("records mute and ban without treating ban as a delete", async () => {
    const moderator = createMemoryModerator();
    await moderator.muteActor({
      tenantId: "t",
      chatId: "c",
      actorId: "u",
      durationSeconds: 60,
    });
    await moderator.banActor({ tenantId: "t", chatId: "c", actorId: "u" });
    expect(moderator.muted).toEqual([
      { tenantId: "t", chatId: "c", actorId: "u", durationSeconds: 60 },
    ]);
    expect(moderator.banned).toEqual([
      { tenantId: "t", chatId: "c", actorId: "u" },
    ]);
    expect(moderator.deleted).toEqual([]);
  });

  it("keeps dry-run and replies isolated by tenant and chat", async () => {
    const runtime = createMemoryRuntimeStore();
    await runtime.setDryRun("tenant_a", "chat_1", true);
    expect(await runtime.getDryRun("tenant_a", "chat_1")).toBe(true);
    expect(await runtime.getDryRun("tenant_a", "chat_2")).toBe(false);
    await runtime.setDryRun("tenant_a", "chat_1", false);
    expect(await runtime.getDryRun("tenant_a", "chat_1")).toBe(false);

    const reply = createMemoryReply();
    await reply.send({ tenantId: "tenant_a", chatId: "42", text: "命令：" });
    expect(reply.sent).toEqual([
      { tenantId: "tenant_a", chatId: "42", text: "命令：" },
    ]);
  });

  it("drops the oldest audits past the cap", async () => {
    const storage = createMemoryStorage({ maxAudits: 2 });
    for (const eventId of ["evt_1", "evt_2", "evt_3"]) {
      await storage.appendAudit({ ...record, eventId });
    }
    expect(storage.records.map((item) => item.eventId)).toEqual([
      "evt_2",
      "evt_3",
    ]);
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
