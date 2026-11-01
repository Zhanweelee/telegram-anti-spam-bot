import { describe, expect, it } from "vitest";
import {
  type BlocklistStore,
  createMemoryBlocklistStore,
} from "./blocklist.js";
import type { Cache } from "./cache.js";
import { runOperatorCommand } from "./command.js";
import { parseEvent } from "./event.js";
import { createMemoryLogger } from "./logger.js";
import { loadPolicy } from "./policy-load.js";
import type { PolicyStore } from "./policy-store.js";
import type { AuditRecord, Storage } from "./ports.js";
import { parseAuditRecord } from "./ports.js";
import { prefilterPolicySchema } from "./prefilter.js";
import { createMemoryReviewQueue, type ReviewQueue } from "./review.js";
import type { RuleSource } from "./rules-load.js";
import type { RuntimeStore } from "./runtime.js";

const phrase = "请免费领取礼品";

const rulesDoc = {
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
};

function cache(): Cache {
  const values = new Map<string, string>();
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

function policyStore(): PolicyStore & { puts: number; gets: number } {
  const values = new Map<string, string>();
  let puts = 0;
  let gets = 0;
  return {
    get puts() {
      return puts;
    },
    get gets() {
      return gets;
    },
    async get(tenantId, chatId) {
      gets += 1;
      const raw = values.get(`${tenantId}:${chatId}`);
      if (raw === undefined) {
        return null;
      }
      const parsed = prefilterPolicySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },
    async put(tenantId, chatId, policy) {
      puts += 1;
      values.set(`${tenantId}:${chatId}`, JSON.stringify(policy));
    },
  };
}

function runtime(): RuntimeStore & { readonly enabled: Map<string, boolean> } {
  const enabled = new Map<string, boolean>();
  return {
    enabled,
    async getDryRun(tenantId, chatId) {
      return enabled.get(`${tenantId}:${chatId}`) ?? false;
    },
    async setDryRun(tenantId, chatId, value) {
      enabled.set(`${tenantId}:${chatId}`, value);
    },
  };
}

function storage(): Storage & {
  readonly records: AuditRecord[];
  ruleWrites: number;
} {
  const records: AuditRecord[] = [];
  let ruleWrites = 0;
  return {
    records,
    get ruleWrites() {
      return ruleWrites;
    },
    async appendAudit(record) {
      records.push(parseAuditRecord(record));
    },
    async listAudits(query) {
      return records
        .filter(
          (record) =>
            record.tenantId === query.tenantId &&
            (query.chatId === undefined || record.chatId === query.chatId),
        )
        .slice(0, query.limit);
    },
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
    async exportAudits(scope) {
      return records.filter(
        (record) =>
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId),
      );
    },
    async deleteAudits(scope) {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (
          record &&
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId)
        ) {
          records.splice(index, 1);
        }
      }
    },
    async getRuleSet() {
      return null;
    },
    async putRuleSet() {
      ruleWrites += 1;
    },
  };
}

function source(): RuleSource {
  return {
    async loadChat() {
      return null;
    },
    async loadDefault() {
      return rulesDoc;
    },
  };
}

function event(input: {
  readonly text: string;
  readonly direct?: boolean;
  readonly actorId?: string;
  readonly chatId?: string;
}) {
  return parseEvent({
    id: "evt_cmd",
    tenantId: "local",
    chatId: input.chatId ?? "42",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: input.actorId ?? "42", isAdmin: false },
    ...(input.direct ? { direct: true } : {}),
    message: {
      id: "1",
      text: input.text,
      textSha256: "ab".repeat(32),
    },
  });
}

function kit() {
  return {
    cache: cache(),
    policyStore: policyStore(),
    runtime: runtime(),
    storage: storage(),
    source: source(),
    logger: createMemoryLogger(),
  };
}

describe("runOperatorCommand", () => {
  it("uses the English catalog when locale is en", async () => {
    const deps = kit();
    const denied = await runOperatorCommand({
      event: event({ text: "/help", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
    });
    expect(denied).toMatchObject({ text: "No permission" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text.startsWith("Commands:")).toBe(true);
    }
    const usage = await runOperatorCommand({
      event: event({ text: "/forget extra extra", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
    });
    expect(usage).toMatchObject({ text: "Usage: /forget [chatId]" });
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_en",
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: "keyword:spam" }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "Deleted 1" });
    expect(JSON.stringify(forgotten)).not.toContain(phrase);
  });

  it("does not change config for a group command", async () => {
    const deps = kit();
    const result = await runOperatorCommand({
      event: event({
        text: `/whitelist -100 add 9 ${phrase}`,
        chatId: "-100",
      }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result.status).toBe("skip");
    expect(deps.policyStore.puts).toBe(0);
    expect(deps.policyStore.gets).toBe(0);
  });

  it("denies a private command from someone who is not configured", async () => {
    const deps = kit();
    const result = await runOperatorCommand({
      event: event({
        text: `/whitelist -100 add 9 ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result).toMatchObject({ status: "reply", text: "没有权限" });
    expect(JSON.stringify(result)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(deps.policyStore.puts).toBe(0);
  });

  it("adds an allowlist id for a configured admin and refreshes the cache", async () => {
    const deps = kit();
    const added = await runOperatorCommand({
      event: event({ text: "/whitelist -100 add 9", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(added).toMatchObject({
      status: "reply",
      text: "whitelist -100\nexemptAdmins true\nallow 9",
    });
    const again = await runOperatorCommand({
      event: event({ text: "/whitelist -100 add 9", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(again).toMatchObject({ status: "reply" });
    expect(deps.policyStore.puts).toBe(1);
    const loaded = await loadPolicy({
      tenantId: "local",
      chatId: "-100",
      cache: deps.cache,
      store: deps.policyStore,
      logger: deps.logger,
      fallback: { exemptAdmins: true, allowActorIds: [] },
    });
    expect(loaded.allowActorIds).toEqual(["9"]);
    const other = await loadPolicy({
      tenantId: "local",
      chatId: "-200",
      cache: cache(),
      store: deps.policyStore,
      logger: deps.logger,
      fallback: { exemptAdmins: true, allowActorIds: [] },
    });
    expect(other.allowActorIds).toEqual([]);
  });

  it("removes an allowlist id", async () => {
    const deps = kit();
    await runOperatorCommand({
      event: event({ text: "/whitelist -100 add 9", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    const removed = await runOperatorCommand({
      event: event({ text: "/whitelist -100 remove 9", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(removed).toMatchObject({
      text: "whitelist -100\nexemptAdmins true\nallow none",
    });
  });

  it("rejects a non-numeric actor id without writing", async () => {
    const deps = kit();
    const result = await runOperatorCommand({
      event: event({ text: "/whitelist -100 add hello", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result).toMatchObject({ text: "参数无效" });
    expect(deps.policyStore.puts).toBe(0);
    expect(JSON.stringify(result)).not.toContain("hello");
  });

  it("shows rules and help without echoing extra text", async () => {
    const deps = kit();
    const rules = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(rules).toMatchObject({ status: "reply" });
    if (rules.status === "reply") {
      expect(rules.text).toContain("spam_keywords enabled threshold 1");
      expect(rules.text).not.toContain(phrase);
    }
    const help = await runOperatorCommand({
      event: event({ text: `/help@tasb_bot ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help).toMatchObject({ command: "help" });
    expect(JSON.stringify(help)).not.toContain(phrase);
  });

  it("lists audit fields and omits evidence text", async () => {
    const deps = kit();
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_1",
      action: "delete",
      score: 1,
      reasons: ["keyword_match", "x".repeat(81)],
      evidence: [{ kind: "keyword", summary: phrase }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    const result = await runOperatorCommand({
      event: event({ text: "/logs -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result.status).toBe("reply");
    if (result.status !== "reply") {
      return;
    }
    expect(result.text).toContain("evt_1 delete score 1");
    expect(result.text).toContain("keyword_match");
    expect(result.text).toContain("redacted");
    expect(result.text).not.toContain(phrase);
    expect(result.text).not.toContain('"text"');
  });

  it("turns dry-run on and off for one chat", async () => {
    const deps = kit();
    const on = await runOperatorCommand({
      event: event({ text: "/dryrun -100 on", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(on).toMatchObject({ text: "dry-run -100 on" });
    const shown = await runOperatorCommand({
      event: event({ text: "/dryrun -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(shown).toMatchObject({ text: "dry-run -100 on" });
    expect(await deps.runtime.getDryRun("local", "-200")).toBe(false);
    const off = await runOperatorCommand({
      event: event({ text: "/dryrun -100 off", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(off).toMatchObject({ text: "dry-run -100 off" });
  });

  it("returns usage and an empty log without writing", async () => {
    const deps = kit();
    deps.policyStore.put = async () => {
      throw new Error(phrase);
    };
    const failed = await runOperatorCommand({
      event: event({ text: "/whitelist -100 add 9", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(failed).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);

    const usage = await runOperatorCommand({
      event: event({ text: "/dryrun -100 maybe", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(usage.status).toBe("reply");
    if (usage.status === "reply") {
      expect(usage.text).toContain("/dryrun");
    }
    const empty = await runOperatorCommand({
      event: event({ text: "/logs -200", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(empty).toMatchObject({ text: "no audits" });

    const blank = await runOperatorCommand({
      event: event({ text: "   ", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(blank.status).toBe("skip");

    const rulesUsage = await runOperatorCommand({
      event: event({ text: "/rules -100 extra", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(rulesUsage).toMatchObject({ text: "用法：/rules [chatId]" });
    const badRules = await runOperatorCommand({
      event: event({ text: "/rules", direct: true, chatId: "abc" }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(badRules).toMatchObject({ text: "参数无效" });

    const none = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
      source: {
        async loadChat() {
          return {
            version: 1,
            aggregate: "max",
            rules: [
              {
                id: "quiet",
                enabled: false,
                detectorIds: ["keyword"],
                threshold: 1,
                actions: ["log"],
              },
            ],
          };
        },
        async loadDefault() {
          return { version: 1, aggregate: "max", rules: [] };
        },
      },
    });
    expect(none.status).toBe("reply");
    if (none.status === "reply") {
      expect(none.text).toContain("quiet disabled");
    }
    const emptyRules = await runOperatorCommand({
      event: event({ text: "/rules -300", direct: true }),
      adminActorIds: ["42"],
      ...deps,
      source: {
        async loadChat() {
          return null;
        },
        async loadDefault() {
          return { version: 1, aggregate: "max", rules: [] };
        },
      },
    });
    expect(emptyRules).toMatchObject({ text: "rules -300\nnone" });

    const whitelistUsage = await runOperatorCommand({
      event: event({ text: "/whitelist", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(whitelistUsage).toMatchObject({
      text: "用法：/whitelist <chatId> [add|remove <actorId>]",
    });
    const badWhitelist = await runOperatorCommand({
      event: event({ text: "/whitelist -100 nope", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(badWhitelist).toMatchObject({
      text: "用法：/whitelist <chatId> [add|remove <actorId>]",
    });
    expect(whitelistUsage.status).toBe("reply");
    const shown = await runOperatorCommand({
      event: event({ text: "/whitelist -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(shown).toMatchObject({
      text: "whitelist -100\nexemptAdmins true\nallow none",
    });

    const logUsage = await runOperatorCommand({
      event: event({ text: "/logs -100 extra", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(logUsage).toMatchObject({ text: "用法：/logs [chatId]" });
    const badLog = await runOperatorCommand({
      event: event({ text: "/logs hello", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(badLog).toMatchObject({ text: "参数无效" });
    const allLogs = await runOperatorCommand({
      event: event({ text: "/logs", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(allLogs).toMatchObject({ text: "no audits" });

    const dryUsage = await runOperatorCommand({
      event: event({ text: "/dryrun", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(dryUsage).toMatchObject({ text: "用法：/dryrun <chatId> [on|off]" });
  });

  it("skips private text that is not an operator command", async () => {
    const deps = kit();
    const result = await runOperatorCommand({
      event: event({ text: "/start", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result.status).toBe("skip");
  });

  it("exports one chat and forgets only that chat", async () => {
    const deps = kit();
    const audit = {
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_1",
      action: "delete" as const,
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword" as const, summary: "keyword:spam" }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    };
    await deps.storage.appendAudit(audit);
    await deps.storage.appendAudit({
      ...audit,
      chatId: "-200",
      eventId: "evt_2",
    });
    await deps.storage.appendAudit({
      ...audit,
      tenantId: "other",
      eventId: "evt_other",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: `/forget -100 ${phrase}`, chatId: "-100" }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(skipped.status).toBe("skip");
    expect(deps.storage.records).toHaveLength(3);
    const denied = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(denied).toMatchObject({ text: "没有权限" });
    expect(deps.storage.records).toHaveLength(3);
    const exported = await runOperatorCommand({
      event: event({ text: "/export -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(exported.status).toBe("reply");
    if (exported.status === "reply") {
      expect(JSON.parse(exported.text)).toEqual({
        tenantId: "local",
        chatId: "-100",
        audits: [audit],
      });
      expect(exported.text).not.toContain(phrase);
    }
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "已删除 1 条" });
    expect(
      await deps.storage.exportAudits({ tenantId: "local", chatId: "-100" }),
    ).toEqual([]);
    expect(await deps.storage.exportAudits({ tenantId: "local" })).toHaveLength(
      1,
    );
    expect(await deps.storage.exportAudits({ tenantId: "other" })).toHaveLength(
      1,
    );
  });

  it("keeps a long export out of the reply and forgets the tenant", async () => {
    const deps = kit();
    const usage = await runOperatorCommand({
      event: event({ text: "/export -100 extra", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(usage).toMatchObject({ text: "用法：/export [chatId]" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/forget ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const empty = await runOperatorCommand({
      event: event({ text: "/export", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(empty).toMatchObject({
      text: '{"tenantId":"local","audits":[]}',
    });
    const audit = {
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_0",
      action: "delete" as const,
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword" as const, summary: "keyword:spam" }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    };
    for (let index = 0; index < 20; index += 1) {
      await deps.storage.appendAudit({ ...audit, eventId: `evt_${index}` });
    }
    const longExport = await runOperatorCommand({
      event: event({ text: "/export -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(longExport).toMatchObject({ text: "导出 20 条，超过私聊长度" });
    expect(JSON.stringify(longExport)).not.toContain(phrase);
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "已删除 20 条" });
    expect(deps.storage.records).toEqual([]);
    const again = await runOperatorCommand({
      event: event({ text: "/forget", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(again).toMatchObject({ text: "已删除 0 条" });
  });

  it("hides storage failures from export and forget", async () => {
    const deps = kit();
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_1",
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: "keyword:spam" }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    deps.storage.exportAudits = () => Promise.reject(new Error(phrase));
    const exported = await runOperatorCommand({
      event: event({ text: "/export", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(exported).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    deps.storage.exportAudits = async () => deps.storage.records;
    deps.storage.deleteAudits = () => Promise.reject(new Error(phrase));
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "参数无效" });
    expect(deps.storage.records).toHaveLength(1);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("leaves the shared blocklist unread until a chat opts in", async () => {
    const deps = kit();
    const blocklist = createMemoryBlocklistStore();
    let reads = 0;
    const wrapped = countingStore(blocklist, () => {
      reads += 1;
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/blocklist -100 on", chatId: "-100" }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(skipped.status).toBe("skip");
    expect(reads).toBe(0);
    expect(await blocklist.isEnabled("local", "-100")).toBe(false);

    const denied = await runOperatorCommand({
      event: event({
        text: `/blocklist -100 on ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(denied).toMatchObject({ text: "没有权限" });
    expect(await blocklist.isEnabled("local", "-100")).toBe(false);
    expect(JSON.stringify(denied)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/blocklist -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    expect(reads).toBe(0);

    const off = await runOperatorCommand({
      event: event({ text: "/blocklist -100", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(off).toMatchObject({ text: "blocklist -100 off" });
    expect(reads).toBe(0);

    const added = await runOperatorCommand({
      event: event({ text: "/blocklist -100 add actor 9", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(added).toMatchObject({ text: "blocklist -100 off\nadded" });
    expect(await blocklist.has("local", { kind: "actor", value: "9" })).toBe(
      true,
    );
    expect(reads).toBe(0);

    const hash = "ab".repeat(32);
    const hashed = await runOperatorCommand({
      event: event({
        text: `/blocklist -100 add hash ${hash.toUpperCase()}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(hashed).toMatchObject({ text: "blocklist -100 off\nadded" });
    expect(JSON.stringify(hashed)).not.toContain(hash);
    expect(await blocklist.has("local", { kind: "hash", value: hash })).toBe(
      true,
    );

    const turnedOn = await runOperatorCommand({
      event: event({ text: "/blocklist -100 on", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(turnedOn).toMatchObject({ text: "blocklist -100 on" });
    const turnedOff = await runOperatorCommand({
      event: event({ text: "/blocklist -100 off", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(turnedOff).toMatchObject({ text: "blocklist -100 off" });
    expect(await blocklist.isEnabled("local", "-100")).toBe(false);
    expect(await blocklist.has("local", { kind: "actor", value: "9" })).toBe(
      true,
    );
  });

  it("rejects raw text and a missing or full blocklist without echoing it", async () => {
    const deps = kit();
    const blocklist = createMemoryBlocklistStore();
    const raw = await runOperatorCommand({
      event: event({
        text: `/blocklist -100 add actor ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(raw).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(raw)).not.toContain(phrase);
    expect(JSON.stringify(blocklist.snapshot())).not.toContain(phrase);

    const spaced = await runOperatorCommand({
      event: event({
        text: "/blocklist -100 add actor hello world",
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(spaced).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");

    const usage = await runOperatorCommand({
      event: event({ text: "/blocklist", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(usage).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
    });
    const badChat = await runOperatorCommand({
      event: event({ text: "/blocklist abc", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(badChat).toMatchObject({ text: "参数无效" });
    const badOp = await runOperatorCommand({
      event: event({ text: "/blocklist -100 maybe", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(badOp).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
    });

    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/blocklist");
    }

    const failing = failingStore(phrase);
    const failed = await runOperatorCommand({
      event: event({ text: "/blocklist -100 on", direct: true }),
      adminActorIds: ["42"],
      blocklist: failing,
      ...deps,
    });
    expect(failed).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const unread = await runOperatorCommand({
      event: event({ text: "/blocklist -100", direct: true }),
      adminActorIds: ["42"],
      blocklist: failing,
      ...deps,
    });
    expect(unread).toMatchObject({ text: "参数无效" });
    expect(failing.reads).toBe(0);

    const extra = await runOperatorCommand({
      event: event({ text: "/blocklist -100 on extra", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(extra).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
    });
    const wrongKind = await runOperatorCommand({
      event: event({ text: "/blocklist -100 add note 9", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(wrongKind).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
    });

    const addedThenUnreadable = createMemoryBlocklistStore();
    const hide: BlocklistStore = {
      isEnabled() {
        return Promise.reject(new Error(phrase));
      },
      setEnabled: (tenantId, chatId, enabled) =>
        addedThenUnreadable.setEnabled(tenantId, chatId, enabled),
      add: (tenantId, entry) => addedThenUnreadable.add(tenantId, entry),
      has: (tenantId, entry) => addedThenUnreadable.has(tenantId, entry),
    };
    const hidden = await runOperatorCommand({
      event: event({ text: "/blocklist -100 add actor 9", direct: true }),
      adminActorIds: ["42"],
      blocklist: hide,
      ...deps,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(
      await addedThenUnreadable.has("local", { kind: "actor", value: "9" }),
    ).toBe(true);
    const addFails: BlocklistStore = {
      async isEnabled() {
        return false;
      },
      async setEnabled() {
        return undefined;
      },
      async has() {
        return false;
      },
      async add() {
        throw new Error(phrase);
      },
    };
    const rejectedAdd = await runOperatorCommand({
      event: event({ text: "/blocklist -100 add actor 9", direct: true }),
      adminActorIds: ["42"],
      blocklist: addFails,
      ...deps,
    });
    expect(rejectedAdd).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);

    const hiddenOn = await runOperatorCommand({
      event: event({ text: "/blocklist -100 on", direct: true }),
      adminActorIds: ["42"],
      blocklist: hide,
      ...deps,
    });
    expect(hiddenOn).toMatchObject({ text: "参数无效" });
    expect(await addedThenUnreadable.isEnabled("local", "-100")).toBe(true);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("queues a false positive without the message or a rule change", async () => {
    const deps = kit();
    const review = createMemoryReviewQueue();
    const summary = phrase;
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "tg_9",
      textSha256: "cd".repeat(32),
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const marked = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(marked).toMatchObject({
      command: "appeal",
      text: "appeal -100 tg_9 误判",
    });
    const queued = await review.list({ tenantId: "local" });
    expect(queued).toEqual([
      {
        tenantId: "local",
        chatId: "-100",
        eventId: "tg_9",
        label: "false_positive",
        textSha256: "cd".repeat(32),
        action: "delete",
        score: 1,
        reasons: ["keyword_match"],
        ruleIds: ["spam_keywords"],
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(queued)).not.toContain(summary);
    expect(deps.storage.ruleWrites).toBe(0);
    expect(await deps.storage.getRuleSet("local", "-100")).toBeNull();
    const again = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 confirm", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(again).toMatchObject({ text: "appeal -100 tg_9 确认" });
    expect(await review.list({ tenantId: "local" })).toHaveLength(1);
    expect((await review.list({ tenantId: "local" }))[0]?.label).toBe(
      "confirmed",
    );
    await deps.storage.deleteAudits({ tenantId: "local", chatId: "-100" });
    expect(await review.list({ tenantId: "local" })).toHaveLength(1);
    const english = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      review,
      ...deps,
    });
    expect(english).toMatchObject({ text: "No audit" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(summary);
  });

  it("does not enqueue when the audit is missing or the caller is not an admin", async () => {
    const deps = kit();
    const review = createMemoryReviewQueue();
    const missing = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(missing).toMatchObject({ text: "没有这条审计" });
    const denied = await runOperatorCommand({
      event: event({
        text: `/appeal -100 tg_9 false ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(denied).toMatchObject({ text: "没有权限" });
    const group = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", chatId: "-100" }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(group).toEqual({ status: "skip" });
    const sentence = await runOperatorCommand({
      event: event({ text: `/appeal -100 ${phrase} false`, direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(sentence).toMatchObject({ text: "参数无效" });
    const bare = await runOperatorCommand({
      event: event({ text: "/appeal", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(bare).toMatchObject({
      text: "用法：/appeal <chatId> <eventId> false|confirm",
    });
    const usage = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 maybe", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(usage).toMatchObject({
      text: "用法：/appeal <chatId> <eventId> false|confirm",
    });
    expect(await review.list({ tenantId: "local" })).toEqual([]);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("rejects a missing or failing review queue without the error text", async () => {
    const deps = kit();
    await deps.storage.appendAudit(appealAudit());
    const absent = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(absent).toMatchObject({ text: "参数无效" });
    const failing: ReviewQueue = {
      async enqueue() {
        throw new Error(phrase);
      },
      async list() {
        return [];
      },
    };
    const rejected = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 confirm", direct: true }),
      adminActorIds: ["42"],
      review: failing,
      ...deps,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    deps.storage.getAudit = () => Promise.reject(new Error(phrase));
    const unreadable = await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", direct: true }),
      adminActorIds: ["42"],
      review: createMemoryReviewQueue(),
      ...deps,
    });
    expect(unreadable).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("exports appeals as eval cases without message text", async () => {
    const deps = kit();
    const review = createMemoryReviewQueue();
    await deps.storage.appendAudit({
      ...appealAudit(),
      textSha256: "ab".repeat(32),
      evidence: [{ kind: "keyword", summary: phrase }],
    });
    await deps.storage.appendAudit({
      ...appealAudit(),
      chatId: "-200",
      eventId: "tg_10",
      evidence: [{ kind: "keyword", summary: phrase }],
    });
    await runOperatorCommand({
      event: event({ text: "/appeal -100 tg_9 false", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    await runOperatorCommand({
      event: event({ text: "/appeal -200 tg_10 confirm", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    const usage = await runOperatorCommand({
      event: event({ text: "/evals -100 extra", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(usage).toMatchObject({ text: "用法：/evals [chatId]" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/evals ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const skipped = await runOperatorCommand({
      event: event({ text: "/evals -100", chatId: "-100" }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(skipped.status).toBe("skip");
    const denied = await runOperatorCommand({
      event: event({ text: "/evals", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(denied).toMatchObject({ text: "没有权限" });
    const exported = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(exported.status).toBe("reply");
    if (exported.status === "reply") {
      expect(JSON.parse(exported.text)).toEqual({
        tenantId: "local",
        chatId: "-100",
        cases: [
          {
            id: "tg_9",
            chatId: "-100",
            label: "ham",
            textSha256: "ab".repeat(32),
            action: "delete",
            score: 1,
            reasons: ["keyword_match"],
            ruleIds: ["spam_keywords"],
          },
        ],
      });
      expect(exported.text).not.toContain(phrase);
      expect(exported.text).not.toContain('"text"');
    }
    const all = await runOperatorCommand({
      event: event({ text: "/evals", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(all.status).toBe("reply");
    if (all.status === "reply") {
      const doc = JSON.parse(all.text) as {
        cases: { id: string; label: string }[];
      };
      expect(doc.cases.map((item) => [item.id, item.label])).toEqual([
        ["tg_10", "spam"],
        ["tg_9", "ham"],
      ]);
      expect(all.text).not.toContain(phrase);
    }
    expect(deps.storage.ruleWrites).toBe(0);
    const english = await runOperatorCommand({
      event: event({ text: "/evals extra extra", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      review,
      ...deps,
    });
    expect(english).toMatchObject({ text: "Usage: /evals [chatId]" });
  });

  it("hides a missing queue and a long eval export", async () => {
    const deps = kit();
    const missing = await runOperatorCommand({
      event: event({ text: "/evals", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(missing).toMatchObject({ command: "evals", text: "参数无效" });
    expect(
      deps.logger.entries.some(
        (entry) =>
          entry.message === "operator_rejected" &&
          entry.fields.command === "evals",
      ),
    ).toBe(true);
    const broken = createMemoryReviewQueue();
    broken.list = () => Promise.reject(new Error(phrase));
    const failed = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      review: broken,
      ...deps,
    });
    expect(failed).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const review = createMemoryReviewQueue();
    for (let index = 0; index < 40; index += 1) {
      await review.enqueue({
        tenantId: "local",
        chatId: "-100",
        eventId: `evt_${index}`,
        label: "confirmed",
        textSha256: "cd".repeat(32),
        action: "delete",
        score: 1,
        reasons: ["keyword_match"],
        ruleIds: ["spam_keywords"],
        createdAt: "2026-11-01T00:00:00.000Z",
      });
    }
    const longExport = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(longExport).toMatchObject({ text: "评测样本 40 条，超过私聊长度" });
    expect(JSON.stringify(longExport)).not.toContain(phrase);
    const english = await runOperatorCommand({
      event: event({ text: "/evals", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      review,
      ...deps,
    });
    expect(english).toMatchObject({
      text: "40 cases, longer than a private message",
    });
  });
});

function appealAudit(): AuditRecord {
  return {
    tenantId: "local",
    chatId: "-100",
    eventId: "tg_9",
    action: "delete",
    score: 1,
    reasons: ["keyword_match"],
    evidence: [],
    ruleIds: ["spam_keywords"],
    createdAt: "2026-11-01T00:00:00.000Z",
  };
}

function countingStore(
  inner: ReturnType<typeof createMemoryBlocklistStore>,
  onRead: () => void,
): BlocklistStore {
  return {
    isEnabled: (tenantId, chatId) => inner.isEnabled(tenantId, chatId),
    setEnabled: (tenantId, chatId, enabled) =>
      inner.setEnabled(tenantId, chatId, enabled),
    add: (tenantId, entry) => inner.add(tenantId, entry),
    async has(tenantId, entry) {
      onRead();
      return inner.has(tenantId, entry);
    },
  };
}

function failingStore(phrase: string): BlocklistStore & { reads: number } {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async isEnabled() {
      throw new Error(phrase);
    },
    async setEnabled() {
      throw new Error(phrase);
    },
    async has() {
      reads += 1;
      throw new Error(phrase);
    },
    async add() {
      throw new Error(phrase);
    },
  };
}
