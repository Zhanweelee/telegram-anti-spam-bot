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
import {
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  type RulePackSource,
} from "./rule-pack.js";
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
  const ruleSwitches = new Map<string, Map<string, boolean>>();
  return {
    enabled,
    async getDryRun(tenantId, chatId) {
      return enabled.get(`${tenantId}:${chatId}`) ?? false;
    },
    async setDryRun(tenantId, chatId, value) {
      enabled.set(`${tenantId}:${chatId}`, value);
    },
    async listRuleSwitches(tenantId, chatId) {
      const saved = ruleSwitches.get(`${tenantId}:${chatId}`);
      if (!saved) {
        return [];
      }
      return [...saved.entries()].map(([ruleId, flag]) => ({
        ruleId,
        enabled: flag,
      }));
    },
    async setRuleSwitch(tenantId, chatId, ruleId, flag) {
      const id = `${tenantId}:${chatId}`;
      let saved = ruleSwitches.get(id);
      if (!saved) {
        saved = new Map();
        ruleSwitches.set(id, saved);
      }
      saved.set(ruleId, flag);
      return true;
    },
    async clearRuleSwitch(tenantId, chatId, ruleId) {
      ruleSwitches.get(`${tenantId}:${chatId}`)?.delete(ruleId);
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
    async claimAudit(record) {
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
      const matched = records.filter(
        (record) =>
          record.tenantId === query.tenantId &&
          (query.chatId === undefined || record.chatId === query.chatId),
      );
      return matched.slice(Math.max(0, matched.length - query.limit));
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
    async putAuditsIfAbsent() {},
    async exportAudits(scope) {
      return records.filter(
        (record) =>
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId),
      );
    },
    async countAudits(scope) {
      return records.filter(
        (record) =>
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId),
      ).length;
    },
    async deleteAudits(scope) {
      let removed = 0;
      for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        if (
          record &&
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId)
        ) {
          records.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
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

  it("fits a long allowlist without cutting an id", async () => {
    const deps = kit();
    const ids = Array.from({ length: 200 }, (_, index) =>
      String(10n ** 19n + BigInt(index)),
    );
    await deps.policyStore.put("local", "-100", {
      exemptAdmins: true,
      allowActorIds: ids,
    });
    const shown = await runOperatorCommand({
      event: event({ text: "/whitelist -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(shown.status).toBe("reply");
    if (shown.status !== "reply") {
      return;
    }
    expect(shown.text.length).toBeLessThanOrEqual(3500);
    const lines = shown.text.split("\n");
    expect(lines[0]).toBe("whitelist -100");
    expect(lines[1]).toBe("exemptAdmins true");
    const listed = lines[2]?.slice("allow ".length).split(",") ?? [];
    const omitted = Number(/^还有 (\d+) 个$/.exec(lines[3] ?? "")?.[1]);
    expect(listed.length + omitted).toBe(200);
    expect(listed).toEqual(ids.slice(0, listed.length));
    expect(shown.text).not.toContain(ids[199]);
    const english = await runOperatorCommand({
      event: event({ text: "/whitelist -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
    });
    expect(english.status).toBe("reply");
    if (english.status !== "reply") {
      return;
    }
    expect(english.text.length).toBeLessThanOrEqual(3500);
    const englishLines = english.text.split("\n");
    expect(englishLines[0]).toBe("allowlist -100");
    const englishIds = englishLines[2]?.slice("allow ".length).split(",") ?? [];
    const englishOmitted = Number(
      /^(\d+) more$/.exec(englishLines[3] ?? "")?.[1],
    );
    expect(englishIds.length + englishOmitted).toBe(200);
    expect(englishIds).toEqual(ids.slice(0, englishIds.length));
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

  it("fits a long rule list without cutting a line", async () => {
    const deps = kit();
    const actions = [
      "log",
      "report",
      "captcha",
      "decline",
      "delete",
      "mute",
      "ban",
    ];
    const ids = Array.from(
      { length: 80 },
      (_, index) => `r${String(index).padStart(2, "0")}_${"a".repeat(60)}`,
    );
    const doc = {
      version: 1,
      aggregate: "max" as const,
      rules: ids.map((id) => ({
        id,
        enabled: true,
        detectorIds: ["keyword"],
        threshold: 100,
        actions,
      })),
    };
    const shown = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
      source: {
        async loadChat() {
          return null;
        },
        async loadDefault() {
          return doc;
        },
      },
    });
    expect(shown.status).toBe("reply");
    if (shown.status !== "reply") {
      return;
    }
    expect(shown.text.length).toBeLessThanOrEqual(3500);
    const lines = shown.text.split("\n");
    expect(lines[0]).toBe("rules -100");
    const listed = lines.slice(1, -1);
    const omitted = Number(/^还有 (\d+) 条$/.exec(lines.at(-1) ?? "")?.[1]);
    expect(listed.length + omitted).toBe(80);
    expect(listed[0]).toContain(ids[0]);
    expect(shown.text).not.toContain(ids[79]);
    expect(listed.every((line) => !line.endsWith(" "))).toBe(true);
    const english = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
      source: {
        async loadChat() {
          return null;
        },
        async loadDefault() {
          return doc;
        },
      },
    });
    expect(english.status).toBe("reply");
    if (english.status !== "reply") {
      return;
    }
    const englishLines = english.text.split("\n");
    const englishOmitted = Number(
      /^(\d+) more$/.exec(englishLines.at(-1) ?? "")?.[1],
    );
    expect(englishLines.slice(1, -1).length + englishOmitted).toBe(80);
    expect(english.text.length).toBeLessThanOrEqual(3500);
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
      expect(rules.text).toContain("spam_keywords enabled file threshold 1");
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
    expect(result.text).not.toContain("还有更早的审计");
  });

  it("lists the newest ten audits and points at export", async () => {
    const deps = kit();
    for (let index = 0; index < 12; index += 1) {
      await deps.storage.appendAudit({
        tenantId: "local",
        chatId: "-100",
        eventId: `evt_${index}`,
        action: "log",
        score: 0,
        reasons: [],
        evidence: [],
        ruleIds: [],
        createdAt: "2026-11-01T00:00:00Z",
      });
    }
    const result = await runOperatorCommand({
      event: event({ text: "/logs -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result.status).toBe("reply");
    if (result.status !== "reply") {
      return;
    }
    const ids = result.text
      .split("\n")
      .slice(0, -1)
      .map((line) => line.split(" ")[1]);
    expect(ids).toEqual([
      "evt_2",
      "evt_3",
      "evt_4",
      "evt_5",
      "evt_6",
      "evt_7",
      "evt_8",
      "evt_9",
      "evt_10",
      "evt_11",
    ]);
    expect(result.text.endsWith("还有更早的审计，用 /export 导出")).toBe(true);

    const exact = kit();
    for (let index = 0; index < 10; index += 1) {
      await exact.storage.appendAudit({
        tenantId: "local",
        chatId: "-100",
        eventId: `evt_${index}`,
        action: "log",
        score: 0,
        reasons: [],
        evidence: [],
        ruleIds: [],
        createdAt: "2026-11-01T00:00:00Z",
      });
    }
    const fullPage = await runOperatorCommand({
      event: event({ text: "/logs -100", direct: true }),
      adminActorIds: ["42"],
      ...exact,
    });
    expect(fullPage.status).toBe("reply");
    if (fullPage.status !== "reply") {
      return;
    }
    expect(fullPage.text.split(" ")[1]).toBe("evt_0");
    expect(fullPage.text).toContain("evt_9");
    expect(fullPage.text).not.toContain("还有更早的审计");
  });

  it("keeps a long audit line inside the private-message limit", async () => {
    const deps = kit();
    const ruleIds = Array.from(
      { length: 60 },
      (_, index) => `r${String(index).padStart(2, "0")}_${"a".repeat(60)}`,
    );
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_rules",
      action: "delete",
      score: 1,
      reasons: [],
      evidence: [],
      ruleIds,
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
    expect(result.text.length).toBeLessThanOrEqual(3500);
    expect(result.text).toContain("evt_rules");
    const rules = listedLogTokens(result.text, "rules", "zh");
    expect(rules.ids.length + rules.omitted).toBe(60);
    expect(rules.ids).toEqual(ruleIds.slice(0, rules.ids.length));
    expect(rules.omitted).toBeGreaterThan(0);
    expect(result.text).not.toContain(ruleIds[59]);
    const reasons = listedLogTokens(result.text, "reasons", "zh");
    expect(reasons).toEqual({ ids: [], omitted: 0 });

    const english = await runOperatorCommand({
      event: event({ text: "/logs -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...deps,
    });
    expect(english.status).toBe("reply");
    if (english.status !== "reply") {
      return;
    }
    expect(english.text.length).toBeLessThanOrEqual(3500);
    const englishRules = listedLogTokens(english.text, "rules", "en");
    expect(englishRules.ids.length + englishRules.omitted).toBe(60);
    expect(englishRules.ids).toEqual(ruleIds.slice(0, englishRules.ids.length));
    expect(english.text).not.toContain(ruleIds[59]);
  });

  it("drops reasons before rules when one audit line is too long", async () => {
    const deps = kit();
    const ruleIds = Array.from(
      { length: 40 },
      (_, index) => `r${String(index).padStart(2, "0")}_${"b".repeat(60)}`,
    );
    const reasons = Array.from(
      { length: 40 },
      (_, index) => `s${String(index).padStart(2, "0")}_${"c".repeat(60)}`,
    );
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_both",
      action: "ban",
      score: 3,
      reasons,
      evidence: [],
      ruleIds,
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
    expect(result.text.length).toBeLessThanOrEqual(3500);
    const listedRules = listedLogTokens(result.text, "rules", "zh");
    const listedReasons = listedLogTokens(result.text, "reasons", "zh");
    expect(listedRules.ids).toEqual(ruleIds);
    expect(listedRules.omitted).toBe(0);
    expect(listedReasons.ids.length + listedReasons.omitted).toBe(40);
    expect(listedReasons.ids).toEqual(
      reasons.slice(0, listedReasons.ids.length),
    );
    expect(listedReasons.omitted).toBeGreaterThan(0);
    expect(listedReasons.ids[0]).toBe(reasons[0]);
    expect(result.text).not.toContain(reasons[39]);
  });

  it("fits ten long audit lines without cutting a token", async () => {
    const deps = kit();
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_old",
      action: "log",
      score: 0,
      reasons: [],
      evidence: [],
      ruleIds: [],
      createdAt: "2026-11-01T00:00:00Z",
    });
    const pages = Array.from({ length: 10 }, (_, eventIndex) => {
      const ruleIds = Array.from(
        { length: 20 },
        (_, ruleIndex) =>
          `e${eventIndex}_${String(ruleIndex).padStart(2, "0")}_${"d".repeat(60)}`,
      );
      return { eventId: `evt_${eventIndex}`, ruleIds };
    });
    for (const page of pages) {
      await deps.storage.appendAudit({
        tenantId: "local",
        chatId: "-100",
        eventId: page.eventId,
        action: "delete",
        score: 1,
        reasons: ["keyword_match"],
        evidence: [],
        ruleIds: page.ruleIds,
        createdAt: "2026-11-01T00:00:00Z",
      });
    }
    const result = await runOperatorCommand({
      event: event({ text: "/logs -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(result.status).toBe("reply");
    if (result.status !== "reply") {
      return;
    }
    expect(result.text.length).toBeLessThanOrEqual(3500);
    expect(result.text.endsWith("还有更早的审计，用 /export 导出")).toBe(true);
    const lines = result.text.split("\n").slice(0, -1);
    expect(lines).toHaveLength(10);
    for (const [index, page] of pages.entries()) {
      expect(lines[index]).toContain(page.eventId);
      const listed = listedLogTokens(lines[index] ?? "", "rules", "zh");
      const listedReasons = listedLogTokens(
        lines[index] ?? "",
        "reasons",
        "zh",
      );
      expect(listed.ids.length + listed.omitted).toBe(20);
      expect(listed.ids).toEqual(page.ruleIds.slice(0, listed.ids.length));
      expect(listed.omitted).toBeGreaterThan(0);
      expect(listedReasons).toEqual({ ids: [], omitted: 1 });
      expect(lines[index]).not.toContain(page.ruleIds[19]);
    }
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
    expect(longExport.status).toBe("reply");
    if (longExport.status !== "reply") {
      return;
    }
    expect(longExport.text.length).toBeLessThanOrEqual(3500);
    const doc = JSON.parse(longExport.text) as {
      omitted: number;
      audits: { eventId: string }[];
    };
    expect(doc.omitted).toBeGreaterThan(0);
    expect(doc.omitted + doc.audits.length).toBe(20);
    expect(doc.audits.at(-1)?.eventId).toBe("evt_19");
    expect(doc.audits[0]?.eventId).not.toBe("evt_0");
    expect(longExport.text).not.toContain(phrase);
    expect(longExport.text).not.toContain('"text"');
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

  it("reports an overlong export without reading the audit rows", async () => {
    const deps = kit();
    deps.storage.countAudits = async () => 4000;
    deps.storage.exportAudits = () => Promise.reject(new Error(phrase));
    const exported = await runOperatorCommand({
      event: event({ text: "/export", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(exported).toMatchObject({ text: "导出 4000 条，超过私聊长度" });
    expect(JSON.stringify(exported)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    for (let index = 0; index < 3; index += 1) {
      await deps.storage.appendAudit({
        tenantId: "local",
        chatId: "-100",
        eventId: `evt_${index}`,
        action: "log",
        score: 0,
        reasons: [],
        evidence: [],
        ruleIds: [],
        createdAt: "2026-11-01T00:00:00Z",
      });
    }
    const page = await runOperatorCommand({
      event: event({ text: "/export", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(page.status).toBe("reply");
    if (page.status !== "reply") {
      return;
    }
    const doc = JSON.parse(page.text) as {
      omitted: number;
      audits: { eventId: string }[];
    };
    expect(doc.audits.map((item) => item.eventId)).toEqual([
      "evt_0",
      "evt_1",
      "evt_2",
    ]);
    expect(doc.omitted + doc.audits.length).toBe(4000);
    expect(page.text).not.toContain(phrase);
  });

  it("says how many audits remain when a forget page stops early", async () => {
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
    const deps = kit();
    await deps.storage.appendAudit(audit);
    await deps.storage.appendAudit({ ...audit, eventId: "evt_2" });
    deps.storage.deleteAudits = async (scope) => {
      const index = deps.storage.records.findIndex(
        (record) =>
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId),
      );
      if (index >= 0) {
        deps.storage.records.splice(index, 1);
      }
      return 1;
    };
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "已删除 1 条，还剩 1 条" });
    expect(deps.storage.records).toHaveLength(1);

    const english = kit();
    await english.storage.appendAudit(audit);
    await english.storage.appendAudit({ ...audit, eventId: "evt_2" });
    english.storage.deleteAudits = async (scope) => {
      const index = english.storage.records.findIndex(
        (record) =>
          record.tenantId === scope.tenantId &&
          (scope.chatId === undefined || record.chatId === scope.chatId),
      );
      if (index >= 0) {
        english.storage.records.splice(index, 1);
      }
      return 1;
    };
    const translated = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      ...english,
    });
    expect(translated).toMatchObject({
      text: "Deleted 1, 1 remaining",
    });
  });

  it("does not count leftovers when forget fails", async () => {
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
    let counted = 0;
    const countAudits = deps.storage.countAudits.bind(deps.storage);
    deps.storage.countAudits = async (scope) => {
      counted += 1;
      return countAudits(scope);
    };
    deps.storage.deleteAudits = () => Promise.reject(new Error(phrase));
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "参数无效" });
    expect(counted).toBe(0);
    expect(deps.storage.records).toHaveLength(1);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("lifts a sender-chat block without unbanning a user", async () => {
    const deps = kit();
    const users: string[] = [];
    const senders: { chatId: string; senderChatId: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/unbansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unbanActor(target) {
          users.push(target.actorId);
        },
        async unbanSenderChat(target) {
          senders.push({
            chatId: target.chatId,
            senderChatId: target.senderChatId,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已解除 -1005 在 -100 的代发禁止",
    });
    expect(users).toEqual([]);
    expect(senders).toEqual([{ chatId: "-100", senderChatId: "-1005" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unbansender <chatId> <senderChatId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/unbansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unbanSenderChat() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Lifted the block on sender chat -1005 in -100",
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/unbansender -100 -1005", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unbanSenderChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/unbansender -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/unbansender <chatId> <senderChatId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/unbansender -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unbanSenderChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/unbansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unbansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unbanSenderChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"unbansender"',
    );

    const foreign = await runOperatorCommand({
      event: event({
        text: "/unbansender -200 -1005",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unbanSenderChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("blocks a sender chat without banning a user", async () => {
    const deps = kit();
    const users: string[] = [];
    const senders: { chatId: string; senderChatId: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/bansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActor(target) {
          users.push(target.actorId);
        },
        async banSenderChat(target) {
          senders.push({
            chatId: target.chatId,
            senderChatId: target.senderChatId,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已禁止 -1005 在 -100 代发。频道主人的其它频道也会被挡住，直到解除",
    });
    expect(users).toEqual([]);
    expect(senders).toEqual([{ chatId: "-100", senderChatId: "-1005" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/bansender <chatId> <senderChatId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/bansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async banSenderChat() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Blocked sender chat -1005 in -100. The owner cannot post as their other channels until this is lifted.",
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/bansender -100 -1005", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async banSenderChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/bansender -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/bansender <chatId> <senderChatId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/bansender -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banSenderChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/bansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/bansender -100 -1005", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banSenderChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"bansender"',
    );

    const foreign = await runOperatorCommand({
      event: event({
        text: "/bansender -200 -1005",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async banSenderChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("approves a pending join without a query id", async () => {
    const deps = kit();
    const approved: {
      chatId: string;
      actorId: string;
      queryId?: string;
    }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/approve -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async approveJoin(target) {
          approved.push({
            chatId: target.chatId,
            actorId: target.actorId,
            ...(target.queryId === undefined
              ? {}
              : { queryId: target.queryId }),
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已批准 -100 77" });
    expect(approved).toEqual([{ chatId: "-100", actorId: "77" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/approve <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/approve -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async approveJoin() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "Approved 77 in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/approve -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async approveJoin() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/approve -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/approve <chatId> <actorId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/approve -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async approveJoin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/approve -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/approve -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async approveJoin() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"approve"',
    );

    const foreign = await runOperatorCommand({
      event: event({ text: "/approve -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async approveJoin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("declines a pending join without a query id", async () => {
    const deps = kit();
    const declined: {
      chatId: string;
      actorId: string;
      queryId?: string;
    }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/decline -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declineJoin(target) {
          declined.push({
            chatId: target.chatId,
            actorId: target.actorId,
            ...(target.queryId === undefined
              ? {}
              : { queryId: target.queryId }),
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已拒绝 -100 77" });
    expect(declined).toEqual([{ chatId: "-100", actorId: "77" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/decline <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/decline -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async declineJoin() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "Declined 77 in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/decline -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async declineJoin() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/decline -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/decline <chatId> <actorId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/decline -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declineJoin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/decline -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/decline -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declineJoin() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"decline"',
    );

    const foreign = await runOperatorCommand({
      event: event({ text: "/decline -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async declineJoin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("deletes one message in a managed chat", async () => {
    const deps = kit();
    const deleted: {
      chatId: string;
      messageId: string;
      audienceId?: string;
    }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/delete -100 88", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage(target) {
          deleted.push({
            chatId: target.chatId,
            messageId: target.messageId,
            ...(target.audienceId ? { audienceId: target.audienceId } : {}),
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已删除 -100 88" });
    expect(deleted).toEqual([{ chatId: "-100", messageId: "88" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/delete <chatId> <messageId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/delete -100 88", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async deleteMessage() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "Deleted 88 in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/delete -100 88", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/delete -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/delete <chatId> <messageId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/delete -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const rejectedIds: string[] = [];
    const padded = await runOperatorCommand({
      event: event({ text: "/delete -100 08", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage(target) {
          rejectedIds.push(target.messageId);
        },
      },
      ...kit(),
    });
    expect(padded).toMatchObject({ text: "参数无效" });
    expect(rejectedIds).toEqual([]);

    const missing = await runOperatorCommand({
      event: event({ text: "/delete -100 88", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/delete -100 88", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/delete -200 88", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reports a member standing without a display name", async () => {
    const deps = kit();
    const seen: string[] = [];
    const replyFor = async (
      standing:
        | { readonly status: "creator" | "administrator" | "member" | "left" }
        | {
            readonly status: "kicked";
            readonly untilDate: number | null;
          }
        | {
            readonly status: "restricted";
            readonly inChat: boolean;
            readonly untilDate: number | null;
          },
      text: string,
    ) =>
      runOperatorCommand({
        event: event({ text, direct: true }),
        adminActorIds: ["42"],
        moderator: {
          async readMember(target) {
            seen.push(`${target.chatId}:${target.actorId}`);
            return standing;
          },
        },
        ...kit(),
      });
    expect(
      await replyFor({ status: "creator" }, "/member -100 77"),
    ).toMatchObject({ text: "-100 77 是群主" });
    expect(
      await replyFor({ status: "administrator" }, "/member -100 77"),
    ).toMatchObject({ text: "-100 77 是管理员" });
    expect(
      await replyFor({ status: "member" }, "/member -100 77"),
    ).toMatchObject({ text: "-100 77 在群里" });
    expect(await replyFor({ status: "left" }, "/member -100 77")).toMatchObject(
      { text: "-100 77 已离开" },
    );
    expect(
      await replyFor({ status: "kicked", untilDate: null }, "/member -100 77"),
    ).toMatchObject({ text: "-100 77 已封禁" });
    expect(
      await replyFor(
        { status: "kicked", untilDate: 1_700_000_000 },
        "/member -100 77",
      ),
    ).toMatchObject({ text: "-100 77 已封禁，直到 1700000000" });
    expect(
      await replyFor(
        { status: "restricted", inChat: true, untilDate: null },
        "/member -100 77",
      ),
    ).toMatchObject({ text: "-100 77 禁言中" });
    expect(
      await replyFor(
        { status: "restricted", inChat: true, untilDate: 1_700_000_000 },
        "/member -100 77",
      ),
    ).toMatchObject({ text: "-100 77 禁言中，直到 1700000000" });
    expect(
      await replyFor(
        { status: "restricted", inChat: false, untilDate: null },
        "/member -100 77",
      ),
    ).toMatchObject({ text: "-100 77 禁言中，人不在群里" });
    expect(
      await replyFor(
        { status: "restricted", inChat: false, untilDate: 1_700_000_000 },
        "/member -100 77",
      ),
    ).toMatchObject({ text: "-100 77 禁言中，人不在群里，直到 1700000000" });
    expect(seen).toEqual(Array.from({ length: 10 }, () => "-100:77"));
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/member <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/member -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readMember() {
          return { status: "creator" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "77 owns -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/member -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readMember() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/member -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/member <chatId> <actorId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/member -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMember() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/member -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/member -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMember() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/member -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readMember() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("mutes a member for the default hour", async () => {
    const deps = kit();
    const muted: {
      chatId: string;
      actorId: string;
      durationSeconds: number;
    }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/mute -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          muted.push({
            chatId: target.chatId,
            actorId: target.actorId,
            durationSeconds: target.durationSeconds,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已禁言 -100 77 3600 秒" });
    expect(muted).toEqual([
      { chatId: "-100", actorId: "77", durationSeconds: 3600 },
    ]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/mute <chatId> <actorId> [seconds]");
    }

    const custom = await runOperatorCommand({
      event: event({ text: "/mute -100 77 120", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          muted.push({
            chatId: target.chatId,
            actorId: target.actorId,
            durationSeconds: target.durationSeconds,
          });
        },
      },
      ...kit(),
    });
    expect(custom).toMatchObject({ text: "已禁言 -100 77 120 秒" });
    expect(muted[1]).toEqual({
      chatId: "-100",
      actorId: "77",
      durationSeconds: 120,
    });

    const english = await runOperatorCommand({
      event: event({ text: "/mute -100 77 30", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async muteActor() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Muted 77 in -100 for 30 seconds",
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/mute -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/mute -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/mute <chatId> <actorId> [seconds]",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/mute -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const rejectedSeconds: number[] = [];
    const short = await runOperatorCommand({
      event: event({ text: "/mute -100 77 29", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          rejectedSeconds.push(target.durationSeconds);
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({ text: "参数无效" });

    const long = await runOperatorCommand({
      event: event({ text: "/mute -100 77 31622401", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          rejectedSeconds.push(target.durationSeconds);
        },
      },
      ...kit(),
    });
    expect(long).toMatchObject({ text: "参数无效" });
    expect(rejectedSeconds).toEqual([]);

    const missing = await runOperatorCommand({
      event: event({ text: "/mute -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/mute -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/mute -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async muteActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("bans a member in a managed chat", async () => {
    const deps = kit();
    const banned: { chatId: string; actorId: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/ban -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已封禁 -100 77" });
    expect(banned).toEqual([{ chatId: "-100", actorId: "77" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/ban <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/ban -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async banActor() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "Banned 77 in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/ban -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async banActor() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/ban -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/ban <chatId> <actorId>" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/ban -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/ban -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/ban -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/ban -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async banActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("unbans a member in a managed chat", async () => {
    const deps = kit();
    const unbanned: { chatId: string; actorId: string }[] = [];
    const lifted = await runOperatorCommand({
      event: event({ text: "/unban -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unbanActor(target) {
          unbanned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(lifted).toMatchObject({ text: "已解除封禁 -100 77" });
    expect(unbanned).toEqual([{ chatId: "-100", actorId: "77" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unban <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/unban -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unbanActor() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "Unbanned 77 in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/unban -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unbanActor() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/unban -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/unban <chatId> <actorId>" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/unban -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unbanActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/unban -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unban -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unbanActor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/unban -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unbanActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("lifts a mute and leaves an unrestricted member unchanged", async () => {
    const deps = kit();
    const unmuted: { chatId: string; actorId: string }[] = [];
    const lifted = await runOperatorCommand({
      event: event({ text: "/unmute -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unmuteActor(target) {
          unmuted.push({ chatId: target.chatId, actorId: target.actorId });
          return "lifted";
        },
      },
      ...deps,
    });
    expect(lifted).toMatchObject({ text: "已解除禁言 -100 77" });
    expect(unmuted).toEqual([{ chatId: "-100", actorId: "77" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unmute <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/unmute -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unmuteActor() {
          return "absent";
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "77 is not muted in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/unmute -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unmuteActor() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/unmute -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/unmute <chatId> <actorId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/unmute -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unmuteActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/unmute -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unmute -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unmuteActor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/unmute -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unmuteActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("forgets a chat without reading the audit rows", async () => {
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
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-200",
      eventId: "evt_2",
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: "keyword:spam" }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    deps.storage.exportAudits = () => Promise.reject(new Error(phrase));
    const forgotten = await runOperatorCommand({
      event: event({ text: "/forget -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(forgotten).toMatchObject({ text: "已删除 1 条" });
    expect(deps.storage.records).toHaveLength(1);
    expect(deps.storage.records[0]?.chatId).toBe("-200");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
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
    expect(off).toMatchObject({ text: "blocklist -100 off shared 0" });
    const english = await runOperatorCommand({
      event: event({ text: "/blocklist -100", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      locale: "en",
      ...deps,
    });
    expect(english).toMatchObject({ text: "Blocklist -100 is off shared 0" });
    expect(reads).toBe(0);

    const added = await runOperatorCommand({
      event: event({ text: "/blocklist -100 add actor 9", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(added).toMatchObject({ text: "blocklist -100 off shared 1\nadded" });
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
    expect(hashed).toMatchObject({
      text: "blocklist -100 off shared 2\nadded",
    });
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
    expect(turnedOn).toMatchObject({ text: "blocklist -100 on shared 2" });
    const turnedOff = await runOperatorCommand({
      event: event({ text: "/blocklist -100 off", direct: true }),
      adminActorIds: ["42"],
      blocklist: wrapped,
      ...deps,
    });
    expect(turnedOff).toMatchObject({ text: "blocklist -100 off shared 2" });
    expect(await blocklist.isEnabled("local", "-100")).toBe(false);
    expect(await blocklist.has("local", { kind: "actor", value: "9" })).toBe(
      true,
    );
  });

  it("removes one shared entry without echoing the identifier", async () => {
    const deps = kit();
    const blocklist = createMemoryBlocklistStore();
    const hash = "cd".repeat(32);
    await blocklist.add("local", { kind: "actor", value: "user_9" });
    await blocklist.add("local", { kind: "hash", value: hash });
    await blocklist.setEnabled("local", "-100", true);
    const removed = await runOperatorCommand({
      event: event({
        text: "/blocklist -100 remove actor user_9",
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(removed).toMatchObject({
      text: "blocklist -100 on shared 1\nremoved",
    });
    expect(JSON.stringify(removed)).not.toContain("user_9");
    expect(
      await blocklist.has("local", { kind: "actor", value: "user_9" }),
    ).toBe(false);
    expect(await blocklist.has("local", { kind: "hash", value: hash })).toBe(
      true,
    );
    expect(await blocklist.isEnabled("local", "-100")).toBe(true);
    const hashed = await runOperatorCommand({
      event: event({
        text: `/blocklist -100 remove hash ${hash.toUpperCase()}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(hashed).toMatchObject({
      text: "blocklist -100 on shared 0\nremoved",
    });
    expect(JSON.stringify(hashed)).not.toContain(hash);
    expect(await blocklist.has("local", { kind: "hash", value: hash })).toBe(
      false,
    );
    const absent = await runOperatorCommand({
      event: event({
        text: "/blocklist -100 remove actor user_9",
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(absent).toMatchObject({
      text: "blocklist -100 on shared 0\nabsent",
    });
    expect(JSON.stringify(absent)).not.toContain("user_9");
    const raw = await runOperatorCommand({
      event: event({
        text: `/blocklist -100 remove actor ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(raw).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(raw)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
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
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>|remove actor <id>|remove hash <sha256>]",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");

    const usage = await runOperatorCommand({
      event: event({ text: "/blocklist", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(usage).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>|remove actor <id>|remove hash <sha256>]",
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
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>|remove actor <id>|remove hash <sha256>]",
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
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>|remove actor <id>|remove hash <sha256>]",
    });
    const wrongKind = await runOperatorCommand({
      event: event({ text: "/blocklist -100 add note 9", direct: true }),
      adminActorIds: ["42"],
      blocklist,
      ...deps,
    });
    expect(wrongKind).toMatchObject({
      text: "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>|remove actor <id>|remove hash <sha256>]",
    });

    const addedThenUnreadable = createMemoryBlocklistStore();
    const hide: BlocklistStore = {
      isEnabled() {
        return Promise.reject(new Error(phrase));
      },
      setEnabled: (tenantId, chatId, enabled) =>
        addedThenUnreadable.setEnabled(tenantId, chatId, enabled),
      add: (tenantId, entry) => addedThenUnreadable.add(tenantId, entry),
      remove: (tenantId, entry) => addedThenUnreadable.remove(tenantId, entry),
      size: (tenantId) => addedThenUnreadable.size(tenantId),
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
      async remove() {
        return false;
      },
      async size() {
        return 0;
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
        createdAt: `2026-11-01T00:00:00.${String(index).padStart(3, "0")}Z`,
      });
    }
    const longExport = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      review,
      ...deps,
    });
    expect(longExport.status).toBe("reply");
    if (longExport.status !== "reply") {
      return;
    }
    expect(longExport.text.length).toBeLessThanOrEqual(3500);
    const doc = JSON.parse(longExport.text) as {
      omitted: number;
      cases: { id: string }[];
    };
    expect(doc.omitted).toBeGreaterThan(0);
    expect(doc.omitted + doc.cases.length).toBe(40);
    expect(doc.cases.at(-1)?.id).toBe("evt_39");
    expect(doc.cases[0]?.id).not.toBe("evt_0");
    expect(longExport.text).not.toContain(phrase);
    expect(longExport.text).not.toContain('"text"');
    const english = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      review,
      ...deps,
    });
    expect(english.status).toBe("reply");
    if (english.status !== "reply") {
      return;
    }
    expect(JSON.parse(english.text)).toEqual(JSON.parse(longExport.text));

    const packed = createMemoryReviewQueue();
    await packed.enqueue({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_packed",
      label: "confirmed",
      textSha256: "cd".repeat(32),
      action: "delete",
      score: 1,
      reasons: Array.from({ length: 16 }, () => "\\".repeat(80)),
      ruleIds: Array.from({ length: 16 }, () => "\\".repeat(64)),
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const over = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      review: packed,
      ...deps,
    });
    expect(over).toMatchObject({ text: "评测样本 1 条，超过私聊长度" });
    const overEnglish = await runOperatorCommand({
      event: event({ text: "/evals -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      review: packed,
      ...deps,
    });
    expect(overEnglish).toMatchObject({
      text: "1 cases, longer than a private message",
    });
  });

  it("opts a chat into a rule pack without storing the message", async () => {
    const deps = kit();
    const rulePacks = createMemoryRuleSubscriptionStore();
    const missing = await runOperatorCommand({
      event: event({ text: "/packs -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const usage = await runOperatorCommand({
      event: event({ text: "/packs", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      ...deps,
    });
    expect(usage).toMatchObject({ text: "用法：/packs <chatId> [packId|off]" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/packs -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      ...deps,
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const skipped = await runOperatorCommand({
      event: event({ text: "/packs -100 community", chatId: "-100" }),
      adminActorIds: ["42"],
      rulePacks,
      ...deps,
    });
    expect(skipped.status).toBe("skip");
    expect(await rulePacks.get("local", "-100")).toBeNull();
    const subscribed = await runOperatorCommand({
      event: event({ text: "/packs -100 community", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      ...deps,
    });
    expect(subscribed).toMatchObject({ text: "packs -100 community" });
    expect(deps.storage.ruleWrites).toBe(0);
    const shown = await runOperatorCommand({
      event: event({ text: "/packs -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      ...deps,
    });
    expect(shown).toMatchObject({ text: "packs -100 community" });
    const cleared = await runOperatorCommand({
      event: event({ text: "/packs -100 off", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      ...deps,
    });
    expect(cleared).toMatchObject({ text: "packs -100 none" });
    expect(await rulePacks.get("local", "-100")).toBeNull();
    const english = await runOperatorCommand({
      event: event({ text: "/packs -100 extra extra", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      rulePacks,
      ...deps,
    });
    expect(english).toMatchObject({
      text: "Usage: /packs <chatId> [packId|off]",
    });
    const failing = {
      async get() {
        throw new Error(phrase);
      },
      async put() {
        throw new Error(phrase);
      },
    };
    const broken = await runOperatorCommand({
      event: event({ text: "/packs -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks: failing,
      ...deps,
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    const writeFail = {
      async get() {
        return null;
      },
      async put() {
        throw new Error(phrase);
      },
    };
    const refused = await runOperatorCommand({
      event: event({ text: "/packs -100 community", direct: true }),
      adminActorIds: ["42"],
      rulePacks: writeFail,
      ...deps,
    });
    expect(refused).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(
      deps.logger.entries.some(
        (entry) =>
          entry.message === "operator_rejected" &&
          entry.fields.command === "packs",
      ),
    ).toBe(true);
  });

  it("lists the subscribed pack from the same resolver as screening", async () => {
    const deps = kit();
    const rulePacks = createMemoryRuleSubscriptionStore();
    const rulePackArchive = createMemoryRulePackArchive();
    const rulePackSource = communityPack();
    await runOperatorCommand({
      event: event({ text: "/packs -100 community", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    const listed = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(listed).toMatchObject({ status: "reply" });
    if (listed.status === "reply") {
      expect(listed.text.startsWith("rules -100 community\n")).toBe(true);
      expect(listed.text).toContain(
        "community_keywords enabled file threshold 2 actions delete",
      );
      expect(listed.text).not.toContain("spam_keywords");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(english).toMatchObject({ status: "reply" });
    if (english.status === "reply") {
      expect(english.text.startsWith("rules -100 community\n")).toBe(true);
    }
    await deps.runtime.setRuleSwitch(
      "local",
      "-100",
      "community_keywords",
      true,
    );
    const same = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(same).toMatchObject({ status: "reply" });
    if (same.status === "reply") {
      expect(same.text).toContain("community_keywords enabled switch");
    }
    await deps.runtime.setRuleSwitch(
      "local",
      "-100",
      "community_keywords",
      false,
    );
    const switched = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(switched).toMatchObject({ status: "reply" });
    if (switched.status === "reply") {
      expect(switched.text).toContain("community_keywords disabled switch");
    }
    const fileToggle = await runOperatorCommand({
      event: event({ text: "/rule -100 spam_keywords off", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(fileToggle).toMatchObject({
      text: "rule -100 spam_keywords disabled switch",
    });
    const packToggle = await runOperatorCommand({
      event: event({
        text: "/rule -100 community_keywords off",
        direct: true,
      }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(packToggle).toMatchObject({
      text: "rule community_keywords missing",
    });
    const cleared = await runOperatorCommand({
      event: event({ text: "/packs -100 off", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(cleared).toMatchObject({ text: "packs -100 none" });
    const local = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(local).toMatchObject({ status: "reply" });
    if (local.status === "reply") {
      expect(local.text.startsWith("rules -100\n")).toBe(true);
      expect(local.text).toContain("spam_keywords disabled switch");
      expect(local.text).not.toContain("community");
    }
    const failing = {
      async get() {
        throw new Error(phrase);
      },
      async put() {
        return undefined;
      },
    };
    const denied = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks: failing,
      rulePackSource,
      rulePackArchive,
      ...deps,
    });
    expect(denied).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(
      deps.logger.entries.some(
        (entry) => entry.message === "pack_store_failed",
      ),
    ).toBe(true);
    const broken: RulePackSource = {
      async load() {
        throw new Error(phrase);
      },
    };
    await rulePacks.put("local", "-100", "community");
    const fallback = await runOperatorCommand({
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      rulePacks,
      rulePackSource: broken,
      rulePackArchive: createMemoryRulePackArchive(),
      ...deps,
      cache: cache(),
    });
    expect(fallback).toMatchObject({ status: "reply" });
    if (fallback.status === "reply") {
      expect(fallback.text.startsWith("rules -100 community\n")).toBe(true);
      expect(fallback.text).toContain("spam_keywords");
      expect(fallback.text).not.toContain(phrase);
    }
    expect(JSON.stringify(deps.logger.entries)).toContain("pack_update_failed");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("marks rules the free quota would drop without counting", async () => {
    const deps = kit();
    const source = quotaRules();
    let reads = 0;
    const quota = {
      async read() {
        reads += 1;
        return {
          enabled: true,
          used: 2,
          limit: 1,
          period: "calendar_month" as const,
          degraded: true,
          basicDetectorIds: ["keyword"],
        };
      },
    };
    const listed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota,
    });
    expect(reads).toBe(1);
    expect(listed).toMatchObject({ status: "reply" });
    if (listed.status === "reply") {
      expect(listed.text).toContain(
        "spam_keywords enabled file threshold 1 actions delete\n",
      );
      expect(listed.text).toContain(
        "llm_hint disabled file threshold 1 actions log paused",
      );
      expect(listed.text).toContain(
        "mixed enabled file threshold 1 actions delete paused",
      );
      expect(listed.text).not.toContain(
        "spam_keywords enabled file threshold 1 actions delete paused",
      );
      expect(listed.text).not.toContain("until");
    }
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      source,
      quota,
    });
    expect(english).toMatchObject({ status: "reply" });
    if (english.status === "reply") {
      expect(english.text).toContain(
        "llm_hint disabled file threshold 1 actions log paused",
      );
    }
    const open = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          return {
            enabled: true,
            used: 1,
            limit: 1,
            period: "calendar_month",
            degraded: false,
            basicDetectorIds: ["keyword"],
          };
        },
      },
    });
    expect(open).toMatchObject({ status: "reply" });
    if (open.status === "reply") {
      expect(open.text).not.toContain("paused");
    }
    const disabled = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          return {
            enabled: false,
            used: 0,
            limit: 1,
            period: "calendar_month",
            degraded: false,
          };
        },
      },
    });
    expect(disabled).toMatchObject({ status: "reply" });
    if (disabled.status === "reply") {
      expect(disabled.text).not.toContain("paused");
    }
    const plain = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
    });
    expect(plain).toMatchObject({ status: "reply" });
    if (plain.status === "reply") {
      expect(plain.text).not.toContain("paused");
    }
    const invalid = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          return { text: phrase };
        },
      },
    });
    expect(invalid).toMatchObject({ status: "reply" });
    if (invalid.status === "reply") {
      expect(invalid.text).toContain("llm_hint disabled file");
      expect(invalid.text).not.toContain("paused");
      expect(invalid.text).not.toContain(phrase);
    }
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ status: "reply" });
    if (broken.status === "reply") {
      expect(broken.text).toContain("llm_hint disabled file");
      expect(broken.text).not.toContain("paused");
      expect(broken.text).not.toContain(phrase);
    }
    expect(JSON.stringify(deps.logger.entries)).toContain("quota_failed");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("puts the quota window end on a degraded /rules header", async () => {
    const deps = kit();
    const source = quotaRules();
    let reads = 0;
    const listed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          reads += 1;
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month" as const,
            degraded: true,
            basicDetectorIds: ["keyword"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(reads).toBe(1);
    expect(listed).toMatchObject({ status: "reply" });
    if (listed.status === "reply") {
      expect(
        listed.text.startsWith("rules -100 until 2026-12-01T00:00:00.000Z\n"),
      ).toBe(true);
      expect(listed.text).toContain(
        "llm_hint disabled file threshold 1 actions log paused",
      );
      expect(listed.text).not.toContain(phrase);
    }
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      source,
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(english).toMatchObject({ status: "reply" });
    if (english.status === "reply") {
      expect(
        english.text.startsWith("rules -100 until 2026-12-01T00:00:00.000Z\n"),
      ).toBe(true);
    }
    const open = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          return {
            enabled: true,
            used: 0,
            limit: 3000,
            period: "calendar_month",
            degraded: false,
            basicDetectorIds: ["keyword"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(open).toMatchObject({ status: "reply" });
    if (open.status === "reply") {
      expect(open.text.startsWith("rules -100\n")).toBe(true);
      expect(open.text).not.toContain("until");
    }
    const rulePacks = createMemoryRuleSubscriptionStore();
    const rulePackArchive = createMemoryRulePackArchive();
    const rulePackSource = communityPack();
    await rulePacks.put("local", "-100", "community");
    const packed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      cache: cache(),
      rulePacks,
      rulePackSource,
      rulePackArchive,
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(packed).toMatchObject({ status: "reply" });
    if (packed.status === "reply") {
      expect(
        packed.text.startsWith(
          "rules -100 community until 2026-12-01T00:00:00.000Z\n",
        ),
      ).toBe(true);
      expect(packed.text).toContain(
        "community_keywords enabled file threshold 2 actions delete",
      );
      expect(packed.text).not.toContain("paused");
    }
    const invalid = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source,
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword"],
            resetsAt: phrase,
          };
        },
      },
    });
    expect(invalid).toMatchObject({ status: "reply" });
    if (invalid.status === "reply") {
      expect(invalid.text.startsWith("rules -100\n")).toBe(true);
      expect(invalid.text).not.toContain("until");
      expect(invalid.text).not.toContain("paused");
      expect(invalid.text).not.toContain(phrase);
    }
    expect(JSON.stringify(deps.logger.entries)).toContain("quota_failed");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("reports a configurable quota without echoing extra text", async () => {
    const deps = kit();
    const missing = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(missing).toMatchObject({ text: "quota off" });
    const usage = await runOperatorCommand({
      event: event({ text: `/quota -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
          };
        },
      },
      ...deps,
    });
    expect(usage).toMatchObject({ text: "用法：/quota <chatId>" });
    expect(JSON.stringify(usage)).not.toContain(phrase);
    const shown = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
          };
        },
      },
      ...deps,
    });
    expect(shown).toMatchObject({
      text: "quota -100 2/1 calendar_month basic",
    });
    const english = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      quota: {
        async read() {
          return {
            enabled: true,
            used: 1,
            limit: 3000,
            period: "rolling_30d",
            degraded: false,
          };
        },
      },
      ...deps,
    });
    expect(english).toMatchObject({
      text: "Quota -100 1/3000 rolling_30d full",
    });
    const broken = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          throw new Error(phrase);
        },
      },
      ...deps,
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const off = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: false,
            used: 0,
            limit: 1,
            period: "calendar_month",
            degraded: false,
          };
        },
      },
      ...deps,
    });
    expect(off).toMatchObject({ text: "quota off" });
    const invalid = await runOperatorCommand({
      event: event({ text: "/quota nope", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return null;
        },
      },
      ...deps,
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
  });

  it("lists basic detector ids when the quota is degraded", async () => {
    const deps = kit();
    const degraded = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword", "join"],
          };
        },
      },
      ...deps,
    });
    expect(degraded).toMatchObject({
      text: "quota -100 2/1 calendar_month basic\nkeyword,join",
    });
    expect(JSON.stringify(degraded)).not.toContain(phrase);
    const english = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword"],
          };
        },
      },
      ...deps,
    });
    expect(english).toMatchObject({
      text: "Quota -100 2/1 calendar_month basic\nkeyword",
    });
    const full = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      quota: {
        async read() {
          return {
            enabled: true,
            used: 1,
            limit: 3000,
            period: "rolling_30d",
            degraded: false,
            basicDetectorIds: ["keyword"],
          };
        },
      },
      ...deps,
    });
    expect(full).toMatchObject({
      text: "Quota -100 1/3000 rolling_30d full",
    });
    const empty = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: [],
          };
        },
      },
      ...deps,
    });
    expect(empty).toMatchObject({
      text: "quota -100 2/1 calendar_month basic",
    });
  });

  it("names when the quota window resets", async () => {
    const deps = kit();
    const month = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 0,
            limit: 3000,
            period: "calendar_month",
            degraded: false,
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
      ...deps,
    });
    expect(month).toMatchObject({
      text: "quota -100 0/3000 calendar_month full until 2026-12-01T00:00:00.000Z",
    });
    const english = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      quota: {
        async read() {
          return {
            enabled: true,
            used: 1,
            limit: 3000,
            period: "rolling_30d",
            degraded: false,
            resetsAt: "2026-01-31T00:00:00.000Z",
          };
        },
      },
      ...deps,
    });
    expect(english).toMatchObject({
      text: "Quota -100 1/3000 rolling_30d full until 2026-01-31T00:00:00.000Z",
    });
    const degraded = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword", "join"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
      ...deps,
    });
    expect(degraded).toMatchObject({
      text: "quota -100 2/1 calendar_month basic until 2026-12-01T00:00:00.000Z\nkeyword,join",
    });
    expect(JSON.stringify(degraded)).not.toContain(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: "/quota -100", direct: true }),
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 0,
            limit: 3000,
            period: "calendar_month",
            degraded: false,
            resetsAt: phrase,
          };
        },
      },
      ...deps,
    });
    expect(invalid).toMatchObject({ text: "quota off" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("lets a granting user manage only that chat", async () => {
    const deps = kit();
    const directory = {
      async noteBot() {
        return "ok" as const;
      },
      async noteMember() {
        return "ok" as const;
      },
      async chatsFor() {
        return ["-100"];
      },
      async list() {
        return ["-100", "-200"];
      },
    };
    await deps.storage.appendAudit({
      tenantId: "local",
      chatId: "-200",
      eventId: "evt_other",
      action: "delete",
      score: 1,
      reasons: [phrase],
      evidence: [],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const listed = await runOperatorCommand({
      event: event({ text: "/chats", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory,
      ...deps,
    });
    expect(listed).toMatchObject({ text: "chats\n-100" });
    const foreign = await runOperatorCommand({
      event: event({
        text: `/logs -200 ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory,
      ...deps,
    });
    expect(foreign).toMatchObject({ text: "用法：/logs [chatId]" });
    const other = await runOperatorCommand({
      event: event({ text: "/logs -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory,
      ...deps,
    });
    expect(other).toMatchObject({ text: "没有权限" });
    const own = await runOperatorCommand({
      event: event({ text: "/logs", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory,
      ...deps,
    });
    expect(own).toMatchObject({ text: "no audits" });
    expect(deps.storage.records).toHaveLength(1);
    const noisy = await runOperatorCommand({
      event: event({ text: `/chats ${phrase}`, direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory,
      ...deps,
    });
    expect(noisy).toMatchObject({ text: "用法：/chats" });
    const broken = await runOperatorCommand({
      event: event({ text: "/chats", direct: true, actorId: "9" }),
      adminActorIds: ["42"],
      chats: {
        ...directory,
        async chatsFor() {
          throw new Error(phrase);
        },
      },
      ...deps,
    });
    expect(broken).toMatchObject({ text: "没有权限" });
    const off = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(off).toMatchObject({ text: "chats off" });
    const empty = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      chats: {
        ...directory,
        async list() {
          return [];
        },
      },
      ...deps,
    });
    expect(empty).toMatchObject({ text: "none" });
    const counted = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      chats: directory,
      quota: {
        async read(_tenantId, chatId) {
          if (chatId === "-100") {
            return {
              enabled: true,
              used: 2,
              limit: 1,
              period: "calendar_month",
              degraded: true,
              resetsAt: "2026-12-01T00:00:00.000Z",
              basicDetectorIds: ["keyword"],
            };
          }
          return {
            enabled: true,
            used: 0,
            limit: 3000,
            period: "calendar_month",
            degraded: false,
          };
        },
      },
      ...deps,
    });
    expect(counted).toMatchObject({
      text: "chats\n-100 2/1\n-200 0/3000",
    });
    expect(JSON.stringify(counted)).not.toContain("until");
    expect(JSON.stringify(counted)).not.toContain("basic");
    expect(JSON.stringify(counted)).not.toContain(phrase);
    const english = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      chats: directory,
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
          };
        },
      },
      ...deps,
    });
    expect(english).toMatchObject({ text: "chats\n-100 2/1\n-200 2/1" });
    const reads: string[] = [];
    const scoped = await runOperatorCommand({
      event: event({ text: "/chats", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory,
      quota: {
        async read(_tenantId, chatId) {
          reads.push(chatId);
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
          };
        },
      },
      ...deps,
    });
    expect(reads).toEqual(["-100"]);
    expect(scoped).toMatchObject({ text: "chats\n-100 2/1" });
    const brokenQuota = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      chats: directory,
      quota: {
        async read(_tenantId, chatId) {
          if (chatId === "-100") {
            throw new Error(phrase);
          }
          return {
            enabled: true,
            used: 0,
            limit: 3000,
            period: "calendar_month",
            degraded: false,
          };
        },
      },
      ...deps,
    });
    expect(brokenQuota).toMatchObject({
      text: "chats\n-100\n-200 0/3000",
    });
    expect(JSON.stringify(brokenQuota)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).toContain("quota_failed");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const disabled = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      chats: directory,
      quota: {
        async read() {
          return {
            enabled: false,
            used: 4,
            limit: 1,
            period: "calendar_month",
            degraded: false,
          };
        },
      },
      ...deps,
    });
    expect(disabled).toMatchObject({ text: "chats\n-100\n-200" });
    const ids = Array.from(
      { length: 200 },
      (_, index) => `-${100000000000 + index}`,
    );
    const long = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      chats: {
        ...directory,
        async list() {
          return ids;
        },
      },
      quota: {
        async read() {
          return {
            enabled: true,
            used: 0,
            limit: 3000,
            period: "calendar_month",
            degraded: false,
          };
        },
      },
      ...deps,
    });
    expect(long).toMatchObject({ status: "reply" });
    if (long.status === "reply") {
      expect(long.text.length).toBeLessThanOrEqual(3500);
      expect(long.text.startsWith("chats\n-100000000000 0/3000\n")).toBe(true);
      expect(long.text).toMatch(/\n\+\d+$/);
      expect(long.text).not.toContain(phrase);
    }
    const failed = await runOperatorCommand({
      event: event({ text: "/chats", direct: true }),
      adminActorIds: ["42"],
      chats: {
        ...directory,
        async list() {
          throw new Error(phrase);
        },
      },
      ...deps,
    });
    expect(failed).toMatchObject({ text: "参数无效" });
    const outsider = await runOperatorCommand({
      event: event({
        text: "/whitelist -100 add 9",
        direct: true,
        actorId: "8",
      }),
      adminActorIds: ["42"],
      chats: {
        ...directory,
        async chatsFor() {
          return [];
        },
      },
      ...deps,
    });
    expect(outsider).toMatchObject({ text: "没有权限" });
    const many = await runOperatorCommand({
      event: event({ text: "/logs", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: {
        ...directory,
        async chatsFor() {
          return ["-100", "-300"];
        },
      },
      ...deps,
    });
    expect(many).toMatchObject({ text: "用法：/logs [chatId]" });
    const blocked = await runOperatorCommand({
      event: event({
        text: "/whitelist -200 add 9",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory,
      ...deps,
    });
    expect(blocked).toMatchObject({ text: "没有权限" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(other)).not.toContain(phrase);
  });

  it("toggles one rule from private chat without rewriting the file", async () => {
    const deps = kit();
    const file = ruleFile();
    const scoped = directory(["-100"]);
    const on = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule via_inline on", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(on).toMatchObject({
      status: "reply",
      command: "rule",
      text: "rule -100 via_inline enabled switch",
    });
    const listed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(listed).toMatchObject({ status: "reply" });
    if (listed.status === "reply") {
      expect(listed.text).toContain("via_inline enabled switch");
      expect(listed.text).toContain("spam_keywords enabled file");
    }
    const reset = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule via_inline reset",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(reset).toMatchObject({
      text: "rule -100 via_inline disabled file",
    });
    const restored = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(restored).toMatchObject({ status: "reply" });
    if (restored.status === "reply") {
      expect(restored.text).toContain("via_inline disabled file");
      expect(restored.text).not.toContain("via_inline disabled switch");
    }
    const off = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule spam_keywords off",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(off).toMatchObject({
      text: "rule -100 spam_keywords disabled switch",
    });
    const bare = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule via_inline on", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(bare).toMatchObject({
      text: "用法：/rule [chatId] <ruleId> [on|off|reset]",
    });
    const status = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule -100 via_inline", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(status).toMatchObject({
      text: "rule -100 via_inline disabled file",
    });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -200 via_inline on",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/rule ${phrase} on`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule not_a_rule on",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(missing).toMatchObject({ text: "rule not_a_rule missing" });
    const many = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule via_inline on", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100", "-300"]),
      source: file,
    });
    expect(many).toMatchObject({
      text: "用法：/rule [chatId] <ruleId> [on|off|reset]",
    });
    const mode = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule via_inline maybe",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(mode).toMatchObject({
      text: "用法：/rule [chatId] <ruleId> [on|off|reset]",
    });
    expect(JSON.stringify(mode)).not.toContain("maybe");
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      source: file,
    });
    expect(english).toMatchObject({
      text: "Usage: /rule [chatId] <ruleId> [on|off|reset]",
    });
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule -100 via_inline on", direct: true }),
      adminActorIds: ["42"],
      source: file,
      runtime: {
        ...deps.runtime,
        async setRuleSwitch() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("rule_switch_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule -100 via_inline", direct: true }),
      adminActorIds: ["42"],
      source: file,
      runtime: {
        ...deps.runtime,
        async listRuleSwitches() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/rule [chatId] <ruleId> [on|off|reset]");
    }
  });
});

function directory(ids: readonly string[]) {
  return {
    async noteBot() {
      return "ok" as const;
    },
    async noteMember() {
      return "ok" as const;
    },
    async chatsFor() {
      return ids;
    },
    async list() {
      return ids;
    },
  };
}

function ruleFile(): RuleSource {
  return {
    async loadChat() {
      return null;
    },
    async loadDefault() {
      return {
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
          {
            id: "via_inline",
            enabled: false,
            detectorIds: ["via"],
            threshold: 1,
            actions: ["delete"],
          },
        ],
      };
    },
  };
}

function listedLogTokens(
  line: string,
  field: "rules" | "reasons",
  locale: "zh" | "en",
): { ids: string[]; omitted: number } {
  const afterRules = line.split(" rules ")[1] ?? "";
  const [rulesSection = "", reasonsSection = ""] =
    afterRules.split(" reasons ");
  const section = field === "rules" ? rulesSection : reasonsSection;
  const pattern =
    locale === "zh"
      ? field === "rules"
        ? /^(?:(.*?) )?还有 (\d+) 条$/
        : /^(?:(.*?) )?还有 (\d+) 个$/
      : /^(?:(.*?) )?(\d+) more$/;
  const matched = pattern.exec(section);
  if (!matched) {
    return {
      ids: section.length === 0 ? [] : section.split(","),
      omitted: 0,
    };
  }
  const listed = matched[1] ?? "";
  return {
    ids: listed.length === 0 ? [] : listed.split(","),
    omitted: Number(matched[2]),
  };
}

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
    remove: (tenantId, entry) => inner.remove(tenantId, entry),
    size: (tenantId) => inner.size(tenantId),
    async has(tenantId, entry) {
      onRead();
      return inner.has(tenantId, entry);
    },
  };
}

function quotaRules(): RuleSource {
  return {
    async loadChat() {
      return null;
    },
    async loadDefault() {
      return {
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
          {
            id: "llm_hint",
            enabled: false,
            detectorIds: ["llm"],
            threshold: 1,
            actions: ["log"],
          },
          {
            id: "mixed",
            enabled: true,
            detectorIds: ["keyword", "llm"],
            threshold: 1,
            actions: ["delete"],
          },
        ],
      };
    },
  };
}

function communityPack(): RulePackSource {
  return {
    async load() {
      return {
        version: 1,
        aggregate: "max",
        rules: [
          {
            id: "community_keywords",
            enabled: true,
            detectorIds: ["keyword"],
            threshold: 2,
            actions: ["delete"],
          },
        ],
      };
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
    async remove() {
      throw new Error(phrase);
    },
    async size() {
      throw new Error(phrase);
    },
  };
}
