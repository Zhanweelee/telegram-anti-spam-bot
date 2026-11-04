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
    expect(await runtime.listRuleSwitches("tenant_a", "chat_1")).toEqual([]);
    expect(
      await runtime.setRuleSwitch("tenant_a", "chat_1", "via_inline", true),
    ).toBe(true);
    expect(await runtime.listRuleSwitches("tenant_a", "chat_1")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    expect(await runtime.listRuleSwitches("tenant_a", "chat_2")).toEqual([]);
    expect(
      await runtime.setRuleSwitch("tenant_a", "chat_1", "via_inline", false),
    ).toBe(true);
    await runtime.clearRuleSwitch("tenant_a", "chat_1", "via_inline");
    expect(await runtime.listRuleSwitches("tenant_a", "chat_1")).toEqual([]);

    const reply = createMemoryReply();
    await reply.send({ tenantId: "tenant_a", chatId: "42", text: "命令：" });
    expect(reply.sent).toEqual([
      { tenantId: "tenant_a", chatId: "42", text: "命令：" },
    ]);
  });

  it("keeps at most 32 switches and 256 chats", async () => {
    const runtime = createMemoryRuntimeStore();
    for (let index = 0; index < 32; index += 1) {
      expect(
        await runtime.setRuleSwitch("tenant_a", "full", `rule_${index}`, true),
      ).toBe(true);
    }
    expect(
      await runtime.setRuleSwitch("tenant_a", "full", "rule_extra", true),
    ).toBe(false);
    expect(
      await runtime.setRuleSwitch("tenant_a", "full", "rule_0", false),
    ).toBe(true);
    expect(await runtime.listRuleSwitches("tenant_a", "full")).toHaveLength(32);
    for (let index = 0; index < 255; index += 1) {
      expect(
        await runtime.setRuleSwitch("tenant_a", `chat_${index}`, "links", true),
      ).toBe(true);
    }
    expect(
      await runtime.setRuleSwitch("tenant_a", "overflow", "links", true),
    ).toBe(false);
    expect(await runtime.listRuleSwitches("tenant_a", "overflow")).toEqual([]);
    for (let index = 0; index < 32; index += 1) {
      await runtime.clearRuleSwitch("tenant_a", "full", `rule_${index}`);
    }
    expect(
      await runtime.setRuleSwitch("tenant_a", "overflow", "links", false),
    ).toBe(true);
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

  it("records a revoked invite without the link", async () => {
    const moderator = createMemoryModerator();
    const code = "AbCdEfGhIjKlMnOp";
    await moderator.revokeInvite({
      tenantId: "t",
      chatId: "c",
      inviteLink: `https://t.me/+${code}`,
    });
    expect(moderator.invitesRevoked).toEqual([{ tenantId: "t", chatId: "c" }]);
    expect(JSON.stringify(moderator.invitesRevoked)).not.toContain(code);
  });

  it("records an unpin without a message id", async () => {
    const moderator = createMemoryModerator();
    await moderator.unpinChat({ tenantId: "t", chatId: "c" });
    expect(moderator.unpinned).toEqual([{ tenantId: "t", chatId: "c" }]);
    expect(JSON.stringify(moderator.unpinned)).not.toContain("message");
  });

  it("records a topic unpin with the thread id only when one was given", async () => {
    const moderator = createMemoryModerator();
    await moderator.unpinTopic({ tenantId: "t", chatId: "c" });
    await moderator.unpinTopic({ tenantId: "t", chatId: "c", threadId: "55" });
    expect(moderator.topicsUnpinned).toEqual([
      { tenantId: "t", chatId: "c" },
      { tenantId: "t", chatId: "c", threadId: "55" },
    ]);
  });

  it("records a closed topic with the thread id only when one was given", async () => {
    const moderator = createMemoryModerator();
    await moderator.closeTopic({ tenantId: "t", chatId: "c" });
    await moderator.closeTopic({ tenantId: "t", chatId: "c", threadId: "1" });
    expect(moderator.topicsClosed).toEqual([
      { tenantId: "t", chatId: "c" },
      { tenantId: "t", chatId: "c", threadId: "1" },
    ]);
  });

  it("records a reopened topic with the thread id only when one was given", async () => {
    const moderator = createMemoryModerator();
    await moderator.openTopic({ tenantId: "t", chatId: "c" });
    await moderator.openTopic({ tenantId: "t", chatId: "c", threadId: "1" });
    expect(moderator.topicsOpened).toEqual([
      { tenantId: "t", chatId: "c" },
      { tenantId: "t", chatId: "c", threadId: "1" },
    ]);
  });

  it("records a hidden General topic without a thread id", async () => {
    const moderator = createMemoryModerator();
    await moderator.hideGeneral({ tenantId: "t", chatId: "c" });
    expect(moderator.generalsHidden).toEqual([{ tenantId: "t", chatId: "c" }]);
    expect(JSON.stringify(moderator.generalsHidden)).not.toContain("thread");
  });

  it("records a shown General topic without a thread id", async () => {
    const moderator = createMemoryModerator();
    await moderator.showGeneral({ tenantId: "t", chatId: "c" });
    expect(moderator.generalsShown).toEqual([{ tenantId: "t", chatId: "c" }]);
    expect(JSON.stringify(moderator.generalsShown)).not.toContain("thread");
  });

  it("records a deleted topic with its thread id", async () => {
    const moderator = createMemoryModerator();
    await moderator.deleteTopic({ tenantId: "t", chatId: "c", threadId: "55" });
    expect(moderator.topicsDeleted).toEqual([
      { tenantId: "t", chatId: "c", threadId: "55" },
    ]);
  });

  it("records a deleted group sticker set without the name", async () => {
    const moderator = createMemoryModerator();
    await moderator.deleteStickerSet({ tenantId: "t", chatId: "c" });
    expect(moderator.stickerSetsDeleted).toEqual([
      { tenantId: "t", chatId: "c" },
    ]);
    expect(JSON.stringify(moderator.stickerSetsDeleted)).not.toContain(
      "sticker",
    );
    expect(JSON.stringify(moderator.stickerSetsDeleted)).not.toContain("name");
  });

  it("records a member tag including an empty one", async () => {
    const moderator = createMemoryModerator();
    await moderator.setMemberTag({
      tenantId: "t",
      chatId: "c",
      actorId: "77",
      tag: "ops",
    });
    await moderator.setMemberTag({
      tenantId: "t",
      chatId: "c",
      actorId: "77",
      tag: "",
    });
    expect(moderator.memberTagsSet).toEqual([
      { tenantId: "t", chatId: "c", actorId: "77", tag: "ops" },
      { tenantId: "t", chatId: "c", actorId: "77", tag: "" },
    ]);
    expect(JSON.stringify(moderator.memberTagsSet)).not.toContain("first_name");
  });

  it("records a left chat without the title", async () => {
    const moderator = createMemoryModerator();
    await moderator.leaveChat({ tenantId: "t", chatId: "c" });
    expect(moderator.chatsLeft).toEqual([{ tenantId: "t", chatId: "c" }]);
    expect(JSON.stringify(moderator.chatsLeft)).not.toContain("title");
    expect(JSON.stringify(moderator.chatsLeft)).not.toContain("message");
  });

  it("records a deleted chat photo without the file", async () => {
    const moderator = createMemoryModerator();
    await moderator.deletePhoto({ tenantId: "t", chatId: "c" });
    expect(moderator.photosDeleted).toEqual([{ tenantId: "t", chatId: "c" }]);
    expect(JSON.stringify(moderator.photosDeleted)).not.toContain("photo");
    expect(JSON.stringify(moderator.photosDeleted)).not.toContain("file");
  });

  it("records one removed message reaction", async () => {
    const moderator = createMemoryModerator();
    await moderator.removeReaction({
      tenantId: "t",
      chatId: "c",
      messageId: "55",
      actorId: "77",
      kind: "user",
    });
    expect(moderator.messageReactionsRemoved).toEqual([
      {
        tenantId: "t",
        chatId: "c",
        messageId: "55",
        actorId: "77",
        kind: "user",
      },
    ]);
    expect(moderator.reactionsCleared).toEqual([]);
  });

  it("records one unpinned message id", async () => {
    const moderator = createMemoryModerator();
    await moderator.unpinMessage({
      tenantId: "t",
      chatId: "c",
      messageId: "55",
    });
    expect(moderator.messagesUnpinned).toEqual([
      { tenantId: "t", chatId: "c", messageId: "55" },
    ]);
    expect(moderator.messagesPinned).toEqual([]);
    expect(moderator.unpinned).toEqual([]);
  });

  it("records one pinned message id", async () => {
    const moderator = createMemoryModerator();
    await moderator.pinMessage({
      tenantId: "t",
      chatId: "c",
      messageId: "55",
    });
    expect(moderator.messagesPinned).toEqual([
      { tenantId: "t", chatId: "c", messageId: "55" },
    ]);
  });

  it("does not invent a boost count", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readBoostCount({ tenantId: "t", chatId: "c", actorId: "77" }),
    ).rejects.toThrow("boosts_unavailable");
  });

  it("does not invent a member count", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readMemberCount({ tenantId: "t", chatId: "c" }),
    ).rejects.toThrow("count_unavailable");
  });
});
