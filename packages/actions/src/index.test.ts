import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BanTarget,
  type DeleteTarget,
  type Event,
  type ModerationPort,
  type MuteTarget,
  parseEvent,
} from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  createBanAction,
  createDeleteAction,
  createMuteAction,
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
          async muteActor() {},
          async banActor() {},
          async restrictActor() {},
          async releaseActor() {},
        },
        logger: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
      });
      expect(result.status, fixture.name).toBe(fixture.status);
      expect(result.detail).toBe(fixture.detail);
      expect(deleted).toHaveLength(fixture.status === "executed" ? 1 : 0);
    }
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
    async muteActor(target) {
      muted.push(target);
    },
    async banActor(target) {
      banned.push(target);
    },
    async restrictActor() {},
    async releaseActor() {},
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
