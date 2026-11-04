import {
  type CaptchaChallenge,
  type CaptchaStore,
  type Clock,
  createFixedClock,
  createMemoryLogger,
  defaultPrefilterPolicy,
  defineDetector,
  type ModerationPort,
  type MuteTarget,
  parseEvent,
  parseRuleSet,
  runPipeline,
  type Storage,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCaptchaAction } from "./index.js";

const phrase = "请免费领取礼品";
const nonce = "0123456789abcdef";

function store(): CaptchaStore {
  const values = new Map<string, CaptchaChallenge>();
  return {
    async get(tenantId, chatId, actorId) {
      return values.get(`${tenantId}\n${chatId}\n${actorId}`) ?? null;
    },
    async put(challenge) {
      values.set(
        `${challenge.tenantId}\n${challenge.chatId}\n${challenge.actorId}`,
        challenge,
      );
    },
    async delete(tenantId, chatId, actorId) {
      values.delete(`${tenantId}\n${chatId}\n${actorId}`);
    },
    async deleteMany() {},
    async take() {
      return null;
    },
    async takeMany() {
      return [];
    },
    async attachPrompt() {
      return false;
    },
    async findByNonce() {
      return null;
    },
    async listExpired() {
      return [];
    },
  };
}

function moderator(
  restrict?: (target: MuteTarget) => Promise<void>,
): ModerationPort & {
  restricted: MuteTarget[];
  deleted: { tenantId: string; chatId: string; messageId: string }[];
} {
  const restricted: MuteTarget[] = [];
  const deleted: { tenantId: string; chatId: string; messageId: string }[] = [];
  return {
    restricted,
    deleted,
    async deleteMessage(target) {
      deleted.push({
        tenantId: target.tenantId,
        chatId: target.chatId,
        messageId: target.messageId,
      });
    },
    async deleteMessages() {},
    async deleteCommandMenu() {},
    async muteActor() {},
    async banActor() {},
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
    async restrictActor(target) {
      if (restrict) {
        await restrict(target);
        return;
      }
      restricted.push({ ...target });
    },
    async releaseActor() {},
    async lockChat() {},
    async unlockChat() {},
    async unbanActor() {},
    async unmuteActor() {
      return "lifted" as const;
    },
    async readMember() {
      return { status: "member" as const };
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

function storage(): Storage {
  return {
    async appendAudit() {},
    async claimAudit() {
      return false;
    },
    async putAuditsIfAbsent() {},
    async listAudits() {
      return [];
    },
    async getAudit() {
      return null;
    },
    async exportAudits() {
      return [];
    },
    async countAudits() {
      return 0;
    },
    async deleteAudits() {
      return 0;
    },
    async getRuleSet() {
      return null;
    },
    async putRuleSet() {},
  };
}

function joinEvent(membership?: "join") {
  return parseEvent({
    id: "evt_join",
    tenantId: "local",
    chatId: "-100",
    kind: "chat_member",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "77", isAdmin: false },
    ...(membership ? { membership } : {}),
  });
}

function action(clock: Clock, challenges = store(), createNonce = () => nonce) {
  return createCaptchaAction({
    store: challenges,
    clock,
    createNonce,
  });
}

describe("captcha action", () => {
  const clock = createFixedClock("2026-11-01T00:00:00.000Z");

  it("skips messages and dry-run without restricting", async () => {
    const challenges = store();
    const ports = moderator();
    const created = action(clock, challenges);
    const message = parseEvent({
      id: "evt_msg",
      tenantId: "local",
      chatId: "-100",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "77", isAdmin: false },
      message: {
        id: "1",
        text: phrase,
        textSha256: "ab".repeat(32),
      },
    });
    const skipped = await created.execute({
      event: message,
      decision: {
        action: "captcha",
        ruleIds: ["new_member"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator: ports,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(skipped).toEqual({
      actionId: "captcha",
      status: "skipped",
      detail: "not_join",
    });
    const dry = await created.execute({
      event: joinEvent("join"),
      decision: {
        action: "captcha",
        ruleIds: ["new_member"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: true,
      moderator: ports,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(dry.detail).toBe("dry_run");
    expect(ports.restricted).toEqual([]);
    expect(await challenges.get("local", "-100", "77")).toBeNull();
    expect(JSON.stringify(skipped)).not.toContain(phrase);
  });

  it("restricts a join and keeps the nonce out of the result", async () => {
    const challenges = store();
    const ports = moderator();
    const logger = createMemoryLogger();
    const result = await action(clock, challenges).execute({
      event: joinEvent("join"),
      decision: {
        action: "captcha",
        ruleIds: ["new_member"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator: ports,
      logger,
      signal: { aborted: false },
    });
    expect(result).toEqual({ actionId: "captcha", status: "executed" });
    expect(ports.restricted).toEqual([
      {
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 300,
      },
    ]);
    const saved = await challenges.get("local", "-100", "77");
    expect(saved?.nonce).toBe(nonce);
    expect(JSON.stringify(result)).not.toContain(nonce);
    expect(JSON.stringify(logger.entries)).not.toContain(nonce);
  });

  it("deletes the previous prompt when a join replaces it", async () => {
    const challenges = store();
    const ports = moderator();
    const logger = createMemoryLogger();
    await challenges.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
      messageId: "42",
    });
    const result = await action(clock, challenges).execute({
      event: joinEvent("join"),
      decision: {
        action: "captcha",
        ruleIds: ["new_member"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator: ports,
      logger,
      signal: { aborted: false },
    });
    expect(result).toEqual({ actionId: "captcha", status: "executed" });
    expect(ports.deleted).toEqual([
      { tenantId: "local", chatId: "-100", messageId: "42" },
    ]);
    const saved = await challenges.get("local", "-100", "77");
    expect(saved?.nonce).toBe(nonce);
    expect(saved?.messageId).toBeUndefined();
    expect(JSON.stringify(logger.entries)).not.toContain("42");
    expect(JSON.stringify(result)).not.toContain(nonce);
  });

  it("rolls back when restrict fails", async () => {
    const challenges = store();
    const ports = moderator(async () => {
      throw new Error(`restrict_failed ${phrase}`);
    });
    const logger = createMemoryLogger();
    const result = await action(clock, challenges).execute({
      event: joinEvent("join"),
      decision: {
        action: "captcha",
        ruleIds: ["new_member"],
        score: 1,
        reasons: [],
        evidence: [],
      },
      dryRun: false,
      moderator: ports,
      logger,
      signal: { aborted: false },
    });
    expect(result).toEqual({
      actionId: "captcha",
      status: "failed",
      detail: "captcha_unavailable",
    });
    expect(ports.restricted).toEqual([]);
    expect(await challenges.get("local", "-100", "77")).toBeNull();
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(
      logger.entries.some((entry) => entry.message === "captcha_failed"),
    ).toBe(true);
  });

  it("does not captcha a join that is already being banned", async () => {
    const ports = moderator();
    const result = await action(clock).execute({
      event: joinEvent("join"),
      decision: {
        action: "ban",
        ruleIds: ["join_name"],
        score: 1,
        reasons: ["keyword_match"],
        evidence: [{ kind: "keyword", summary: "keyword:免费领取" }],
      },
      dryRun: false,
      moderator: ports,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(result).toEqual({
      actionId: "captcha",
      status: "skipped",
      detail: "superseded",
    });
    expect(ports.restricted).toEqual([]);
  });

  it("deletes the stored prompt when a join is banned instead", async () => {
    const challenges = store();
    const ports = moderator();
    const logger = createMemoryLogger();
    let nonces = 0;
    await challenges.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
      messageId: "42",
    });
    const result = await action(clock, challenges, () => {
      nonces += 1;
      return nonce;
    }).execute({
      event: joinEvent("join"),
      decision: {
        action: "ban",
        ruleIds: ["join_name"],
        score: 1,
        reasons: ["keyword_match"],
        evidence: [{ kind: "keyword", summary: "keyword:hit" }],
      },
      dryRun: false,
      moderator: ports,
      logger,
      signal: { aborted: false },
    });
    expect(result).toEqual({
      actionId: "captcha",
      status: "skipped",
      detail: "superseded",
    });
    expect(nonces).toBe(0);
    expect(ports.deleted).toEqual([
      { tenantId: "local", chatId: "-100", messageId: "42" },
    ]);
    expect(ports.restricted).toEqual([]);
    expect(await challenges.get("local", "-100", "77")).toBeNull();
    expect(JSON.stringify(logger.entries)).not.toContain("42");
    expect(JSON.stringify(logger.entries)).not.toContain("cd".repeat(8));
    expect(JSON.stringify(result)).not.toContain(nonce);
  });

  it("keeps the stored prompt when the banned join cannot delete it", async () => {
    const challenges = store();
    const ports = moderator();
    ports.deleteMessage = async () => {
      throw new Error(phrase);
    };
    const logger = createMemoryLogger();
    await challenges.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
      messageId: "42",
    });
    const result = await action(clock, challenges).execute({
      event: joinEvent("join"),
      decision: {
        action: "mute",
        ruleIds: ["join_name"],
        score: 1,
        reasons: ["keyword_match"],
        evidence: [],
      },
      dryRun: false,
      moderator: ports,
      logger,
      signal: { aborted: false },
    });
    expect(result).toEqual({
      actionId: "captcha",
      status: "skipped",
      detail: "superseded",
    });
    expect(await challenges.get("local", "-100", "77")).toMatchObject({
      messageId: "42",
    });
    expect(ports.restricted).toEqual([]);
    expect(logger.entries.map((entry) => entry.message)).toEqual([
      "captcha_prompt_delete_failed",
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain("42");
  });

  it("still skips captcha when the stored row cannot be dropped", async () => {
    const challenges = store();
    const logger = createMemoryLogger();
    await challenges.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
    });
    const result = await action(clock, {
      ...challenges,
      async delete() {
        throw new Error(phrase);
      },
    }).execute({
      event: joinEvent("join"),
      decision: {
        action: "ban",
        ruleIds: ["join_name"],
        score: 1,
        reasons: ["keyword_match"],
        evidence: [],
      },
      dryRun: false,
      moderator: moderator(),
      logger,
      signal: { aborted: false },
    });
    expect(result).toEqual({
      actionId: "captcha",
      status: "skipped",
      detail: "superseded",
    });
    expect(await challenges.get("local", "-100", "77")).toMatchObject({
      nonce: "cd".repeat(8),
    });
    expect(logger.entries.map((entry) => entry.message)).toEqual([
      "captcha_supersede_failed",
    ]);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain("cd".repeat(8));
  });

  it("keeps the stored prompt when a banned join is only a dry run", async () => {
    const challenges = store();
    const ports = moderator();
    await challenges.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
      messageId: "42",
    });
    const result = await action(clock, challenges).execute({
      event: joinEvent("join"),
      decision: {
        action: "delete",
        ruleIds: ["join_name"],
        score: 1,
        reasons: ["keyword_match"],
        evidence: [],
      },
      dryRun: true,
      moderator: ports,
      logger: createMemoryLogger(),
      signal: { aborted: false },
    });
    expect(result).toEqual({
      actionId: "captcha",
      status: "skipped",
      detail: "dry_run",
    });
    expect(ports.deleted).toEqual([]);
    expect(await challenges.get("local", "-100", "77")).toMatchObject({
      messageId: "42",
    });
  });

  it("does not restrict when a detector throws", async () => {
    const ports = moderator();
    const logger = createMemoryLogger();
    const throwing = defineDetector({
      id: "join",
      version: "0.1.0",
      capabilities: ["membership"],
      configSchema: z.strictObject({}),
      config: {},
      async detect() {
        throw new Error(phrase);
      },
    });
    const result = await runPipeline({
      event: joinEvent("join"),
      rules: parseRuleSet({
        version: 1,
        aggregate: "max",
        rules: [
          {
            id: "new_member",
            enabled: true,
            when: { eventKind: "chat_member" },
            detectorIds: ["join"],
            threshold: 1,
            actions: ["captcha"],
          },
        ],
      }),
      policy: defaultPrefilterPolicy,
      detectors: [throwing],
      actions: [action(clock)],
      storage: storage(),
      moderator: ports,
      logger,
    });
    expect(result.decision.action).toBe("allow");
    expect(ports.restricted).toEqual([]);
    expect(result.detectorErrors).toEqual([
      { detectorId: "join", code: "detector_failed" },
    ]);
    expect(JSON.stringify(result)).not.toContain(phrase);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });
});
