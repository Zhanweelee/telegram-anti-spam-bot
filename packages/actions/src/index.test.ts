import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BanTarget,
  createMemoryLogger,
  createMemoryWarnStore,
  type DeleteTarget,
  type Event,
  type JoinTarget,
  type ModerationPort,
  type MuteTarget,
  parseEvent,
  WARN_LIMIT,
  type WarnStore,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  createBanAction,
  createDeclineAction,
  createDeleteAction,
  createLogAction,
  createMuteAction,
  createReportAction,
  createWarnAction,
} from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/delete.json"),
    "utf8",
  ),
) as {
  name: string;
  dryRun: boolean;
  hasMessage: boolean;
  status: string;
  detail?: string;
}[];

function messageEvent(): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: { id: "msg_1", text: "spam", textSha256: "c".repeat(64) },
  });
}

describe("delete action", () => {
  it("follows fixtures", async () => {
    const action = createDeleteAction();
    for (const fixture of fixtures) {
      const deleted: DeleteTarget[] = [];
      const event = messageEvent();
      const result = await action.execute({
        event: fixture.hasMessage ? event : { ...event, message: undefined },
        decision: {
          action: "delete",
          ruleIds: ["spam_keywords"],
          score: 1,
          reasons: [],
          evidence: [],
        },
        dryRun: fixture.dryRun,
        moderator: {
          async deleteMessage(target) {
            deleted.push(target);
          },
          async deleteMessages() {},
          async deleteCommandMenu() {},
          async muteActor() {},
          async banActor() {},
          async banActorFor() {},
          async banSenderChat() {},
          async unbanSenderChat() {},
          async approveJoin() {},
          async declineJoin() {},
          async declinePost() {},
          async setDefaultRights() {},
          async setCommandMenu() {},
          async setMenuButton() {},
          async setBotName() {},
          async setBotDescription() {},
          async setBotShortDescription() {},
          async deferJoin() {},
          async restrictActor() {},
          async releaseActor() {},
          async lockChat() {},
          async unlockChat() {},
          async unbanActor() {},
          async kickActor() {
            return "removed" as const;
          },
          async unmuteActor() {
            return "lifted" as const;
          },
          async readMember() {
            return { status: "member" as const };
          },
          async readMemberAllows() {
            throw new Error("allows_unavailable");
          },
          async readMemberAdmin() {
            throw new Error("canadmin_unavailable");
          },
          async readOwnAdmin() {
            throw new Error("cani_unavailable");
          },
          async readPermissions() {
            throw new Error("perms_unavailable");
          },
          async readAdministrators() {
            throw new Error("admins_unavailable");
          },
          async readMemberCount() {
            throw new Error("count_unavailable");
          },
          async readBoostCount() {
            throw new Error("boosts_unavailable");
          },
          async readDefaultRights() {
            throw new Error("botrights_unavailable");
          },
          async readCommandMenu() {
            throw new Error("commands_unavailable");
          },
          async readMenuButton() {
            throw new Error("button_unavailable");
          },
          async readBotName() {
            throw new Error("myname_unavailable");
          },
          async readBotDescription() {
            throw new Error("mydesc_unavailable");
          },
          async readBotShortDescription() {
            throw new Error("myshort_unavailable");
          },
          async readBotIdentity() {
            throw new Error("who_unavailable");
          },
          async readWebhook() {
            throw new Error("hook_unavailable");
          },
          async readChatGuard() {
            throw new Error("guard_unavailable");
          },
          async readJoinBot() {
            throw new Error("joinbot_unavailable");
          },
          async readReactions() {
            throw new Error("reactions_unavailable");
          },
          async readCommunity() {
            throw new Error("community_unavailable");
          },
          async readStickerSetRight() {
            throw new Error("canstickers_unavailable");
          },
          async readParentChat() {
            throw new Error("parent_unavailable");
          },
          async readPersonalChat() {
            throw new Error("personal_unavailable");
          },
          async readPrivatePrivacy() {
            throw new Error("privacy_unavailable");
          },
          async createTopic() {
            throw new Error("newtopic_unavailable");
          },
          async clearReactions() {},
          async revokeInvite() {},
          async unpinChat() {},
          async pinMessage() {},
          async unpinMessage() {},
          async removeReaction() {},
          async deletePhoto() {},
          async leaveChat() {},
          async setMemberTag() {},
          async setAdminTitle() {},
          async deleteStickerSet() {},
          async setReaction() {},
          async setStickerSet() {},
          async setTitle() {},
          async setDescription() {},
          async renameTopic() {},
          async renameGeneral() {},
          async unpinTopic() {},
          async closeTopic() {},
          async openTopic() {},
          async hideGeneral() {},
          async showGeneral() {},
          async deleteTopic() {},
        },
        logger: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
      expect(deleted).toHaveLength(fixture.status === "executed" ? 1 : 0);
      if (fixture.status === "executed") {
        expect(deleted[0]?.audienceId).toBeUndefined();
      }
    }
  });

  it("passes the audience id when only one user can see the message", async () => {
    const action = createDeleteAction();
    const deleted: DeleteTarget[] = [];
    const event = parseEvent({
      id: "evt_ephemeral",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "63101",
        text: "spam",
        textSha256: "c".repeat(64),
        audienceId: "940",
      },
    });
    const result = await action.execute({
      event,
      decision: {
        action: "delete",
        ruleIds: ["links"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator: {
        async deleteMessage(target) {
          deleted.push(target);
        },
        async deleteMessages() {},
        async deleteCommandMenu() {},
        async muteActor() {},
        async banActor() {},
        async banActorFor() {},
        async banSenderChat() {},
        async unbanSenderChat() {},
        async approveJoin() {},
        async declineJoin() {},
        async declinePost() {},
        async setDefaultRights() {},
        async setCommandMenu() {},
        async setMenuButton() {},
        async setBotName() {},
        async setBotDescription() {},
        async setBotShortDescription() {},
        async deferJoin() {},
        async restrictActor() {},
        async releaseActor() {},
        async lockChat() {},
        async unlockChat() {},
        async unbanActor() {},
        async kickActor() {
          return "removed" as const;
        },
        async unmuteActor() {
          return "lifted" as const;
        },
        async readMember() {
          return { status: "member" as const };
        },
        async readMemberAllows() {
          throw new Error("allows_unavailable");
        },
        async readMemberAdmin() {
          throw new Error("canadmin_unavailable");
        },
        async readOwnAdmin() {
          throw new Error("cani_unavailable");
        },
        async readPermissions() {
          throw new Error("perms_unavailable");
        },
        async readAdministrators() {
          throw new Error("admins_unavailable");
        },
        async readMemberCount() {
          throw new Error("count_unavailable");
        },
        async readBoostCount() {
          throw new Error("boosts_unavailable");
        },
        async readDefaultRights() {
          throw new Error("botrights_unavailable");
        },
        async readCommandMenu() {
          throw new Error("commands_unavailable");
        },
        async readMenuButton() {
          throw new Error("button_unavailable");
        },
        async readBotName() {
          throw new Error("myname_unavailable");
        },
        async readBotDescription() {
          throw new Error("mydesc_unavailable");
        },
        async readBotShortDescription() {
          throw new Error("myshort_unavailable");
        },
        async readBotIdentity() {
          throw new Error("who_unavailable");
        },
        async readWebhook() {
          throw new Error("hook_unavailable");
        },
        async readChatGuard() {
          throw new Error("guard_unavailable");
        },
        async readJoinBot() {
          throw new Error("joinbot_unavailable");
        },
        async readReactions() {
          throw new Error("reactions_unavailable");
        },
        async readCommunity() {
          throw new Error("community_unavailable");
        },
        async readStickerSetRight() {
          throw new Error("canstickers_unavailable");
        },
        async readParentChat() {
          throw new Error("parent_unavailable");
        },
        async readPersonalChat() {
          throw new Error("personal_unavailable");
        },
        async readPrivatePrivacy() {
          throw new Error("privacy_unavailable");
        },
        async createTopic() {
          throw new Error("newtopic_unavailable");
        },
        async clearReactions() {},
        async revokeInvite() {},
        async unpinChat() {},
        async pinMessage() {},
        async unpinMessage() {},
        async removeReaction() {},
        async deletePhoto() {},
        async leaveChat() {},
        async setMemberTag() {},
        async setAdminTitle() {},
        async deleteStickerSet() {},
        async setReaction() {},
        async setStickerSet() {},
        async setTitle() {},
        async setDescription() {},
        async renameTopic() {},
        async renameGeneral() {},
        async unpinTopic() {},
        async closeTopic() {},
        async openTopic() {},
        async hideGeneral() {},
        async showGeneral() {},
        async deleteTopic() {},
      },
      logger: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("executed");
    expect(deleted).toEqual([
      {
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        messageId: "63101",
        audienceId: "940",
      },
    ]);
  });

  it("skips a paid post and does not call delete", async () => {
    const action = createDeleteAction();
    const deleted: DeleteTarget[] = [];
    const event = parseEvent({
      id: "evt_paid",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00Z",
      actor: { id: "user_1", isAdmin: false },
      message: {
        id: "msg_paid",
        text: "请免费领取礼品",
        textSha256: "c".repeat(64),
        paid: true,
      },
    });
    const result = await action.execute({
      event,
      decision: {
        action: "delete",
        ruleIds: ["links"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator: {
        async deleteMessage(target) {
          deleted.push(target);
        },
        async deleteMessages() {},
        async deleteCommandMenu() {},
        async muteActor() {},
        async banActor() {},
        async banActorFor() {},
        async banSenderChat() {},
        async unbanSenderChat() {},
        async approveJoin() {},
        async declineJoin() {},
        async declinePost() {},
        async setDefaultRights() {},
        async setCommandMenu() {},
        async setMenuButton() {},
        async setBotName() {},
        async setBotDescription() {},
        async setBotShortDescription() {},
        async deferJoin() {},
        async restrictActor() {},
        async releaseActor() {},
        async lockChat() {},
        async unlockChat() {},
        async unbanActor() {},
        async kickActor() {
          return "removed" as const;
        },
        async unmuteActor() {
          return "lifted" as const;
        },
        async readMember() {
          return { status: "member" as const };
        },
        async readMemberAllows() {
          throw new Error("allows_unavailable");
        },
        async readMemberAdmin() {
          throw new Error("canadmin_unavailable");
        },
        async readOwnAdmin() {
          throw new Error("cani_unavailable");
        },
        async readPermissions() {
          throw new Error("perms_unavailable");
        },
        async readAdministrators() {
          throw new Error("admins_unavailable");
        },
        async readMemberCount() {
          throw new Error("count_unavailable");
        },
        async readBoostCount() {
          throw new Error("boosts_unavailable");
        },
        async readDefaultRights() {
          throw new Error("botrights_unavailable");
        },
        async readCommandMenu() {
          throw new Error("commands_unavailable");
        },
        async readMenuButton() {
          throw new Error("button_unavailable");
        },
        async readBotName() {
          throw new Error("myname_unavailable");
        },
        async readBotDescription() {
          throw new Error("mydesc_unavailable");
        },
        async readBotShortDescription() {
          throw new Error("myshort_unavailable");
        },
        async readBotIdentity() {
          throw new Error("who_unavailable");
        },
        async readWebhook() {
          throw new Error("hook_unavailable");
        },
        async readChatGuard() {
          throw new Error("guard_unavailable");
        },
        async readJoinBot() {
          throw new Error("joinbot_unavailable");
        },
        async readReactions() {
          throw new Error("reactions_unavailable");
        },
        async readCommunity() {
          throw new Error("community_unavailable");
        },
        async readStickerSetRight() {
          throw new Error("canstickers_unavailable");
        },
        async readParentChat() {
          throw new Error("parent_unavailable");
        },
        async readPersonalChat() {
          throw new Error("personal_unavailable");
        },
        async readPrivatePrivacy() {
          throw new Error("privacy_unavailable");
        },
        async createTopic() {
          throw new Error("newtopic_unavailable");
        },
        async clearReactions() {},
        async revokeInvite() {},
        async unpinChat() {},
        async pinMessage() {},
        async unpinMessage() {},
        async removeReaction() {},
        async deletePhoto() {},
        async leaveChat() {},
        async setMemberTag() {},
        async setAdminTitle() {},
        async deleteStickerSet() {},
        async setReaction() {},
        async setStickerSet() {},
        async setTitle() {},
        async setDescription() {},
        async renameTopic() {},
        async renameGeneral() {},
        async unpinTopic() {},
        async closeTopic() {},
        async openTopic() {},
        async hideGeneral() {},
        async showGeneral() {},
        async deleteTopic() {},
      },
      logger: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
    });
    expect(result).toEqual({
      actionId: "delete",
      status: "skipped",
      detail: "paid_post",
    });
    expect(deleted).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("请免费领取礼品");
  });
});

const muteFixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mute.json"),
    "utf8",
  ),
) as {
  name: string;
  dryRun: boolean;
  hasActor: boolean;
  status: string;
  detail?: string;
}[];

const banFixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ban.json"),
    "utf8",
  ),
) as typeof muteFixtures;

function ports(): ModerationPort & {
  muted: MuteTarget[];
  banned: BanTarget[];
} {
  const muted: MuteTarget[] = [];
  const banned: BanTarget[] = [];
  return {
    muted,
    banned,
    async deleteMessage() {},
    async deleteMessages() {},
    async deleteCommandMenu() {},
    async muteActor(target) {
      muted.push(target);
    },
    async banActor(target) {
      banned.push(target);
    },
    async banActorFor() {},
    async banSenderChat() {},
    async unbanSenderChat() {},
    async approveJoin() {},
    async declineJoin() {},
    async declinePost() {},
    async setDefaultRights() {},
    async setCommandMenu() {},
    async setMenuButton() {},
    async setBotName() {},
    async setBotDescription() {},
    async setBotShortDescription() {},
    async deferJoin() {},
    async restrictActor() {},
    async releaseActor() {},
    async lockChat() {},
    async unlockChat() {},
    async unbanActor() {},
    async kickActor() {
      return "removed" as const;
    },
    async unmuteActor() {
      return "lifted" as const;
    },
    async readMember() {
      return { status: "member" as const };
    },
    async readMemberAllows() {
      throw new Error("allows_unavailable");
    },
    async readMemberAdmin() {
      throw new Error("canadmin_unavailable");
    },
    async readOwnAdmin() {
      throw new Error("cani_unavailable");
    },
    async readPermissions() {
      throw new Error("perms_unavailable");
    },
    async readAdministrators() {
      throw new Error("admins_unavailable");
    },
    async readMemberCount() {
      throw new Error("count_unavailable");
    },
    async readBoostCount() {
      throw new Error("boosts_unavailable");
    },
    async readDefaultRights() {
      throw new Error("botrights_unavailable");
    },
    async readCommandMenu() {
      throw new Error("commands_unavailable");
    },
    async readMenuButton() {
      throw new Error("button_unavailable");
    },
    async readBotName() {
      throw new Error("myname_unavailable");
    },
    async readBotDescription() {
      throw new Error("mydesc_unavailable");
    },
    async readBotShortDescription() {
      throw new Error("myshort_unavailable");
    },
    async readBotIdentity() {
      throw new Error("who_unavailable");
    },
    async readWebhook() {
      throw new Error("hook_unavailable");
    },
    async readChatGuard() {
      throw new Error("guard_unavailable");
    },
    async readJoinBot() {
      throw new Error("joinbot_unavailable");
    },
    async readReactions() {
      throw new Error("reactions_unavailable");
    },
    async readCommunity() {
      throw new Error("community_unavailable");
    },
    async readStickerSetRight() {
      throw new Error("canstickers_unavailable");
    },
    async readParentChat() {
      throw new Error("parent_unavailable");
    },
    async readPersonalChat() {
      throw new Error("personal_unavailable");
    },
    async readPrivatePrivacy() {
      throw new Error("privacy_unavailable");
    },
    async createTopic() {
      throw new Error("newtopic_unavailable");
    },
    async clearReactions() {},
    async revokeInvite() {},
    async unpinChat() {},
    async pinMessage() {},
    async unpinMessage() {},
    async removeReaction() {},
    async deletePhoto() {},
    async leaveChat() {},
    async setMemberTag() {},
    async setAdminTitle() {},
    async deleteStickerSet() {},
    async setReaction() {},
    async setStickerSet() {},
    async setTitle() {},
    async setDescription() {},
    async renameTopic() {},
    async renameGeneral() {},
    async unpinTopic() {},
    async closeTopic() {},
    async openTopic() {},
    async hideGeneral() {},
    async showGeneral() {},
    async deleteTopic() {},
  };
}

function actorEvent(hasActor: boolean): Event {
  const event = messageEvent();
  if (hasActor) {
    return event;
  }
  return { ...event, actor: { id: "", isAdmin: false } };
}

describe("mute and ban actions", () => {
  const mute = createMuteAction({ durationSeconds: 3600 });
  const ban = createBanAction();

  it("follows mute fixtures and keeps message text off the port", async () => {
    for (const fixture of muteFixtures) {
      const moderator = ports();
      const result = await mute.execute({
        event: actorEvent(fixture.hasActor),
        decision: {
          action: "mute",
          ruleIds: ["spam_keywords"],
          score: 1,
          reasons: [],
          evidence: [],
        },
        dryRun: fixture.dryRun,
        moderator,
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
      expect(moderator.muted).toHaveLength(
        fixture.status === "executed" ? 1 : 0,
      );
      expect(JSON.stringify(moderator.muted)).not.toContain("spam");
    }
    const moderator = ports();
    await mute.execute({
      event: messageEvent(),
      decision: {
        action: "mute",
        ruleIds: ["spam_keywords"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator,
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    });
    expect(moderator.muted[0]).toEqual({
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      actorId: "user_1",
      durationSeconds: 3600,
    });
  });

  it("follows ban fixtures", async () => {
    for (const fixture of banFixtures) {
      const moderator = ports();
      const result = await ban.execute({
        event: actorEvent(fixture.hasActor),
        decision: {
          action: "ban",
          ruleIds: ["spam_keywords"],
          score: 1,
          reasons: [],
          evidence: [],
        },
        dryRun: fixture.dryRun,
        moderator,
        logger: { info() {}, warn() {}, error() {} },
        signal: { aborted: false },
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
      expect(moderator.banned).toHaveLength(
        fixture.status === "executed" ? 1 : 0,
      );
      expect(moderator.muted).toHaveLength(0);
    }
  });

  it("rejects a non-positive mute duration", () => {
    expect(() => createMuteAction({ durationSeconds: 0 })).toThrow();
  });
});

const logFixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/log.json"),
    "utf8",
  ),
) as {
  name: string;
  dryRun: boolean;
  status: string;
  detail?: string;
}[];

const reportFixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/report.json"),
    "utf8",
  ),
) as {
  name: string;
  dryRun: boolean;
  hasNotifier: boolean;
  status: string;
  detail?: string;
}[];

const phrase = "请免费领取礼品";

describe("log and report actions", () => {
  it("follows log fixtures and keeps the message out of the log", async () => {
    const action = createLogAction();
    for (const fixture of logFixtures) {
      const logger = createMemoryLogger();
      const event = messageEvent();
      const result = await action.execute({
        event: {
          ...event,
          message: event.message
            ? { ...event.message, text: phrase }
            : undefined,
        },
        decision: {
          action: "log",
          ruleIds: ["spam_keywords"],
          score: 1,
          reasons: ["keyword_match", phrase],
          evidence: [{ kind: "keyword", summary: phrase }],
        },
        dryRun: fixture.dryRun,
        moderator: ports(),
        logger,
        signal: { aborted: false },
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
      expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    }
  });

  it("follows report fixtures and hides notifier failures", async () => {
    for (const fixture of reportFixtures) {
      const notices: string[] = [];
      const action = createReportAction(
        fixture.hasNotifier
          ? {
              notifier: {
                async notify(notice) {
                  notices.push(JSON.stringify(notice));
                },
              },
            }
          : {},
      );
      const logger = createMemoryLogger();
      const result = await action.execute({
        event: messageEvent(),
        decision: {
          action: "report",
          ruleIds: ["spam_keywords"],
          score: 1,
          reasons: ["keyword_match"],
          evidence: [],
        },
        dryRun: fixture.dryRun,
        moderator: ports(),
        logger,
        signal: { aborted: false },
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
    }
    const logger = createMemoryLogger();
    const failed = await createReportAction({
      notifier: {
        async notify() {
          throw new Error(phrase);
        },
      },
    }).execute({
      event: messageEvent(),
      decision: {
        action: "report",
        ruleIds: ["spam_keywords"],
        score: 1,
        reasons: ["keyword_match"],
        evidence: [],
      },
      dryRun: false,
      moderator: ports(),
      logger,
      signal: { aborted: false },
    });
    expect(failed).toEqual({
      actionId: "report",
      status: "failed",
      detail: "report_failed",
    });
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });
});

describe("decline action", () => {
  const action = createDeclineAction();

  it("declines a join request and ignores other events", async () => {
    const declined: BanTarget[] = [];
    const moderator = {
      ...ports(),
      async declineJoin(target: BanTarget) {
        declined.push(target);
      },
    };
    const request = parseEvent({
      id: "evt_join",
      tenantId: "local",
      chatId: "-100",
      kind: "join_request",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "83", isAdmin: false },
      profile: { text: "bio", textSha256: "ab".repeat(32) },
    });
    const executed = await action.execute({
      event: request,
      decision: {
        action: "decline",
        ruleIds: ["join_request"],
        score: 1,
        reasons: ["short_link"],
        evidence: [],
      },
      dryRun: false,
      moderator,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(executed.status).toBe("executed");
    expect(declined).toEqual([
      { tenantId: "local", chatId: "-100", actorId: "83" },
    ]);
    const skipped = await action.execute({
      event: messageEvent(),
      decision: {
        action: "decline",
        ruleIds: ["join_request"],
        score: 1,
        reasons: ["short_link"],
        evidence: [],
      },
      dryRun: false,
      moderator,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(skipped).toEqual({
      actionId: "decline",
      status: "failed",
      detail: "not_join_request",
    });
  });

  it("forwards a guarded join query when it declines", async () => {
    const declined: JoinTarget[] = [];
    const moderator = {
      ...ports(),
      async declineJoin(target: JoinTarget) {
        declined.push(target);
      },
    };
    const request = parseEvent({
      id: "evt_join",
      tenantId: "local",
      chatId: "-100",
      kind: "join_request",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "83", isAdmin: false },
      joinQueryId: "query83",
      profile: { text: "请免费领取礼品", textSha256: "ab".repeat(32) },
    });
    const executed = await action.execute({
      event: request,
      decision: {
        action: "decline",
        ruleIds: ["join_request"],
        score: 1,
        reasons: ["short_link"],
        evidence: [],
      },
      dryRun: false,
      moderator,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(executed.status).toBe("executed");
    expect(declined).toEqual([
      {
        tenantId: "local",
        chatId: "-100",
        actorId: "83",
        queryId: "query83",
      },
    ]);
    const dry = await action.execute({
      event: request,
      decision: {
        action: "decline",
        ruleIds: ["join_request"],
        score: 1,
        reasons: ["short_link"],
        evidence: [],
      },
      dryRun: true,
      moderator,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(dry).toEqual({
      actionId: "decline",
      status: "skipped",
      detail: "dry_run",
    });
    expect(declined).toHaveLength(1);
  });
});

describe("warn action", () => {
  const phrase = "请免费领取礼品";

  function countingStore(): WarnStore & { readonly reads: number } {
    const store = createMemoryWarnStore();
    let reads = 0;
    return {
      get reads() {
        return reads;
      },
      async read(target) {
        reads += 1;
        return store.read(target);
      },
      increment: (target) => store.increment(target),
      write: (target, count) => store.write(target, count),
      clear: (target) => store.clear(target),
      list: (tenantId, chatId) => store.list(tenantId, chatId),
    };
  }

  function warnModerator(input?: {
    readonly failBan?: boolean;
    readonly failDelete?: boolean;
  }): ModerationPort & {
    readonly deleted: DeleteTarget[];
    readonly banned: BanTarget[];
  } {
    const base = ports();
    const deleted: DeleteTarget[] = [];
    return {
      ...base,
      deleted,
      async deleteMessage(target) {
        if (input?.failDelete) {
          throw new Error("delete_failed");
        }
        deleted.push(target);
      },
      async banActor(target) {
        if (input?.failBan) {
          throw new Error("ban_failed");
        }
        base.banned.push(target);
      },
    };
  }

  function warnContext(
    event: Event,
    moderator: ModerationPort,
    dryRun = false,
  ) {
    return {
      event,
      decision: {
        action: "warn" as const,
        ruleIds: ["spam_keywords"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun,
      moderator,
      logger: { info() {}, warn() {}, error() {} },
      signal: { aborted: false },
    };
  }

  it("deletes the first two messages and bans on the third", async () => {
    const store = countingStore();
    const action = createWarnAction({ store });
    const moderator = warnModerator();
    for (const step of [1, 2]) {
      const result = await action.execute(
        warnContext(messageEvent(), moderator),
      );
      expect(result, String(step)).toEqual({
        actionId: "warn",
        status: "executed",
      });
    }
    expect(moderator.deleted).toHaveLength(2);
    expect(moderator.banned).toEqual([]);
    expect(
      await store.read({
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        actorId: "user_1",
      }),
    ).toBe(2);
    const third = await action.execute(warnContext(messageEvent(), moderator));
    expect(third).toEqual({ actionId: "warn", status: "executed" });
    expect(moderator.deleted).toHaveLength(3);
    expect(moderator.banned).toEqual([
      {
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        actorId: "user_1",
      },
    ]);
    expect(JSON.stringify(third)).not.toContain(phrase);
    expect(JSON.stringify(moderator.banned)).not.toContain("spam");
  });

  it("puts the count back when the third ban fails", async () => {
    const store = createMemoryWarnStore();
    const action = createWarnAction({ store });
    const target = {
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      actorId: "user_1",
    };
    await store.write(target, WARN_LIMIT - 1);
    const moderator = warnModerator({ failBan: true });
    await expect(
      action.execute(warnContext(messageEvent(), moderator)),
    ).rejects.toThrow("ban_failed");
    expect(await store.read(target)).toBe(WARN_LIMIT - 1);
    expect(moderator.deleted).toHaveLength(1);
    expect(moderator.banned).toEqual([]);
  });

  it("still throws the ban error when the rollback write fails", async () => {
    const store = createMemoryWarnStore();
    const action = createWarnAction({
      store: {
        read: (target) => store.read(target),
        increment: (target) => store.increment(target),
        async write() {
          throw new Error("write_failed");
        },
        clear: (target) => store.clear(target),
        list: (tenantId, chatId) => store.list(tenantId, chatId),
      },
    });
    const target = {
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      actorId: "user_1",
    };
    await store.write(target, WARN_LIMIT - 1);
    const moderator = warnModerator({ failBan: true });
    await expect(
      action.execute(warnContext(messageEvent(), moderator)),
    ).rejects.toThrow("ban_failed");
  });

  it("skips a paid post without counting or deleting", async () => {
    const store = countingStore();
    const action = createWarnAction({ store });
    const moderator = warnModerator();
    const event = messageEvent();
    const result = await action.execute(
      warnContext(
        {
          ...event,
          message: event.message ? { ...event.message, paid: true } : undefined,
        },
        moderator,
      ),
    );
    expect(result).toEqual({
      actionId: "warn",
      status: "skipped",
      detail: "paid_post",
    });
    expect(moderator.deleted).toEqual([]);
    expect(store.reads).toBe(0);
    expect(
      await store.read({
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        actorId: "user_1",
      }),
    ).toBe(0);
  });

  it("skips a dry run without touching the store or the moderator", async () => {
    const store = countingStore();
    const action = createWarnAction({ store });
    const moderator = warnModerator();
    const result = await action.execute(
      warnContext(messageEvent(), moderator, true),
    );
    expect(result).toEqual({
      actionId: "warn",
      status: "skipped",
      detail: "dry_run",
    });
    expect(moderator.deleted).toEqual([]);
    expect(moderator.banned).toEqual([]);
    expect(store.reads).toBe(0);
  });

  it("fails a missing actor without deleting", async () => {
    const store = countingStore();
    const action = createWarnAction({ store });
    const moderator = warnModerator();
    const result = await action.execute(
      warnContext(actorEvent(false), moderator),
    );
    expect(result).toEqual({
      actionId: "warn",
      status: "failed",
      detail: "missing_actor",
    });
    expect(moderator.deleted).toEqual([]);
    expect(store.reads).toBe(0);
  });

  it("bans again without incrementing once the limit is already reached", async () => {
    const store = countingStore();
    const action = createWarnAction({ store });
    const target = {
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      actorId: "user_1",
    };
    await store.write(target, WARN_LIMIT);
    const moderator = warnModerator();
    const result = await action.execute(warnContext(messageEvent(), moderator));
    expect(result).toEqual({ actionId: "warn", status: "executed" });
    expect(moderator.banned).toEqual([target]);
    expect(await store.read(target)).toBe(WARN_LIMIT);
  });

  it("counts a hit that has no message id", async () => {
    const store = createMemoryWarnStore();
    const action = createWarnAction({ store });
    const moderator = warnModerator();
    const event = messageEvent();
    const result = await action.execute(
      warnContext({ ...event, message: undefined }, moderator),
    );
    expect(result).toEqual({ actionId: "warn", status: "executed" });
    expect(moderator.deleted).toEqual([]);
    expect(
      await store.read({
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        actorId: "user_1",
      }),
    ).toBe(1);
  });

  it("forwards the audience and does not count when delete throws", async () => {
    const store = countingStore();
    const action = createWarnAction({ store });
    const kept = warnModerator();
    const event = messageEvent();
    const withAudience = {
      ...event,
      message: event.message
        ? { ...event.message, audienceId: "user_9" }
        : undefined,
    };
    await action.execute(warnContext(withAudience, kept));
    expect(kept.deleted).toEqual([
      {
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        messageId: "msg_1",
        audienceId: "user_9",
      },
    ]);
    const failing = warnModerator({ failDelete: true });
    await expect(
      action.execute(warnContext(messageEvent(), failing)),
    ).rejects.toThrow("delete_failed");
    expect(
      await store.read({
        tenantId: "tenant_demo",
        chatId: "chat_demo",
        actorId: "user_1",
      }),
    ).toBe(1);
  });
});
