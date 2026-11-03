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
    async listExpired() {
      return [];
    },
  };
}

function moderator(
  restrict?: (target: MuteTarget) => Promise<void>,
): ModerationPort & {
  restricted: MuteTarget[];
} {
  const restricted: MuteTarget[] = [];
  return {
    restricted,
    async deleteMessage() {},
    async muteActor() {},
    async banActor() {},
    async declineJoin() {},
    async restrictActor(target) {
      if (restrict) {
        await restrict(target);
        return;
      }
      restricted.push({ ...target });
    },
    async releaseActor() {},
  };
}

function storage(): Storage {
  return {
    async appendAudit() {},
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
