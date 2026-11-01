import {
  bindBlocklistStoreContract,
  bindCaptchaStoreContract,
  bindPolicyStoreContract,
  bindReviewQueueContract,
  bindStorageContract,
} from "@tasb/core/testing";
import { describe, expect, it } from "vitest";
import {
  createMemoryBlocklistStore,
  createMemoryCache,
  createMemoryCaptchaStore,
  createMemoryModerator,
  createMemoryPolicyStore,
  createMemoryReply,
  createMemoryReviewQueue,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "./index.js";

bindBlocklistStoreContract(createMemoryBlocklistStore);
bindReviewQueueContract(createMemoryReviewQueue);
bindPolicyStoreContract(createMemoryPolicyStore);
bindStorageContract(() => createMemoryStorage());
bindCaptchaStoreContract(createMemoryCaptchaStore);

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
    await moderator.restrictActor({
      tenantId: "t",
      chatId: "c",
      actorId: "u",
      durationSeconds: 300,
    });
    await moderator.releaseActor({ tenantId: "t", chatId: "c", actorId: "u" });
    expect(moderator.restricted).toEqual([
      { tenantId: "t", chatId: "c", actorId: "u", durationSeconds: 300 },
    ]);
    expect(moderator.released).toEqual([
      { tenantId: "t", chatId: "c", actorId: "u" },
    ]);
    expect(moderator.banned).toEqual([
      { tenantId: "t", chatId: "c", actorId: "u" },
    ]);
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
