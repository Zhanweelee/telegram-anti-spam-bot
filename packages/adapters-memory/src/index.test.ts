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
    await moderator.banActorFor({
      tenantId: "t",
      chatId: "c",
      actorId: "u",
      durationSeconds: 3600,
    });
    expect(moderator.bannedFor).toEqual([
      {
        tenantId: "t",
        chatId: "c",
        actorId: "u",
        durationSeconds: 3600,
      },
    ]);
    expect(
      await moderator.kickActor({ tenantId: "t", chatId: "c", actorId: "u" }),
    ).toBe("removed");
    expect(moderator.kicked).toEqual([
      { tenantId: "t", chatId: "c", actorId: "u" },
    ]);
    expect(moderator.unbanned).toEqual([]);
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

  it("keeps rule actions apart from switches", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.listRuleActions("tenant_a", "chat_1")).toEqual([]);
    expect(
      await runtime.setRuleAction(
        "tenant_a",
        "chat_1",
        "spam_keywords",
        "warn",
      ),
    ).toBe(true);
    expect(await runtime.listRuleActions("tenant_a", "chat_1")).toEqual([
      { ruleId: "spam_keywords", action: "warn" },
    ]);
    expect(await runtime.listRuleSwitches("tenant_a", "chat_1")).toEqual([]);
    expect(await runtime.listRuleActions("tenant_a", "chat_2")).toEqual([]);
    expect(
      await runtime.setRuleAction(
        "tenant_a",
        "chat_1",
        "spam_keywords",
        "mute",
      ),
    ).toBe(true);
    await runtime.clearRuleAction("tenant_a", "chat_1", "spam_keywords");
    expect(await runtime.listRuleActions("tenant_a", "chat_1")).toEqual([]);
    for (let index = 0; index < 32; index += 1) {
      expect(
        await runtime.setRuleSwitch("tenant_a", "full", `rule_${index}`, true),
      ).toBe(true);
      expect(
        await runtime.setRuleAction(
          "tenant_a",
          "actions",
          `rule_${index}`,
          "log",
        ),
      ).toBe(true);
    }
    expect(
      await runtime.setRuleAction("tenant_a", "actions", "rule_extra", "ban"),
    ).toBe(false);
    expect(
      await runtime.setRuleAction("tenant_a", "actions", "rule_0", "report"),
    ).toBe(true);
    expect(await runtime.listRuleActions("tenant_a", "actions")).toHaveLength(
      32,
    );
    expect(await runtime.listRuleSwitches("tenant_a", "full")).toHaveLength(32);
    for (let index = 0; index < 255; index += 1) {
      expect(
        await runtime.setRuleAction(
          "tenant_a",
          `act_${index}`,
          "links",
          "delete",
        ),
      ).toBe(true);
    }
    expect(
      await runtime.setRuleAction("tenant_a", "overflow", "links", "delete"),
    ).toBe(false);
    for (let index = 0; index < 32; index += 1) {
      await runtime.clearRuleAction("tenant_a", "actions", `rule_${index}`);
    }
    expect(
      await runtime.setRuleAction("tenant_a", "overflow", "links", "captcha"),
    ).toBe(true);
  });

  it("keeps a report chat apart from rule switches", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.getReportChat("tenant_a", "chat_1")).toBeNull();
    expect(await runtime.setReportChat("tenant_a", "chat_1", "77")).toBe(true);
    expect(await runtime.getReportChat("tenant_a", "chat_1")).toBe("77");
    expect(await runtime.getReportChat("tenant_a", "chat_2")).toBeNull();
    expect(await runtime.listRuleSwitches("tenant_a", "chat_1")).toEqual([]);
    expect(await runtime.setReportChat("tenant_a", "chat_1", "88")).toBe(true);
    await runtime.clearReportChat("tenant_a", "chat_1");
    expect(await runtime.getReportChat("tenant_a", "chat_1")).toBeNull();
    for (let index = 0; index < 256; index += 1) {
      expect(
        await runtime.setReportChat("tenant_a", `chat_${index}`, "77"),
      ).toBe(true);
    }
    expect(await runtime.setReportChat("tenant_a", "overflow", "77")).toBe(
      false,
    );
    await runtime.clearReportChat("tenant_a", "chat_0");
    expect(await runtime.setReportChat("tenant_a", "overflow", "88")).toBe(
      true,
    );
  });

  it("keeps a flood policy apart from report chats", async () => {
    const runtime = createMemoryRuntimeStore();
    expect(await runtime.getFloodPolicy("tenant_a", "chat_1")).toBeNull();
    expect(
      await runtime.setFloodPolicy("tenant_a", "chat_1", {
        threshold: 8,
        windowSeconds: 20,
      }),
    ).toBe(true);
    expect(await runtime.getFloodPolicy("tenant_a", "chat_1")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(await runtime.getFloodPolicy("tenant_a", "chat_2")).toBeNull();
    expect(await runtime.getReportChat("tenant_a", "chat_1")).toBeNull();
    expect(
      await runtime.setFloodPolicy("tenant_a", "chat_1", {
        threshold: 5,
        windowSeconds: 10,
      }),
    ).toBe(true);
    expect(await runtime.getFloodPolicy("tenant_a", "chat_1")).toBeNull();
    expect(
      await runtime.setFloodPolicy("tenant_a", "chat_1", {
        threshold: 1,
        windowSeconds: 10,
      }),
    ).toBe(false);
    for (let index = 0; index < 256; index += 1) {
      expect(
        await runtime.setFloodPolicy("tenant_a", `chat_${index}`, {
          threshold: 8,
          windowSeconds: 10,
        }),
      ).toBe(true);
    }
    expect(
      await runtime.setFloodPolicy("tenant_a", "overflow", {
        threshold: 8,
        windowSeconds: 10,
      }),
    ).toBe(false);
    expect(
      await runtime.setFloodPolicy("tenant_a", "overflow", {
        threshold: 5,
        windowSeconds: 10,
      }),
    ).toBe(true);
    expect(await runtime.getFloodPolicy("tenant_a", "overflow")).toBeNull();
    await runtime.clearFloodPolicy("tenant_a", "chat_0");
    expect(
      await runtime.setFloodPolicy("tenant_a", "overflow", {
        threshold: 4,
        windowSeconds: 20,
      }),
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
    await moderator.deleteMessage({
      tenantId: "t",
      chatId: "c",
      messageId: "55",
      audienceId: "77",
    });
    expect(moderator.deleted).toEqual([
      { tenantId: "t", chatId: "c", messageId: "m" },
      { tenantId: "t", chatId: "c", messageId: "55", audienceId: "77" },
    ]);
  });

  it("does not invent a bot name", async () => {
    const moderator = createMemoryModerator();
    await expect(moderator.readBotName({ tenantId: "t" })).rejects.toThrow(
      "myname_unavailable",
    );
  });

  it("does not invent a bot identity", async () => {
    const moderator = createMemoryModerator();
    await expect(moderator.readBotIdentity({ tenantId: "t" })).rejects.toThrow(
      "who_unavailable",
    );
  });

  it("does not invent a webhook snapshot", async () => {
    const moderator = createMemoryModerator();
    await expect(moderator.readWebhook({ tenantId: "t" })).rejects.toThrow(
      "hook_unavailable",
    );
  });

  it("does not invent a chat guard posture", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readChatGuard({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("guard_unavailable");
  });

  it("does not invent a join-request bot", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readJoinBot({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("joinbot_unavailable");
  });

  it("does not invent an allowed reaction count", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readReactions({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("reactions_unavailable");
  });

  it("does not invent a chat community", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readCommunity({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("community_unavailable");
  });

  it("does not invent a sticker set right", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readStickerSetRight({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("canstickers_unavailable");
  });

  it("does not invent a parent channel", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readParentChat({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("parent_unavailable");
  });

  it("does not invent a personal channel", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readPersonalChat({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("personal_unavailable");
  });

  it("does not invent this bot's admin rights", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readOwnAdmin({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("cani_unavailable");
  });

  it("does not invent one member's admin rights", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readMemberAdmin({
        tenantId: "t",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("canadmin_unavailable");
  });

  it("does not invent individual allows", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readMemberAllows({
        tenantId: "t",
        chatId: "-100",
        actorId: "77",
      }),
    ).rejects.toThrow("allows_unavailable");
  });

  it("does not invent private-chat privacy", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readPrivatePrivacy({ tenantId: "t", chatId: "-100" }),
    ).rejects.toThrow("privacy_unavailable");
  });

  it("does not invent a bot short description", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readBotShortDescription({ tenantId: "t" }),
    ).rejects.toThrow("myshort_unavailable");
  });

  it("does not invent a bot description", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readBotDescription({ tenantId: "t" }),
    ).rejects.toThrow("mydesc_unavailable");
  });

  it("records a bot short description without a language", async () => {
    const moderator = createMemoryModerator();
    await moderator.setBotShortDescription({
      tenantId: "t",
      shortDescription: "ops",
    });
    await moderator.setBotShortDescription({
      tenantId: "t",
      shortDescription: "",
    });
    expect(moderator.botShortDescriptionsSet).toEqual([
      { tenantId: "t", shortDescription: "ops" },
      { tenantId: "t", shortDescription: "" },
    ]);
    expect(moderator.botShortDescriptionsSet[0]).not.toHaveProperty(
      "languageCode",
    );
  });

  it("records a bot description without a language", async () => {
    const moderator = createMemoryModerator();
    await moderator.setBotDescription({ tenantId: "t", description: "ops" });
    await moderator.setBotDescription({ tenantId: "t", description: "" });
    expect(moderator.botDescriptionsSet).toEqual([
      { tenantId: "t", description: "ops" },
      { tenantId: "t", description: "" },
    ]);
    expect(moderator.botDescriptionsSet[0]).not.toHaveProperty("languageCode");
  });

  it("records a bot name without a language", async () => {
    const moderator = createMemoryModerator();
    await moderator.setBotName({ tenantId: "t", name: "ops" });
    await moderator.setBotName({ tenantId: "t", name: "" });
    expect(moderator.botNamesSet).toEqual([
      { tenantId: "t", name: "ops" },
      { tenantId: "t", name: "" },
    ]);
    expect(moderator.botNamesSet[0]).not.toHaveProperty("languageCode");
  });

  it("records a default menu button without a chat", async () => {
    const moderator = createMemoryModerator();
    await moderator.setMenuButton({ tenantId: "t", kind: "commands" });
    expect(moderator.menuButtonsSet).toEqual([
      { tenantId: "t", kind: "commands" },
    ]);
    expect(moderator.menuButtonsSet[0]).not.toHaveProperty("chatId");
  });

  it("records a cleared private command menu without a chat", async () => {
    const moderator = createMemoryModerator();
    await moderator.deleteCommandMenu({ tenantId: "t" });
    expect(moderator.commandMenusDeleted).toEqual([{ tenantId: "t" }]);
    expect(moderator.commandMenusDeleted[0]).not.toHaveProperty("chatId");
    expect(moderator.commandMenusSet).toEqual([]);
  });

  it("records a private command menu without a chat", async () => {
    const moderator = createMemoryModerator();
    await moderator.setCommandMenu({
      tenantId: "t",
      commands: [
        { command: "help", description: "/help" },
        { command: "setcommands", description: "/setcommands [private]" },
      ],
    });
    expect(moderator.commandMenusSet).toEqual([
      {
        tenantId: "t",
        commands: [
          { command: "help", description: "/help" },
          { command: "setcommands", description: "/setcommands [private]" },
        ],
      },
    ]);
    expect(moderator.commandMenusSet[0]).not.toHaveProperty("chatId");
    expect(moderator.commandMenusSet[0]).not.toHaveProperty("scope");
  });

  it("records default administrator rights without inventing a chat", async () => {
    const moderator = createMemoryModerator();
    await moderator.setDefaultRights({
      tenantId: "t",
      forChannels: false,
    });
    await moderator.setDefaultRights({
      tenantId: "t",
      forChannels: true,
      rights: {
        anonymous: false,
        manageChat: true,
        deleteMessages: false,
        manageVideoChats: false,
        restrictMembers: false,
        promoteMembers: false,
        changeInfo: false,
        inviteUsers: false,
        postStories: false,
        editStories: false,
        deleteStories: false,
        postMessages: false,
        editMessages: false,
        pinMessages: false,
        manageTopics: false,
        manageDirectMessages: false,
        manageTags: false,
        sendWelcomeMessages: false,
      },
    });
    expect(moderator.defaultRightsSet[0]).toEqual({
      tenantId: "t",
      forChannels: false,
    });
    expect(moderator.defaultRightsSet[0]).not.toHaveProperty("rights");
    expect(moderator.defaultRightsSet[0]).not.toHaveProperty("chatId");
    expect(moderator.defaultRightsSet[1]?.rights?.manageChat).toBe(true);
    expect(moderator.defaultRightsSet[1]?.forChannels).toBe(true);
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

  it("records one renamed forum topic", async () => {
    const moderator = createMemoryModerator();
    await moderator.renameTopic({
      tenantId: "t",
      chatId: "c",
      threadId: "1",
      name: "hello",
    });
    expect(moderator.topicsRenamed).toEqual([
      { tenantId: "t", chatId: "c", threadId: "1", name: "hello" },
    ]);
    expect(JSON.stringify(moderator.topicsRenamed)).not.toContain("icon");
  });

  it("records one renamed General topic without a thread id", async () => {
    const moderator = createMemoryModerator();
    await moderator.renameGeneral({
      tenantId: "t",
      chatId: "c",
      name: "hello",
    });
    expect(moderator.generalsRenamed).toEqual([
      { tenantId: "t", chatId: "c", name: "hello" },
    ]);
    expect(JSON.stringify(moderator.generalsRenamed)).not.toContain("thread");
  });

  it("does not invent a forum topic id", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.createTopic({
        tenantId: "t",
        chatId: "c",
        name: "请免费领取礼品",
      }),
    ).rejects.toThrow("newtopic_unavailable");
  });

  it("records one changed chat description including an empty one", async () => {
    const moderator = createMemoryModerator();
    await moderator.setDescription({
      tenantId: "t",
      chatId: "c",
      description: "hello",
    });
    await moderator.setDescription({
      tenantId: "t",
      chatId: "c",
      description: "",
    });
    expect(moderator.descriptionsSet).toEqual([
      { tenantId: "t", chatId: "c", description: "hello" },
      { tenantId: "t", chatId: "c", description: "" },
    ]);
    expect(JSON.stringify(moderator.descriptionsSet)).not.toContain("title");
    expect(JSON.stringify(moderator.descriptionsSet)).not.toContain("photo");
  });

  it("records one changed chat title", async () => {
    const moderator = createMemoryModerator();
    const title = "请免费领取礼品";
    await moderator.setTitle({ tenantId: "t", chatId: "c", title });
    expect(moderator.titlesSet).toEqual([
      { tenantId: "t", chatId: "c", title },
    ]);
    expect(JSON.stringify(moderator.titlesSet)).not.toContain("description");
    expect(JSON.stringify(moderator.titlesSet)).not.toContain("photo");
  });

  it("records one set emoji reaction", async () => {
    const moderator = createMemoryModerator();
    await moderator.setReaction({
      tenantId: "t",
      chatId: "c",
      messageId: "55",
      emoji: "👍",
    });
    expect(moderator.reactionsSet).toEqual([
      { tenantId: "t", chatId: "c", messageId: "55", emoji: "👍" },
    ]);
    expect(JSON.stringify(moderator.reactionsSet)).not.toContain("is_big");
    expect(JSON.stringify(moderator.reactionsSet)).not.toContain("custom");
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

  it("records one set group sticker set", async () => {
    const moderator = createMemoryModerator();
    await moderator.setStickerSet({
      tenantId: "t",
      chatId: "c",
      name: "Animals_by_SomeBot",
    });
    expect(moderator.stickerSetsSet).toEqual([
      { tenantId: "t", chatId: "c", name: "Animals_by_SomeBot" },
    ]);
    expect(JSON.stringify(moderator.stickerSetsSet)).not.toContain("file_id");
  });

  it("records one admin title including an empty one", async () => {
    const moderator = createMemoryModerator();
    await moderator.setAdminTitle({
      tenantId: "t",
      chatId: "c",
      actorId: "77",
      title: "ops",
    });
    await moderator.setAdminTitle({
      tenantId: "t",
      chatId: "c",
      actorId: "77",
      title: "",
    });
    expect(moderator.adminTitlesSet).toEqual([
      { tenantId: "t", chatId: "c", actorId: "77", title: "ops" },
      { tenantId: "t", chatId: "c", actorId: "77", title: "" },
    ]);
    expect(JSON.stringify(moderator.adminTitlesSet)).not.toContain("promote");
  });

  it("records one declined suggested post with and without a comment", async () => {
    const moderator = createMemoryModerator();
    await moderator.declinePost({
      tenantId: "t",
      chatId: "c",
      messageId: "55",
    });
    await moderator.declinePost({
      tenantId: "t",
      chatId: "c",
      messageId: "1",
      comment: "hello",
    });
    expect(moderator.suggestedPostsDeclined).toEqual([
      { tenantId: "t", chatId: "c", messageId: "55" },
      { tenantId: "t", chatId: "c", messageId: "1", comment: "hello" },
    ]);
    expect(JSON.stringify(moderator.suggestedPostsDeclined[0])).not.toContain(
      "comment",
    );
    expect(JSON.stringify(moderator.suggestedPostsDeclined)).not.toContain(
      "approve",
    );
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

  it("does not invent a menu button", async () => {
    const moderator = createMemoryModerator();
    await expect(moderator.readMenuButton({ tenantId: "t" })).rejects.toThrow(
      "button_unavailable",
    );
  });

  it("does not invent a command menu", async () => {
    const moderator = createMemoryModerator();
    await expect(moderator.readCommandMenu({ tenantId: "t" })).rejects.toThrow(
      "commands_unavailable",
    );
  });

  it("does not invent default administrator rights", async () => {
    const moderator = createMemoryModerator();
    await expect(
      moderator.readDefaultRights({ tenantId: "t", forChannels: false }),
    ).rejects.toThrow("botrights_unavailable");
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
