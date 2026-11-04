import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFixedClock } from "./clock.js";
import type { DetectorHit } from "./decision.js";
import { PipelineConfigError } from "./errors.js";
import { type Event, parseEvent } from "./event.js";
import { createMemoryLogger } from "./logger.js";
import { runPipeline } from "./pipeline.js";
import {
  type Action,
  type Detector,
  defineAction,
  defineDetector,
} from "./plugin.js";
import {
  type AuditRecord,
  type DeleteTarget,
  type ModerationPort,
  parseAuditRecord,
  type Storage,
} from "./ports.js";
import { parseRuleSet, type RuleSet } from "./rule.js";

const HASH = "a".repeat(64);

function event(overrides: Record<string, unknown> = {}): Event {
  return parseEvent({
    id: "evt_1",
    tenantId: "tenant_1",
    chatId: "chat_1",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00Z",
    actor: { id: "user_1", isAdmin: false },
    message: { id: "msg_1", text: "点击免费领取", textSha256: HASH },
    ...overrides,
  });
}

function rules(overrides: Record<string, unknown> = {}): RuleSet {
  return parseRuleSet({
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
    ...overrides,
  });
}

function detector(id: string, detect: Detector["detect"]): Detector {
  return defineDetector({
    id,
    version: "0.1.0",
    capabilities: ["test"],
    configSchema: z.strictObject({}),
    config: {},
    detect,
  });
}

function hit(id: string, score = 1): DetectorHit {
  return {
    detectorId: id,
    score,
    reasons: ["keyword_match"],
    evidence: [{ kind: "keyword", summary: "keyword:spam" }],
  };
}

function action(id: string, execute: Action["execute"]): Action {
  return defineAction({
    id,
    version: "0.1.0",
    capabilities: ["test"],
    configSchema: z.strictObject({}),
    config: {},
    execute,
  });
}

function harness(options?: { failStorage?: boolean }) {
  const records: AuditRecord[] = [];
  const deleted: DeleteTarget[] = [];
  const storage: Storage = {
    async putAuditsIfAbsent() {},
    async appendAudit(record) {
      records.push(record);
    },
    async claimAudit(record) {
      if (options?.failStorage) {
        throw new Error("请免费领取礼品");
      }
      const parsed = parseAuditRecord(record);
      const exists = records.some(
        (item) =>
          item.tenantId === parsed.tenantId &&
          item.chatId === parsed.chatId &&
          item.eventId === parsed.eventId,
      );
      if (exists) {
        return false;
      }
      records.push(parsed);
      return true;
    },
    async listAudits(query) {
      return records.slice(0, query.limit);
    },
    async getRuleSet() {
      return null;
    },
    async putRuleSet() {},
    async getAudit(tenantId, chatId, eventId) {
      return (
        records.find(
          (record) =>
            record.tenantId === tenantId &&
            record.chatId === chatId &&
            record.eventId === eventId,
        ) ?? null
      );
    },
    async exportAudits() {
      return records.slice();
    },
    async countAudits() {
      return records.length;
    },
    async deleteAudits() {
      const removed = records.length;
      records.splice(0, records.length);
      return removed;
    },
  };
  const moderator: ModerationPort = {
    async deleteMessage(target) {
      deleted.push(target);
    },
    async deleteMessages() {},
    async muteActor() {},
    async banActor() {},
    async banSenderChat() {},
    async unbanSenderChat() {},
    async approveJoin() {},
    async declineJoin() {},
    async deferJoin() {},
    async restrictActor() {},
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
    async clearReactions() {},
    async revokeInvite() {},
    async unpinChat() {},
    async pinMessage() {},
    async unpinMessage() {},
    async removeReaction() {},
    async deletePhoto() {},
    async leaveChat() {},
    async setMemberTag() {},
    async unpinTopic() {},
    async closeTopic() {},
    async openTopic() {},
    async hideGeneral() {},
    async showGeneral() {},
    async deleteTopic() {},
  };
  return {
    records,
    deleted,
    storage,
    moderator,
    logger: createMemoryLogger(),
    clock: createFixedClock("2026-11-01T00:00:00Z"),
  };
}

describe("runPipeline", () => {
  it("deletes on a detector hit and stores only the hash", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: true, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async (ctx) => {
          await ctx.moderator.deleteMessage({
            tenantId: ctx.event.tenantId,
            chatId: ctx.event.chatId,
            messageId: ctx.event.message?.id ?? "missing",
          });
          return { actionId: "delete", status: "executed" };
        }),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      clock: kit.clock,
    });

    expect(result.decision.action).toBe("delete");
    expect(kit.deleted).toEqual([
      { tenantId: "tenant_1", chatId: "chat_1", messageId: "msg_1" },
    ]);
    expect(JSON.stringify(kit.records)).not.toContain("点击免费领取");
    expect(JSON.stringify(kit.records)).toContain(HASH);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("点击免费领取");
  });

  it("does not run detectors for admins or the allowlist", async () => {
    let calls = 0;
    const see = detector("keyword", async () => {
      calls += 1;
      return hit("keyword");
    });
    const admin = harness();
    const adminResult = await runPipeline({
      event: event({ actor: { id: "admin_1", isAdmin: true } }),
      rules: rules(),
      policy: { exemptAdmins: true, allowActorIds: ["admin_1"] },
      detectors: [see],
      actions: [],
      storage: admin.storage,
      moderator: admin.moderator,
      logger: admin.logger,
    });
    expect(adminResult.outcome).toBe("exempt");
    expect(adminResult.exemptReason).toBe("admin");
    expect(calls).toBe(0);

    const allowed = harness();
    const allowedResult = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: true, allowActorIds: ["user_1"] },
      detectors: [see],
      actions: [],
      storage: allowed.storage,
      moderator: allowed.moderator,
      logger: allowed.logger,
    });
    expect(allowedResult.exemptReason).toBe("allowlist");
    expect(calls).toBe(0);
  });

  it("skips actions and audit in dry-run", async () => {
    const kit = harness();
    let called = false;
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => {
          called = true;
          return { actionId: "delete", status: "executed" };
        }),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      dryRun: true,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.actionResults).toEqual([
      { actionId: "delete", status: "skipped", detail: "dry_run" },
    ]);
    expect(called).toBe(false);
    expect(kit.records).toHaveLength(0);
  });

  it("skips actions when this event already has an audit", async () => {
    const kit = harness();
    let called = 0;
    const input = {
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => {
          called += 1;
          return { actionId: "delete", status: "executed" as const };
        }),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      clock: kit.clock,
    };
    const first = await runPipeline(input);
    const second = await runPipeline(input);
    expect(first.actionResults).toEqual([
      { actionId: "delete", status: "executed" },
    ]);
    expect(second.decision.action).toBe("delete");
    expect(second.actionResults).toEqual([
      { actionId: "delete", status: "skipped", detail: "duplicate" },
    ]);
    expect(called).toBe(1);
    expect(kit.records).toHaveLength(1);
    expect(
      kit.logger.entries.some((entry) => entry.message === "audit_duplicate"),
    ).toBe(true);
    expect(
      kit.logger.entries.some(
        (entry) =>
          entry.message === "pipeline_completed" &&
          entry.fields.duplicate === true,
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("点击免费领取");
  });

  it("writes the audit before the action runs", async () => {
    const kit = harness();
    let stored = false;
    await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => {
          stored =
            (await kit.storage.getAudit("tenant_1", "chat_1", "evt_1")) !==
            null;
          return { actionId: "delete", status: "executed" };
        }),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      clock: kit.clock,
    });
    expect(stored).toBe(true);
    expect(kit.records).toHaveLength(1);
  });

  it("still punishes when the audit claim fails", async () => {
    const kit = harness();
    const phrase = "请免费领取礼品";
    let called = 0;
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => {
          called += 1;
          return { actionId: "delete", status: "executed" as const };
        }),
      ],
      storage: {
        ...kit.storage,
        async claimAudit() {
          throw new Error(phrase);
        },
      },
      moderator: kit.moderator,
      logger: kit.logger,
      clock: kit.clock,
    });
    expect(result.actionResults).toEqual([
      { actionId: "delete", status: "executed" },
    ]);
    expect(called).toBe(1);
    expect(kit.records).toHaveLength(0);
    expect(
      kit.logger.entries.some(
        (entry) =>
          entry.message === "audit_claim_failed" &&
          entry.fields.code === "storage_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("does not claim an audit for an allow decision", async () => {
    const kit = harness();
    let lookups = 0;
    await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => null)],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: {
        ...kit.storage,
        async claimAudit(record) {
          lookups += 1;
          return kit.storage.claimAudit(record);
        },
      },
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(lookups).toBe(0);
    expect(kit.records).toHaveLength(0);
  });

  it("fails open when a detector throws and fails closed when configured", async () => {
    const openKit = harness();
    const openResult = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [
        detector("keyword", async () => {
          throw new Error("点击免费领取");
        }),
      ],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: openKit.storage,
      moderator: openKit.moderator,
      logger: openKit.logger,
    });
    expect(openResult.decision.action).toBe("allow");
    expect(openResult.detectorErrors).toEqual([
      { detectorId: "keyword", code: "detector_failed" },
    ]);
    expect(JSON.stringify(openKit.logger.entries)).not.toContain(
      "点击免费领取",
    );
    expect(
      openKit.logger.entries.some(
        (item) =>
          item.message === "detector_error" &&
          item.fields.tenantId === "tenant_1" &&
          item.fields.chatId === "chat_1",
      ),
    ).toBe(true);

    const closedKit = harness();
    const closedResult = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [
        detector("keyword", async () => {
          throw new Error("boom");
        }),
      ],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: closedKit.storage,
      moderator: closedKit.moderator,
      logger: closedKit.logger,
      failureMode: "closed",
    });
    expect(closedResult.decision.action).toBe("delete");
    expect(closedResult.decision.reasons).toEqual(["detector_failed"]);
    expect(closedKit.records).toHaveLength(1);
  });

  it("times out a hung detector without blocking the decision", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", () => new Promise(() => {}))],
      actions: [],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      detectorTimeoutMs: 15,
    });
    expect(result.detectorErrors[0]?.code).toBe("detector_timeout");
    expect(result.decision.action).toBe("allow");
  });

  it("rejects invalid hits and keeps a sibling detector", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: parseRuleSet({
        version: 1,
        aggregate: "max",
        rules: [
          {
            id: "spam_keywords",
            enabled: true,
            detectorIds: ["broken", "keyword"],
            threshold: 1,
            actions: ["delete"],
          },
        ],
      }),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [
        detector("broken", async () => ({ ...hit("broken"), score: 2 })),
        detector("keyword", async () => hit("keyword")),
      ],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.detectorErrors.map((item) => item.code)).toEqual([
      "detector_invalid_hit",
    ]);
    expect(result.decision.action).toBe("delete");
  });

  it("aggregates with max and sum", async () => {
    const low = parseRuleSet({
      version: 1,
      aggregate: "max",
      rules: [
        {
          id: "soft",
          enabled: true,
          detectorIds: ["alpha", "beta"],
          threshold: 0.7,
          actions: ["log"],
        },
      ],
    });
    const base = {
      event: event(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [
        detector("alpha", async () => hit("alpha", 0.4)),
        detector("beta", async () => hit("beta", 0.4)),
      ],
      actions: [
        action("log", async () => ({ actionId: "log", status: "executed" })),
      ],
    };
    const maxKit = harness();
    const maxResult = await runPipeline({
      ...base,
      rules: low,
      storage: maxKit.storage,
      moderator: maxKit.moderator,
      logger: maxKit.logger,
    });
    expect(maxResult.decision.action).toBe("allow");

    const sumKit = harness();
    const sumResult = await runPipeline({
      ...base,
      rules: parseRuleSet({ ...low, aggregate: "sum" }),
      storage: sumKit.storage,
      moderator: sumKit.moderator,
      logger: sumKit.logger,
    });
    expect(sumResult.decision.action).toBe("log");
    expect(sumResult.decision.score).toBeCloseTo(0.8);
  });

  it("ignores disabled rules and unmatched conditions", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: parseRuleSet({
        version: 1,
        aggregate: "max",
        rules: [
          {
            id: "off",
            enabled: false,
            detectorIds: ["keyword"],
            threshold: 1,
            actions: ["ban"],
          },
          {
            id: "joins_only",
            enabled: true,
            when: { eventKind: "chat_member" },
            detectorIds: ["keyword"],
            threshold: 1,
            actions: ["ban"],
          },
        ],
      }),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("ban", async () => ({ actionId: "ban", status: "executed" })),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.decision.action).toBe("allow");
    expect(result.hits).toHaveLength(0);
  });

  it("picks the most severe action and reports a missing plugin", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: parseRuleSet({
        version: 1,
        aggregate: "max",
        rules: [
          {
            id: "note",
            enabled: true,
            detectorIds: ["keyword"],
            threshold: 1,
            actions: ["log"],
          },
          {
            id: "drop",
            enabled: true,
            detectorIds: ["keyword"],
            threshold: 1,
            actions: ["ban", "delete"],
          },
        ],
      }),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("log", async () => ({ actionId: "log", status: "executed" })),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.decision.action).toBe("ban");
    expect(result.actionResults.map((item) => item.actionId)).toEqual([
      "log",
      "ban",
      "delete",
    ]);
    expect(result.actionResults[1]).toMatchObject({
      status: "failed",
      detail: "missing_action",
    });
  });

  it("records action and storage failures without dropping the decision", async () => {
    const kit = harness({ failStorage: true });
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => {
          throw new Error("telegram down");
        }),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.decision.action).toBe("delete");
    expect(result.actionResults[0]).toMatchObject({
      status: "failed",
      detail: "action_failed",
    });
    expect(
      kit.logger.entries.some(
        (entry) =>
          entry.message === "audit_claim_failed" &&
          entry.fields.code === "storage_failed",
      ),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("请免费领取礼品");
  });

  it("redacts evidence that copies the message body", async () => {
    const kit = harness();
    const raw = "点击免费领取";
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [
        detector("keyword", async () => ({
          detectorId: "keyword",
          score: 1,
          reasons: [raw],
          evidence: [{ kind: "keyword", summary: raw }],
        })),
      ],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.decision.reasons).toEqual(["redacted"]);
    expect(result.decision.evidence[0]?.summary).toBe("redacted");
    expect(JSON.stringify(kit.records)).not.toContain(raw);
  });

  it("treats a null detector result as no signal", async () => {
    const kit = harness();
    let aborted = true;
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [
        detector("keyword", async (ctx) => {
          aborted = ctx.signal.aborted;
          return null;
        }),
      ],
      actions: [],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.hits).toHaveLength(0);
    expect(result.decision.action).toBe("allow");
    expect(aborted).toBe(false);
    expect(kit.records).toHaveLength(0);
  });

  it("warns when a rule names a detector that is not registered", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [],
      actions: [],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.decision.action).toBe("allow");
    expect(
      kit.logger.entries.some((entry) => entry.message === "missing_detector"),
    ).toBe(true);
  });

  it("rejects duplicate plugins, bad timeouts, and bad events", async () => {
    const kit = harness();
    const shared = {
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      actions: [] as Action[],
    };
    const one = detector("keyword", async () => null);
    await expect(
      runPipeline({ ...shared, detectors: [one, one] }),
    ).rejects.toBeInstanceOf(PipelineConfigError);
    const deleteAction = action("delete", async () => ({
      actionId: "delete",
      status: "executed",
    }));
    await expect(
      runPipeline({
        ...shared,
        detectors: [],
        actions: [deleteAction, deleteAction],
      }),
    ).rejects.toBeInstanceOf(PipelineConfigError);
    await expect(
      runPipeline({ ...shared, detectors: [], detectorTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(PipelineConfigError);
    await expect(
      runPipeline({ ...shared, detectors: [], event: { ...event(), id: "" } }),
    ).rejects.toThrow();
  });

  it("treats a hit from the wrong detector id as invalid", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("other"))],
      actions: [],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      failureMode: "closed",
    });
    expect(result.detectorErrors[0]?.code).toBe("detector_invalid_hit");
    expect(result.decision.action).toBe("delete");
  });

  it("uses the system clock when none is injected", async () => {
    const kit = harness();
    const result = await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
    });
    expect(result.decision.action).toBe("delete");
    expect(kit.records[0]).toMatchObject({
      createdAt: expect.stringMatching(/Z$/),
    });
  });

  it("records storage_failed when the clock is not ISO", async () => {
    const kit = harness();
    await runPipeline({
      event: event(),
      rules: rules(),
      policy: { exemptAdmins: false, allowActorIds: [] },
      detectors: [detector("keyword", async () => hit("keyword"))],
      actions: [
        action("delete", async () => ({
          actionId: "delete",
          status: "executed",
        })),
      ],
      storage: kit.storage,
      moderator: kit.moderator,
      logger: kit.logger,
      clock: { nowIso: () => "yesterday" },
    });
    expect(
      kit.logger.entries.some(
        (entry) => entry.fields.code === "storage_failed",
      ),
    ).toBe(true);
  });
});
