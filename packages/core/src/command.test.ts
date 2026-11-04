import { describe, expect, it } from "vitest";
import {
  type BlocklistStore,
  createMemoryBlocklistStore,
} from "./blocklist.js";
import type { Cache } from "./cache.js";
import { type CaptchaStore, parseCaptchaChallenge } from "./captcha.js";
import { createFixedClock } from "./clock.js";
import { runOperatorCommand } from "./command.js";
import { parseEvent } from "./event.js";
import { createMemoryLogger } from "./logger.js";
import { loadPolicy } from "./policy-load.js";
import type { PolicyStore } from "./policy-store.js";
import type {
  AuditRecord,
  DefaultAdministratorRights,
  DefaultRightsQuery,
  DefaultRightsSnapshot,
  DefaultRightsTarget,
  Storage,
} from "./ports.js";
import { parseAuditRecord } from "./ports.js";
import { prefilterPolicySchema } from "./prefilter.js";
import { createMemoryReviewQueue, type ReviewQueue } from "./review.js";
import {
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  type RulePackSource,
} from "./rule-pack.js";
import type { RuleSource } from "./rules-load.js";
import type { RuleActionOverride, RuntimeStore } from "./runtime.js";
import { createMemoryWarnStore, WarnCapacityError } from "./warn.js";

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
  const ruleActions = new Map<
    string,
    Map<string, RuleActionOverride["action"]>
  >();
  const reports = new Map<string, string>();
  const floods = new Map<
    string,
    { threshold: number; windowSeconds: number }
  >();
  const keywords = new Map<string, string[]>();
  const repeats = new Map<
    string,
    { threshold: number; windowSeconds: number }
  >();
  const mutes = new Map<string, number>();
  const captchas = new Map<string, number>();
  const captchaFails = new Map<string, "kick" | "ban">();
  const allowHosts = new Map<string, string[]>();
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
    async listRuleActions(tenantId, chatId) {
      const saved = ruleActions.get(`${tenantId}:${chatId}`);
      if (!saved) {
        return [];
      }
      return [...saved.entries()].map(([ruleId, action]) => ({
        ruleId,
        action,
      }));
    },
    async setRuleAction(tenantId, chatId, ruleId, action) {
      const id = `${tenantId}:${chatId}`;
      let saved = ruleActions.get(id);
      if (!saved) {
        saved = new Map();
        ruleActions.set(id, saved);
      }
      saved.set(ruleId, action);
      return true;
    },
    async clearRuleAction(tenantId, chatId, ruleId) {
      ruleActions.get(`${tenantId}:${chatId}`)?.delete(ruleId);
    },
    async getReportChat(tenantId, chatId) {
      return reports.get(`${tenantId}:${chatId}`) ?? null;
    },
    async setReportChat(tenantId, chatId, targetId) {
      reports.set(`${tenantId}:${chatId}`, targetId);
      return true;
    },
    async clearReportChat(tenantId, chatId) {
      reports.delete(`${tenantId}:${chatId}`);
    },
    async getFloodPolicy(tenantId, chatId) {
      return floods.get(`${tenantId}:${chatId}`) ?? null;
    },
    async setFloodPolicy(tenantId, chatId, policy) {
      const id = `${tenantId}:${chatId}`;
      if (policy.threshold === 5 && policy.windowSeconds === 10) {
        floods.delete(id);
        return true;
      }
      floods.set(id, {
        threshold: policy.threshold,
        windowSeconds: policy.windowSeconds,
      });
      return true;
    },
    async clearFloodPolicy(tenantId, chatId) {
      floods.delete(`${tenantId}:${chatId}`);
    },
    async listKeywords(tenantId, chatId) {
      return keywords.get(`${tenantId}:${chatId}`) ?? [];
    },
    async addKeyword(tenantId, chatId, keyword) {
      const id = `${tenantId}:${chatId}`;
      const current = keywords.get(id) ?? [];
      if (current.includes(keyword)) {
        return true;
      }
      keywords.set(id, [...current, keyword]);
      return true;
    },
    async removeKeyword(tenantId, chatId, keyword) {
      const id = `${tenantId}:${chatId}`;
      const current = keywords.get(id);
      if (!current?.includes(keyword)) {
        return false;
      }
      const next = current.filter((item) => item !== keyword);
      if (next.length === 0) {
        keywords.delete(id);
        return true;
      }
      keywords.set(id, next);
      return true;
    },
    async clearKeywords(tenantId, chatId) {
      keywords.delete(`${tenantId}:${chatId}`);
    },
    async getRepeatPolicy(tenantId, chatId) {
      return repeats.get(`${tenantId}:${chatId}`) ?? null;
    },
    async setRepeatPolicy(tenantId, chatId, policy) {
      const id = `${tenantId}:${chatId}`;
      if (policy.threshold === 3 && policy.windowSeconds === 60) {
        repeats.delete(id);
        return true;
      }
      repeats.set(id, {
        threshold: policy.threshold,
        windowSeconds: policy.windowSeconds,
      });
      return true;
    },
    async clearRepeatPolicy(tenantId, chatId) {
      repeats.delete(`${tenantId}:${chatId}`);
    },
    async getMuteDuration(tenantId, chatId) {
      return mutes.get(`${tenantId}:${chatId}`) ?? null;
    },
    async setMuteDuration(tenantId, chatId, seconds) {
      const id = `${tenantId}:${chatId}`;
      if (seconds === 3600) {
        mutes.delete(id);
        return true;
      }
      mutes.set(id, seconds);
      return true;
    },
    async clearMuteDuration(tenantId, chatId) {
      mutes.delete(`${tenantId}:${chatId}`);
    },
    async getCaptchaTtl(tenantId, chatId) {
      return captchas.get(`${tenantId}:${chatId}`) ?? null;
    },
    async setCaptchaTtl(tenantId, chatId, seconds) {
      const id = `${tenantId}:${chatId}`;
      if (seconds === 300) {
        captchas.delete(id);
        return true;
      }
      captchas.set(id, seconds);
      return true;
    },
    async clearCaptchaTtl(tenantId, chatId) {
      captchas.delete(`${tenantId}:${chatId}`);
    },
    async getCaptchaFail(tenantId, chatId) {
      return captchaFails.get(`${tenantId}:${chatId}`) ?? null;
    },
    async setCaptchaFail(tenantId, chatId, action) {
      const id = `${tenantId}:${chatId}`;
      if (action === "stay") {
        captchaFails.delete(id);
        return true;
      }
      if (action !== "kick" && action !== "ban") {
        return false;
      }
      captchaFails.set(id, action);
      return true;
    },
    async clearCaptchaFail(tenantId, chatId) {
      captchaFails.delete(`${tenantId}:${chatId}`);
    },
    async listAllowHosts(tenantId, chatId) {
      return allowHosts.get(`${tenantId}:${chatId}`) ?? [];
    },
    async addAllowHost(tenantId, chatId, host) {
      const id = `${tenantId}:${chatId}`;
      const current = allowHosts.get(id) ?? [];
      if (current.includes(host)) {
        return true;
      }
      allowHosts.set(id, [...current, host]);
      return true;
    },
    async removeAllowHost(tenantId, chatId, host) {
      const id = `${tenantId}:${chatId}`;
      const current = allowHosts.get(id);
      if (!current?.includes(host)) {
        return false;
      }
      const next = current.filter((item) => item !== host);
      if (next.length === 0) {
        allowHosts.delete(id);
        return true;
      }
      allowHosts.set(id, next);
      return true;
    },
    async clearAllowHosts(tenantId, chatId) {
      allowHosts.delete(`${tenantId}:${chatId}`);
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

  it("opens default speaking permissions for one chat", async () => {
    const deps = kit();
    const opened: string[] = [];
    const muted: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/unlock -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          muted.push(target.actorId);
        },
        async unlockChat(target) {
          opened.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已打开 -100 的默认发言权限。这可能比锁定前更宽。单人禁言仍在",
    });
    expect(muted).toEqual([]);
    expect(opened).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unlock <chatId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/unlock -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unlockChat() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Opened default speaking permissions in -100. This can be wider than before the lock. Individual mutes stay.",
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/unlock -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unlockChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/unlock", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/unlock <chatId>" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/unlock ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unlockChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/unlock -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unlock -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unlockChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"unlock"',
    );

    const foreign = await runOperatorCommand({
      event: event({ text: "/unlock -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unlockChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("closes default speaking permissions for one chat", async () => {
    const deps = kit();
    const locked: string[] = [];
    const muted: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/lock -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          muted.push(target.actorId);
        },
        async lockChat(target) {
          locked.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已关闭 -100 的默认发言权限。管理员仍可发言。此状态会保持到重新设置权限",
    });
    expect(muted).toEqual([]);
    expect(locked).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/lock <chatId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/lock -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async lockChat() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Closed default speaking permissions in -100. Administrators can still speak. This stays until permissions are set again.",
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/lock -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async lockChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/lock", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/lock <chatId>" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/lock ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async lockChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/lock -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/lock -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async lockChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain('"command":"lock"');

    const foreign = await runOperatorCommand({
      event: event({ text: "/lock -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async lockChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
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

  it("clears recent reactions from one actor", async () => {
    const deps = kit();
    const cleared: { chatId: string; actorId: string; kind: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/clearreact -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async banActor() {
          throw new Error("called");
        },
        async clearReactions(target) {
          cleared.push({
            chatId: target.chatId,
            actorId: target.actorId,
            kind: target.kind,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求清除 77 在 -100 的最近反应。一万条以前的可能还在",
    });
    expect(cleared).toEqual([{ chatId: "-100", actorId: "77", kind: "user" }]);
    const channel = await runOperatorCommand({
      event: event({ text: "/clearreact -100 -1005", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async clearReactions(target) {
          cleared.push({
            chatId: target.chatId,
            actorId: target.actorId,
            kind: target.kind,
          });
        },
      },
      ...kit(),
    });
    expect(channel).toMatchObject({
      text: "已请求清除 -1005 在 -100 的最近反应。一万条以前的可能还在",
    });
    expect(cleared[1]).toEqual({
      chatId: "-100",
      actorId: "-1005",
      kind: "chat",
    });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/clearreact <chatId> <actorId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/clearreact -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async clearReactions() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to clear recent reactions by 77 in -100. Ones older than the latest 10000 may remain.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/clearreact -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async clearReactions() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/clearreact -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/clearreact <chatId> <actorId>",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/clearreact -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async clearReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/clearreact -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/clearreact -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async clearReactions() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"clearreact"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/clearreact -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async clearReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("revokes one bot invite link without echoing it", async () => {
    const code = "AbCdEfGhIjKlMnOp";
    const link = `https://t.me/+${code}`;
    const deps = kit();
    const seen: { chatId: string; inviteLink: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: `/revoke -100 ${link}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async revokeInvite(target) {
          seen.push({
            chatId: target.chatId,
            inviteLink: target.inviteLink,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求撤销 -100 里机器人自己发的邀请链接。别人发的撤不掉，新的主链接也不在这里",
    });
    expect(JSON.stringify(done)).not.toContain(code);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(code);
    expect(seen).toEqual([{ chatId: "-100", inviteLink: link }]);
    const shaped = await runOperatorCommand({
      event: event({
        text: `/revoke -100 HTTP://WWW.T.ME/+${code}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite(target) {
          seen.push({
            chatId: target.chatId,
            inviteLink: target.inviteLink,
          });
        },
      },
      ...kit(),
    });
    expect(JSON.stringify(shaped)).not.toContain(code);
    expect(seen[1]).toEqual({ chatId: "-100", inviteLink: link });
    const joined = await runOperatorCommand({
      event: event({
        text: `/revoke -100 telegram.dog/joinchat/${code}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite(target) {
          seen.push({
            chatId: target.chatId,
            inviteLink: target.inviteLink,
          });
        },
      },
      ...kit(),
    });
    expect(JSON.stringify(joined)).not.toContain(code);
    expect(seen[2]).toEqual({
      chatId: "-100",
      inviteLink: `https://telegram.dog/joinchat/${code}`,
    });
    const prefixed = await runOperatorCommand({
      event: event({
        text: `/revoke -100 https://joinchat.t.me/${code}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite(target) {
          seen.push({
            chatId: target.chatId,
            inviteLink: target.inviteLink,
          });
        },
      },
      ...kit(),
    });
    expect(JSON.stringify(prefixed)).not.toContain(code);
    expect(seen[3]).toEqual({
      chatId: "-100",
      inviteLink: `https://t.me/joinchat/${code}`,
    });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/revoke <chatId> <inviteLink>");
      expect(help.text).not.toContain(code);
    }
    const english = await runOperatorCommand({
      event: event({ text: `/revoke -100 ${link}`, direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async revokeInvite() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to revoke a bot-created invite link in -100. Other admins' links stay, and a new primary link is not shown here.",
    });
    expect(JSON.stringify(english)).not.toContain(code);
    const skipped = await runOperatorCommand({
      event: event({ text: `/revoke -100 ${link}`, chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite() {
          throw new Error(code);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/revoke -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/revoke <chatId> <inviteLink>",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/revoke -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const phone = await runOperatorCommand({
      event: event({
        text: "/revoke -100 https://t.me/+7999000111222333",
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(phone).toMatchObject({ text: "参数无效" });
    const folder = await runOperatorCommand({
      event: event({
        text: `/revoke -100 https://t.me/addlist/${code}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(folder).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(4);
    const missing = await runOperatorCommand({
      event: event({ text: `/revoke -100 ${link}`, direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(missing)).not.toContain(code);
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: `/revoke -100 ${link}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async revokeInvite() {
          throw new Error(`${phrase} ${code}`);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(hidden)).not.toContain(code);
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain(code);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"revoke"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: `/revoke -200 ${link}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async revokeInvite() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    expect(JSON.stringify(foreign)).not.toContain(code);
  });

  it("unpins every chat pin and leaves the messages", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/unpin -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async unpinChat(target) {
          seen.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求撤下 -100 的全部置顶。消息还在。话题里的置顶不在这次里",
    });
    expect(seen).toEqual(["-100"]);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unpin <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/unpin -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unpinChat() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to clear every pin in -100. The messages stay. Pins inside topics are not part of this call.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/unpin -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unpinChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/unpin", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/unpin <chatId>",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/unpin ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/unpin -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unpin -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"unpin"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/unpin -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unpinChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("lists administrators by id and turned-on rights", async () => {
    const deps = kit();
    const seen: string[] = [];
    const text = [
      "admins -100",
      "42 机器人 创建者 匿名",
      "77 管理员 删除 邀请 置顶",
    ].join("\n");
    const done = await runOperatorCommand({
      event: event({ text: "/admins -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readAdministrators(target) {
          seen.push(target.chatId);
          return [
            {
              actorId: "42",
              bot: true,
              role: "creator",
              anonymous: true,
              rights: [],
            },
            {
              actorId: "77",
              bot: false,
              role: "administrator",
              anonymous: false,
              rights: ["deleteMessages", "inviteUsers", "pinMessages"],
            },
          ];
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text });
    expect(JSON.stringify(done)).not.toContain(phrase);
    expect(seen).toEqual(["-100"]);
    const empty = await runOperatorCommand({
      event: event({ text: "/admins -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readAdministrators() {
          return [];
        },
      },
      ...kit(),
    });
    expect(empty).toMatchObject({ text: "admins -100\nnone" });
    const many = Array.from({ length: 400 }, (_, index) => ({
      actorId: `9${String(index).padStart(5, "0")}`,
      bot: false,
      role: "administrator" as const,
      anonymous: false,
      rights: ["deleteMessages"] as const,
    }));
    const fitted = await runOperatorCommand({
      event: event({ text: "/admins -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readAdministrators() {
          return many;
        },
      },
      ...kit(),
    });
    expect(fitted.status).toBe("reply");
    if (fitted.status === "reply") {
      expect(fitted.text.length).toBeLessThanOrEqual(3500);
      expect(fitted.text).toContain("900000");
      expect(fitted.text).toContain("+");
      expect(fitted.text).not.toContain("900399");
    }
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/admins <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/admins -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readAdministrators() {
          return [
            {
              actorId: "42",
              bot: true,
              role: "creator",
              anonymous: true,
              rights: [],
            },
            {
              actorId: "77",
              bot: false,
              role: "administrator",
              anonymous: false,
              rights: ["deleteMessages", "inviteUsers", "pinMessages"],
            },
          ];
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: [
        "admins -100",
        "42 bot creator anonymous",
        "77 administrator delete invite pin",
      ].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/admins -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readAdministrators() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/admins", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/admins <chatId>" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/admins ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readAdministrators() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/admins -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/admins -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readAdministrators() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"admins"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/admins -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readAdministrators() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("unpins a forum topic and leaves the messages", async () => {
    const deps = kit();
    const seen: { chatId: string; threadId?: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/untopic -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async unpinChat() {
          throw new Error("called");
        },
        async unpinTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求撤下 -100 通用话题的全部置顶。消息还在。其它话题不在这次里",
    });
    expect(seen).toEqual([{ chatId: "-100" }]);
    const topic = await runOperatorCommand({
      event: event({ text: "/untopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...kit(),
    });
    expect(topic).toMatchObject({
      text: "已请求撤下 -100 话题 55 的全部置顶。消息还在",
    });
    expect(seen[1]).toEqual({ chatId: "-100", threadId: "55" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/untopic <chatId> [threadId]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/untopic -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unpinTopic() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to clear every pin in the General topic of -100. The messages stay. Other topics are not part of this call.",
    });
    const englishTopic = await runOperatorCommand({
      event: event({ text: "/untopic -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unpinTopic() {},
      },
      ...kit(),
    });
    expect(englishTopic).toMatchObject({
      text: "Asked to clear every pin in topic 55 of -100. The messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/untopic -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unpinTopic() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/untopic", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/untopic <chatId> [threadId]",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/untopic -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(2);
    const zero = await runOperatorCommand({
      event: event({ text: "/untopic -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/untopic -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/untopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinTopic() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"untopic"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/untopic -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unpinTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("closes a forum topic and leaves the messages", async () => {
    const deps = kit();
    const seen: { chatId: string; threadId?: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/closetopic -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async unpinTopic() {
          throw new Error("called");
        },
        async closeTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求关闭 -100 的通用话题。消息还在。其它话题不在这次里",
    });
    expect(seen).toEqual([{ chatId: "-100" }]);
    const topic = await runOperatorCommand({
      event: event({ text: "/closetopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async closeTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...kit(),
    });
    expect(topic).toMatchObject({
      text: "已请求关闭 -100 话题 55。消息还在",
    });
    expect(seen[1]).toEqual({ chatId: "-100", threadId: "55" });
    const numbered = await runOperatorCommand({
      event: event({ text: "/closetopic -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async closeTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...kit(),
    });
    expect(numbered).toMatchObject({
      text: "已请求关闭 -100 话题 1。消息还在",
    });
    expect(seen[2]).toEqual({ chatId: "-100", threadId: "1" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/closetopic <chatId> [threadId]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/closetopic -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async closeTopic() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to close the General topic of -100. The messages stay. Other topics are not part of this call.",
    });
    const englishTopic = await runOperatorCommand({
      event: event({ text: "/closetopic -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async closeTopic() {},
      },
      ...kit(),
    });
    expect(englishTopic).toMatchObject({
      text: "Asked to close topic 55 of -100. The messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/closetopic -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async closeTopic() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/closetopic", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/closetopic <chatId> [threadId]",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/closetopic -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async closeTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(3);
    const zero = await runOperatorCommand({
      event: event({ text: "/closetopic -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async closeTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/closetopic -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/closetopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async closeTopic() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"closetopic"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/closetopic -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async closeTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reopens a forum topic and leaves the messages", async () => {
    const deps = kit();
    const seen: { chatId: string; threadId?: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/opentopic -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async closeTopic() {
          throw new Error("called");
        },
        async openTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求重新打开 -100 的通用话题。原先隐藏的话会重新显示。消息还在。其它话题不在这次里",
    });
    expect(seen).toEqual([{ chatId: "-100" }]);
    const topic = await runOperatorCommand({
      event: event({ text: "/opentopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async openTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...kit(),
    });
    expect(topic).toMatchObject({
      text: "已请求重新打开 -100 话题 55。消息还在",
    });
    expect(seen[1]).toEqual({ chatId: "-100", threadId: "55" });
    const numbered = await runOperatorCommand({
      event: event({ text: "/opentopic -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async openTopic(target) {
          seen.push(
            target.threadId === undefined
              ? { chatId: target.chatId }
              : { chatId: target.chatId, threadId: target.threadId },
          );
        },
      },
      ...kit(),
    });
    expect(numbered).toMatchObject({
      text: "已请求重新打开 -100 话题 1。消息还在",
    });
    expect(seen[2]).toEqual({ chatId: "-100", threadId: "1" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/opentopic <chatId> [threadId]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/opentopic -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async openTopic() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to reopen the General topic of -100. It is shown again if it was hidden. The messages stay. Other topics are not part of this call.",
    });
    const englishTopic = await runOperatorCommand({
      event: event({ text: "/opentopic -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async openTopic() {},
      },
      ...kit(),
    });
    expect(englishTopic).toMatchObject({
      text: "Asked to reopen topic 55 of -100. The messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/opentopic -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async openTopic() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/opentopic", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/opentopic <chatId> [threadId]",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/opentopic -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async openTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(3);
    const zero = await runOperatorCommand({
      event: event({ text: "/opentopic -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async openTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/opentopic -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/opentopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async openTopic() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"opentopic"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/opentopic -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async openTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("hides the General topic and leaves the messages", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/hidegeneral -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async closeTopic() {
          throw new Error("called");
        },
        async openTopic() {
          throw new Error("called");
        },
        async hideGeneral(target) {
          seen.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求隐藏 -100 的通用话题。原先开着的话会一起关闭。消息还在。其它话题不在这次里",
    });
    expect(seen).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/hidegeneral <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/hidegeneral -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async hideGeneral() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to hide the General topic of -100. An open General topic is closed as well. The messages stay. Other topics are not part of this call.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/hidegeneral -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async hideGeneral() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/hidegeneral", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/hidegeneral <chatId>",
    });
    const extra = await runOperatorCommand({
      event: event({ text: "/hidegeneral -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async hideGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/hidegeneral <chatId>",
    });
    expect(seen).toEqual(["-100"]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/hidegeneral ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async hideGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/hidegeneral -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/hidegeneral -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async hideGeneral() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"hidegeneral"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/hidegeneral -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async hideGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("shows the General topic and leaves it closed", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/showgeneral -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async openTopic() {
          throw new Error("called");
        },
        async hideGeneral() {
          throw new Error("called");
        },
        async showGeneral(target) {
          seen.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求显示 -100 的通用话题。原先关着的话仍然关着。消息还在。其它话题不在这次里",
    });
    expect(seen).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/showgeneral <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/showgeneral -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async showGeneral() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to show the General topic of -100. A closed General topic stays closed. The messages stay. Other topics are not part of this call.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/showgeneral -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async showGeneral() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/showgeneral", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/showgeneral <chatId>",
    });
    const extra = await runOperatorCommand({
      event: event({ text: "/showgeneral -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async showGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/showgeneral <chatId>",
    });
    expect(seen).toEqual(["-100"]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/showgeneral ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async showGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/showgeneral -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/showgeneral -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async showGeneral() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"showgeneral"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/showgeneral -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async showGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("deletes one forum topic and the messages inside it", async () => {
    const deps = kit();
    const seen: { chatId: string; threadId: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/deltopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async deleteMessages() {
          throw new Error("called");
        },
        async deleteTopic(target) {
          seen.push({ chatId: target.chatId, threadId: target.threadId });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求删除 -100 话题 55 和里面的消息。其它话题不在这次里",
    });
    expect(seen).toEqual([{ chatId: "-100", threadId: "55" }]);
    const numbered = await runOperatorCommand({
      event: event({ text: "/deltopic -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteTopic(target) {
          seen.push({ chatId: target.chatId, threadId: target.threadId });
        },
      },
      ...kit(),
    });
    expect(numbered).toMatchObject({
      text: "已请求删除 -100 话题 1 和里面的消息。其它话题不在这次里",
    });
    expect(seen[1]).toEqual({ chatId: "-100", threadId: "1" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/deltopic <chatId> <threadId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/deltopic -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async deleteTopic() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to delete topic 55 of -100 and the messages inside it. Other topics are not part of this call.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/deltopic -100 55", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async deleteTopic() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/deltopic -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/deltopic <chatId> <threadId>",
    });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/deltopic -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const zero = await runOperatorCommand({
      event: event({ text: "/deltopic -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/deltopic -100 55", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/deltopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteTopic() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"deltopic"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/deltopic -200 55", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deleteTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reports a chat member count", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/count -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async readMemberCount(target) {
          seen.push(target.chatId);
          return 42;
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "-100 有 42 人" });
    expect(seen).toEqual(["-100"]);
    const empty = await runOperatorCommand({
      event: event({ text: "/count -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberCount() {
          return 0;
        },
      },
      ...kit(),
    });
    expect(empty).toMatchObject({ text: "-100 有 0 人" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/count <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/count -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readMemberCount() {
          return 42;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "-100 has 42 members" });
    const skipped = await runOperatorCommand({
      event: event({ text: "/count -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberCount() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/count", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/count <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/count -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/count <chatId>" });
    expect(seen).toEqual(["-100"]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/count ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/count -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/count -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberCount() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"count"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/count -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readMemberCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("pins one message and leaves the other pins", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/pin -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async unpinChat() {
          throw new Error("called");
        },
        async pinMessage(target) {
          seen.push(`${target.chatId}:${target.messageId}`);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求置顶 -100 的消息 55。群里可能收到通知。频道和私聊不会。消息还在。其它置顶还在。",
    });
    const one = await runOperatorCommand({
      event: event({ text: "/pin -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async pinMessage(target) {
          seen.push(`${target.chatId}:${target.messageId}`);
        },
      },
      ...kit(),
    });
    expect(one).toMatchObject({
      text: "已请求置顶 -100 的消息 1。群里可能收到通知。频道和私聊不会。消息还在。其它置顶还在。",
    });
    expect(seen).toEqual(["-100:55", "-100:1"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/pin <chatId> <messageId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/pin -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async pinMessage() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to pin message 55 of -100. A group may be notified. Channels and private chats stay quiet. The message stays. The other pins stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/pin -100 55", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async pinMessage() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/pin -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/pin <chatId> <messageId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/pin -100 55 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async pinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/pin <chatId> <messageId>" });
    expect(seen).toEqual(["-100:55", "-100:1"]);
    const invalid = await runOperatorCommand({
      event: event({ text: "/pin -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async pinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    const hiddenText = await runOperatorCommand({
      event: event({ text: `/pin ${phrase} 55`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async pinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(hiddenText).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(hiddenText)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/pin -100 55", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/pin -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async pinMessage() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain('"command":"pin"');
    const foreign = await runOperatorCommand({
      event: event({ text: "/pin -200 55", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async pinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("unpins one message and leaves the other pins", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinChat() {
          throw new Error("called");
        },
        async pinMessage() {
          throw new Error("called");
        },
        async unpinMessage(target) {
          seen.push(`${target.chatId}:${target.messageId}`);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求撤下 -100 的消息 55 的置顶。消息还在。其它置顶还在。",
    });
    const one = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage(target) {
          seen.push(`${target.chatId}:${target.messageId}`);
        },
      },
      ...kit(),
    });
    expect(one).toMatchObject({
      text: "已请求撤下 -100 的消息 1 的置顶。消息还在。其它置顶还在。",
    });
    expect(seen).toEqual(["-100:55", "-100:1"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unpinmsg <chatId> <messageId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async unpinMessage() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to unpin message 55 of -100. The message stays. The other pins stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 55", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/unpinmsg <chatId> <messageId>",
    });
    expect(seen).toEqual(["-100:55", "-100:1"]);
    const extra = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 55 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/unpinmsg <chatId> <messageId>",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    const hiddenText = await runOperatorCommand({
      event: event({ text: `/unpinmsg ${phrase} 55`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(hiddenText).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(hiddenText)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 55", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unpinmsg -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async unpinMessage() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"unpinmsg"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/unpinmsg -200 55", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async unpinMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("removes one actor reaction from one message", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/unreact -100 55 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async clearReactions() {
          throw new Error("called");
        },
        async removeReaction(target) {
          seen.push(
            `${target.chatId}:${target.messageId}:${target.actorId}:${target.kind}`,
          );
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求撤下 77 在 -100 消息 55 上的反应。别人的反应还在。其它消息上的反应还在。",
    });
    const chatActor = await runOperatorCommand({
      event: event({ text: "/unreact -100 1 -1005", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction(target) {
          seen.push(
            `${target.chatId}:${target.messageId}:${target.actorId}:${target.kind}`,
          );
        },
      },
      ...kit(),
    });
    expect(chatActor).toMatchObject({
      text: "已请求撤下 -1005 在 -100 消息 1 上的反应。别人的反应还在。其它消息上的反应还在。",
    });
    expect(seen).toEqual(["-100:55:77:user", "-100:1:-1005:chat"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/unreact <chatId> <messageId> <actorId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/unreact -100 55 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async removeReaction() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to remove the reaction of 77 on message 55 of -100. Other people's reactions stay. Reactions on other messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/unreact -100 55 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/unreact -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/unreact <chatId> <messageId> <actorId>",
    });
    expect(seen).toEqual(["-100:55:77:user", "-100:1:-1005:chat"]);
    const extra = await runOperatorCommand({
      event: event({ text: "/unreact -100 55 77 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/unreact <chatId> <messageId> <actorId>",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: "/unreact -100 01 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    const hiddenText = await runOperatorCommand({
      event: event({ text: `/unreact ${phrase} 55 77`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(hiddenText).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(hiddenText)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/unreact -100 55 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/unreact -100 55 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async removeReaction() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"unreact"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/unreact -200 55 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async removeReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("deletes a chat photo and leaves the title", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/delphoto -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deletePhoto(target) {
          seen.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求删除 -100 的头像。标题和简介还在。",
    });
    expect(seen).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/delphoto <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/delphoto -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async deletePhoto() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to delete the photo of -100. The title and description stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/delphoto -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async deletePhoto() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/delphoto", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/delphoto <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/delphoto -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deletePhoto() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/delphoto <chatId>" });
    expect(seen).toEqual(["-100"]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/delphoto ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deletePhoto() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/delphoto -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/delphoto -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deletePhoto() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"delphoto"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/delphoto -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deletePhoto() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("asks the bot to leave a chat and keeps the messages", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/leave -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async leaveChat(target) {
          seen.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求退出 -100。之后这个 bot 不再处理它。消息还在。",
    });
    expect(seen).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/leave <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/leave -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async leaveChat() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to leave -100. This bot stops handling it. The messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/leave -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async leaveChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/leave", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/leave <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/leave -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async leaveChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/leave <chatId>" });
    expect(seen).toEqual(["-100"]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/leave ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async leaveChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/leave -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/leave -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async leaveChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"leave"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/leave -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async leaveChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("sets a member tag and keeps the name", async () => {
    const deps = kit();
    const seen: { chatId: string; actorId: string; tag: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/tag -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag(target) {
          seen.push({
            chatId: target.chatId,
            actorId: target.actorId,
            tag: target.tag,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求设置 -100 里 77 的标签。名字还在。",
    });
    expect(JSON.stringify(done)).not.toContain("ops");
    expect(seen).toEqual([{ chatId: "-100", actorId: "77", tag: "ops" }]);
    const spaced = await runOperatorCommand({
      event: event({ text: "/tag -100 77 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag(target) {
          seen.push({
            chatId: target.chatId,
            actorId: target.actorId,
            tag: target.tag,
          });
        },
      },
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求设置 -100 里 77 的标签。名字还在。",
    });
    expect(seen[1]).toEqual({
      chatId: "-100",
      actorId: "77",
      tag: "hello world",
    });
    const cleared = await runOperatorCommand({
      event: event({ text: "/tag -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag(target) {
          seen.push({
            chatId: target.chatId,
            actorId: target.actorId,
            tag: target.tag,
          });
        },
      },
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉 -100 里 77 的标签。名字还在。",
    });
    expect(seen[2]?.tag).toBe("");
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/tag <chatId> <userId> [tag]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/tag -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setMemberTag() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set the tag of 77 in -100. The name stays.",
    });
    expect(JSON.stringify(english)).not.toContain("ops");
    const englishClear = await runOperatorCommand({
      event: event({ text: "/tag -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setMemberTag() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear the tag of 77 in -100. The name stays.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/tag -100 77 ops", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/tag", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/tag <chatId> <userId> [tag]",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/tag -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/tag <chatId> <userId> [tag]",
    });
    const exact = "a".repeat(16);
    const fitted = await runOperatorCommand({
      event: event({ text: `/tag -100 77 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag(target) {
          seen.push({
            chatId: target.chatId,
            actorId: target.actorId,
            tag: target.tag,
          });
        },
      },
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求设置 -100 里 77 的标签。名字还在。",
    });
    expect(seen[3]?.tag).toBe(exact);
    const tooLong = "a".repeat(17);
    const overflow = await runOperatorCommand({
      event: event({ text: `/tag -100 77 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(4);
    const hiddenTag = await runOperatorCommand({
      event: event({ text: `/tag -100 77 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag(target) {
          seen.push({
            chatId: target.chatId,
            actorId: target.actorId,
            tag: target.tag,
          });
        },
      },
      ...kit(),
    });
    expect(hiddenTag).toMatchObject({
      text: "已请求设置 -100 里 77 的标签。名字还在。",
    });
    expect(JSON.stringify(hiddenTag)).not.toContain(phrase);
    expect(seen[4]?.tag).toBe(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/tag ${phrase} 77 ops`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/tag -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/tag -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMemberTag() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain("ops");
    expect(JSON.stringify(failed.logger.entries)).toContain('"command":"tag"');
    const foreign = await runOperatorCommand({
      event: event({ text: "/tag -200 77 ops", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setMemberTag() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("deletes a group sticker set and keeps the messages", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/delstickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteStickerSet(target) {
          seen.push(target.chatId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求删除 -100 的群贴纸包。消息还在。",
    });
    expect(seen).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/delstickers <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/delstickers -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async deleteStickerSet() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to delete the group sticker set of -100. The messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/delstickers -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async deleteStickerSet() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/delstickers", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/delstickers <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/delstickers -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/delstickers <chatId>" });
    expect(seen).toEqual(["-100"]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/delstickers ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/delstickers -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/delstickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteStickerSet() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"delstickers"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/delstickers -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deleteStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reports a boost count and drops the booster name", async () => {
    const deps = kit();
    const seen: { chatId: string; actorId: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/boosts -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount(target) {
          seen.push({ chatId: target.chatId, actorId: target.actorId });
          return 2;
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "77 在 -100 有 2 次助推" });
    expect(JSON.stringify(done)).not.toContain(phrase);
    expect(seen).toEqual([{ chatId: "-100", actorId: "77" }]);
    const zero = await runOperatorCommand({
      event: event({ text: "/boosts -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount() {
          return 0;
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "77 在 -100 有 0 次助推" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/boosts <chatId> <userId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/boosts -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBoostCount() {
          return 2;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "77 has 2 boosts in -100" });
    const skipped = await runOperatorCommand({
      event: event({ text: "/boosts -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/boosts", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/boosts <chatId> <userId>" });
    const short = await runOperatorCommand({
      event: event({ text: "/boosts -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({ text: "用法：/boosts <chatId> <userId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/boosts -100 77 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/boosts <chatId> <userId>" });
    expect(seen).toEqual([{ chatId: "-100", actorId: "77" }]);
    const invalid = await runOperatorCommand({
      event: event({ text: `/boosts ${phrase} 77`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/boosts -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/boosts -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBoostCount() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"boosts"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/boosts -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBoostCount() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("sets one emoji reaction and keeps other people's reactions", async () => {
    const deps = kit();
    const seen: { chatId: string; messageId: string; emoji: string }[] = [];
    const remember = {
      async setReaction(target: {
        chatId: string;
        messageId: string;
        emoji: string;
      }) {
        seen.push({
          chatId: target.chatId,
          messageId: target.messageId,
          emoji: target.emoji,
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/react -100 55 👍", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求在 -100 的消息 55 上设置 👍。别人的反应还在。一组媒体里会落到还在的第一条。",
    });
    expect(seen).toEqual([{ chatId: "-100", messageId: "55", emoji: "👍" }]);
    const first = await runOperatorCommand({
      event: event({ text: "/react -100 1 ❤", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(first).toMatchObject({
      text: "已请求在 -100 的消息 1 上设置 ❤。别人的反应还在。一组媒体里会落到还在的第一条。",
    });
    expect(seen[1]).toEqual({ chatId: "-100", messageId: "1", emoji: "❤" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/react <chatId> <messageId> <emoji>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/react -100 55 👍", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setReaction() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set 👍 on message 55 of -100. Other people's reactions stay. A media group uses the first message that is still there.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/react -100 55 👍", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/react -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/react <chatId> <messageId> <emoji>",
    });
    const extra = await runOperatorCommand({
      event: event({ text: "/react -100 55 👍 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/react <chatId> <messageId> <emoji>",
    });
    expect(seen).toHaveLength(2);
    const styled = await runOperatorCommand({
      event: event({ text: "/react -100 55 \u2764\uFE0F", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(styled).toMatchObject({ text: "参数无效" });
    const zero = await runOperatorCommand({
      event: event({ text: "/react -100 01 👍", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "参数无效" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/react -100 55 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/react -100 55 👍", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/react -100 55 👍", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setReaction() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain("👍");
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"react"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/react -200 55 👍", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setReaction() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("changes a chat title and keeps the description", async () => {
    const deps = kit();
    const seen: { chatId: string; title: string }[] = [];
    const remember = {
      async setTitle(target: { chatId: string; title: string }) {
        seen.push({ chatId: target.chatId, title: target.title });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/title -100 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求修改 -100 的标题。简介和头像还在。",
    });
    expect(JSON.stringify(done)).not.toContain("hello");
    expect(seen).toEqual([{ chatId: "-100", title: "hello" }]);
    const spaced = await runOperatorCommand({
      event: event({ text: "/title -100 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求修改 -100 的标题。简介和头像还在。",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[1]).toEqual({ chatId: "-100", title: "hello world" });
    const positive = await runOperatorCommand({
      event: event({ text: "/title 42 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求修改 42 的标题。简介和头像还在。",
    });
    expect(seen[2]).toEqual({ chatId: "42", title: "hello" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/title <chatId> <title>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/title -100 hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setTitle() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to change the title of -100. The description and photo stay.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const skipped = await runOperatorCommand({
      event: event({ text: "/title -100 hello", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setTitle() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/title", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/title <chatId> <title>" });
    const short = await runOperatorCommand({
      event: event({ text: "/title -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({ text: "用法：/title <chatId> <title>" });
    const exact = "a".repeat(128);
    const fitted = await runOperatorCommand({
      event: event({ text: `/title -100 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求修改 -100 的标题。简介和头像还在。",
    });
    expect(seen[3]?.title).toBe(exact);
    const tooLong = "a".repeat(129);
    const overflow = await runOperatorCommand({
      event: event({ text: `/title -100 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(4);
    const hidden = await runOperatorCommand({
      event: event({ text: `/title -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(hidden).toMatchObject({
      text: "已请求修改 -100 的标题。简介和头像还在。",
    });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen[4]?.title).toBe(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/title ${phrase} hello`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/title -100 hello", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/title -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setTitle() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"title"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/title -200 hello", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("changes a chat description and keeps the title", async () => {
    const deps = kit();
    const seen: { chatId: string; description: string }[] = [];
    const remember = {
      async setDescription(target: { chatId: string; description: string }) {
        seen.push({
          chatId: target.chatId,
          description: target.description,
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/desc -100 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求修改 -100 的简介。标题和头像还在。",
    });
    expect(JSON.stringify(done)).not.toContain("hello");
    expect(seen).toEqual([{ chatId: "-100", description: "hello" }]);
    const spaced = await runOperatorCommand({
      event: event({ text: "/desc -100 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求修改 -100 的简介。标题和头像还在。",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[1]).toEqual({
      chatId: "-100",
      description: "hello world",
    });
    const cleared = await runOperatorCommand({
      event: event({ text: "/desc -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉 -100 的简介。标题和头像还在。",
    });
    expect(seen[2]).toEqual({ chatId: "-100", description: "" });
    const positive = await runOperatorCommand({
      event: event({ text: "/desc 42 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求修改 42 的简介。标题和头像还在。",
    });
    expect(seen[3]).toEqual({ chatId: "42", description: "hello" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/desc <chatId> [description]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/desc -100 hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setDescription() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to change the description of -100. The title and photo stay.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const englishClear = await runOperatorCommand({
      event: event({ text: "/desc -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setDescription() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear the description of -100. The title and photo stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/desc -100 hello", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setDescription() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/desc", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/desc <chatId> [description]",
    });
    const exact = "a".repeat(255);
    const fitted = await runOperatorCommand({
      event: event({ text: `/desc -100 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求修改 -100 的简介。标题和头像还在。",
    });
    expect(seen[4]?.description).toBe(exact);
    const tooLong = "a".repeat(256);
    const overflow = await runOperatorCommand({
      event: event({ text: `/desc -100 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(5);
    const hidden = await runOperatorCommand({
      event: event({ text: `/desc -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(hidden).toMatchObject({
      text: "已请求修改 -100 的简介。标题和头像还在。",
    });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen[5]?.description).toBe(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/desc ${phrase} hello`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/desc -100 hello", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/desc -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDescription() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain('"command":"desc"');
    const foreign = await runOperatorCommand({
      event: event({ text: "/desc -200 hello", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("creates one forum topic and keeps the name out of the reply", async () => {
    const deps = kit();
    const seen: { chatId: string; name: string }[] = [];
    const remember = {
      async createTopic(target: { chatId: string; name: string }) {
        seen.push({ chatId: target.chatId, name: target.name });
        return String(seen.length);
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/newtopic -100 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已在 -100 建好话题 1。其它话题还在。",
    });
    expect(JSON.stringify(done)).not.toContain("hello");
    expect(seen).toEqual([{ chatId: "-100", name: "hello" }]);
    const spaced = await runOperatorCommand({
      event: event({ text: "/newtopic -100 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已在 -100 建好话题 2。其它话题还在。",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[1]).toEqual({ chatId: "-100", name: "hello world" });
    const positive = await runOperatorCommand({
      event: event({ text: "/newtopic 42 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已在 42 建好话题 3。其它话题还在。",
    });
    expect(seen[2]).toEqual({ chatId: "42", name: "hello" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/newtopic <chatId> <name>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/newtopic -100 hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async createTopic() {
          return "9";
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Created topic 9 in -100. The other topics stay.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const skipped = await runOperatorCommand({
      event: event({ text: "/newtopic -100 hello", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async createTopic() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/newtopic", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/newtopic <chatId> <name>" });
    const short = await runOperatorCommand({
      event: event({ text: "/newtopic -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async createTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({ text: "用法：/newtopic <chatId> <name>" });
    const exact = "a".repeat(128);
    const fitted = await runOperatorCommand({
      event: event({ text: `/newtopic -100 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已在 -100 建好话题 4。其它话题还在。",
    });
    expect(JSON.stringify(fitted)).not.toContain(exact);
    expect(seen[3]?.name).toBe(exact);
    const tooLong = "a".repeat(129);
    const overflow = await runOperatorCommand({
      event: event({ text: `/newtopic -100 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async createTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(4);
    const hidden = await runOperatorCommand({
      event: event({ text: `/newtopic -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(hidden).toMatchObject({
      text: "已在 -100 建好话题 5。其它话题还在。",
    });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen[4]?.name).toBe(phrase);
    const leaked = await runOperatorCommand({
      event: event({ text: "/newtopic -100 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async createTopic() {
          return phrase;
        },
      },
      ...kit(),
    });
    expect(leaked).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(leaked)).not.toContain(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/newtopic ${phrase} hello`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async createTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/newtopic -100 hello", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/newtopic -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async createTopic() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"newtopic"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/newtopic -200 hello",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async createTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("renames one forum topic and keeps the name out of the reply", async () => {
    const deps = kit();
    const seen: { chatId: string; threadId: string; name: string }[] = [];
    const remember = {
      async renameTopic(target: {
        chatId: string;
        threadId: string;
        name: string;
      }) {
        seen.push({
          chatId: target.chatId,
          threadId: target.threadId,
          name: target.name,
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/rentopic -100 55 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求修改 -100 里话题 55 的名字。消息还在。其它话题还在。",
    });
    expect(JSON.stringify(done)).not.toContain("hello");
    expect(seen).toEqual([{ chatId: "-100", threadId: "55", name: "hello" }]);
    const first = await runOperatorCommand({
      event: event({ text: "/rentopic -100 1 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(first).toMatchObject({
      text: "已请求修改 -100 里话题 1 的名字。消息还在。其它话题还在。",
    });
    expect(seen[1]).toEqual({ chatId: "-100", threadId: "1", name: "hello" });
    const spaced = await runOperatorCommand({
      event: event({ text: "/rentopic -100 55 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求修改 -100 里话题 55 的名字。消息还在。其它话题还在。",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[2]).toEqual({
      chatId: "-100",
      threadId: "55",
      name: "hello world",
    });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/rentopic <chatId> <threadId> <name>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/rentopic -100 55 hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async renameTopic() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to change the name of topic 55 in -100. The messages stay. The other topics stay.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const skipped = await runOperatorCommand({
      event: event({ text: "/rentopic -100 55 hello", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async renameTopic() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/rentopic", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/rentopic <chatId> <threadId> <name>",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/rentopic -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/rentopic <chatId> <threadId> <name>",
    });
    const exact = "a".repeat(128);
    const fitted = await runOperatorCommand({
      event: event({ text: `/rentopic -100 55 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求修改 -100 里话题 55 的名字。消息还在。其它话题还在。",
    });
    expect(JSON.stringify(fitted)).not.toContain(exact);
    expect(seen[3]?.name).toBe(exact);
    const tooLong = "a".repeat(129);
    const overflow = await runOperatorCommand({
      event: event({ text: `/rentopic -100 55 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(4);
    const zero = await runOperatorCommand({
      event: event({ text: "/rentopic -100 01 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(zero).toMatchObject({ text: "参数无效" });
    const hidden = await runOperatorCommand({
      event: event({ text: `/rentopic -100 55 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(hidden).toMatchObject({
      text: "已请求修改 -100 里话题 55 的名字。消息还在。其它话题还在。",
    });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen[4]?.name).toBe(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/rentopic ${phrase} 55 hello`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/rentopic -100 55 hello", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/rentopic -100 55 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameTopic() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"rentopic"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/rentopic -200 55 hello",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async renameTopic() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("renames the General topic and keeps the name out of the reply", async () => {
    const deps = kit();
    const seen: { chatId: string; name: string }[] = [];
    const remember = {
      async renameGeneral(target: { chatId: string; name: string }) {
        seen.push({ chatId: target.chatId, name: target.name });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/rengeneral -100 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求修改 -100 的通用话题名字。其它话题还在。消息还在。",
    });
    expect(JSON.stringify(done)).not.toContain("hello");
    expect(seen).toEqual([{ chatId: "-100", name: "hello" }]);
    const spaced = await runOperatorCommand({
      event: event({ text: "/rengeneral -100 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求修改 -100 的通用话题名字。其它话题还在。消息还在。",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[1]).toEqual({ chatId: "-100", name: "hello world" });
    const positive = await runOperatorCommand({
      event: event({ text: "/rengeneral 42 hello", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求修改 42 的通用话题名字。其它话题还在。消息还在。",
    });
    expect(seen[2]).toEqual({ chatId: "42", name: "hello" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/rengeneral <chatId> <name>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/rengeneral -100 hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async renameGeneral() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to change the General topic name of -100. The other topics stay. The messages stay.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const skipped = await runOperatorCommand({
      event: event({ text: "/rengeneral -100 hello", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async renameGeneral() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/rengeneral", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/rengeneral <chatId> <name>",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/rengeneral -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/rengeneral <chatId> <name>",
    });
    const exact = "a".repeat(128);
    const fitted = await runOperatorCommand({
      event: event({ text: `/rengeneral -100 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求修改 -100 的通用话题名字。其它话题还在。消息还在。",
    });
    expect(JSON.stringify(fitted)).not.toContain(exact);
    expect(seen[3]?.name).toBe(exact);
    const tooLong = "a".repeat(129);
    const overflow = await runOperatorCommand({
      event: event({ text: `/rengeneral -100 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(4);
    const hidden = await runOperatorCommand({
      event: event({ text: `/rengeneral -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(hidden).toMatchObject({
      text: "已请求修改 -100 的通用话题名字。其它话题还在。消息还在。",
    });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen[4]?.name).toBe(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/rengeneral ${phrase} hello`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/rengeneral -100 hello", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/rengeneral -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async renameGeneral() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"rengeneral"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/rengeneral -200 hello",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async renameGeneral() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("sets a group sticker set and keeps the name out of the reply", async () => {
    const deps = kit();
    const seen: { chatId: string; name: string }[] = [];
    const remember = {
      async setStickerSet(target: { chatId: string; name: string }) {
        seen.push({ chatId: target.chatId, name: target.name });
      },
    };
    const name = "Animals_by_SomeBot";
    const done = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${name}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求设置 -100 的群贴纸包。消息还在。",
    });
    expect(JSON.stringify(done)).not.toContain(name);
    expect(seen).toEqual([{ chatId: "-100", name }]);
    const lower = "animals_by_somebot";
    const folded = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${lower}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(folded).toMatchObject({
      text: "已请求设置 -100 的群贴纸包。消息还在。",
    });
    expect(JSON.stringify(folded)).not.toContain(lower);
    expect(seen[1]).toEqual({ chatId: "-100", name: lower });
    const positive = await runOperatorCommand({
      event: event({ text: `/stickers 42 ${name}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求设置 42 的群贴纸包。消息还在。",
    });
    expect(seen[2]).toEqual({ chatId: "42", name });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/stickers <chatId> <name>");
    }
    const english = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${name}`, direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setStickerSet() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set the group sticker set of -100. The messages stay.",
    });
    expect(JSON.stringify(english)).not.toContain(name);
    const skipped = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${name}`, chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/stickers", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/stickers <chatId> <name>",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/stickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/stickers <chatId> <name>",
    });
    const extra = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${name} extra`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/stickers <chatId> <name>",
    });
    const username = `C${"d".repeat(28)}bot`;
    const exact = `A${"b".repeat(27)}_by_${username}`;
    const fitted = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求设置 -100 的群贴纸包。消息还在。",
    });
    expect(JSON.stringify(fitted)).not.toContain(exact);
    expect(seen[3]?.name).toBe(exact);
    const tooLong = `A${"b".repeat(28)}_by_${username}`;
    const overflow = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(4);
    const doubled = "Animals__by_SomeBot";
    const gap = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${doubled}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(gap).toMatchObject({ text: "参数无效" });
    const digit = "A_by_1bot";
    const numbered = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${digit}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(numbered).toMatchObject({ text: "参数无效" });
    const plain = "Animals_by_Some";
    const unfinished = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${plain}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(unfinished).toMatchObject({ text: "参数无效" });
    const longUser = `A_by_C${"d".repeat(29)}bot`;
    const longOwner = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${longUser}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(longOwner).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(4);
    const hidden = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen).toHaveLength(4);
    const invalid = await runOperatorCommand({
      event: event({ text: `/stickers ${phrase} ${name}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${name}`, direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/stickers -100 ${name}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setStickerSet() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain(name);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"stickers"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: `/stickers -200 ${name}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setStickerSet() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("sets an admin title and keeps the title out of the reply", async () => {
    const deps = kit();
    const seen: { chatId: string; actorId: string; title: string }[] = [];
    const remember = {
      async setAdminTitle(target: {
        chatId: string;
        actorId: string;
        title: string;
      }) {
        seen.push({
          chatId: target.chatId,
          actorId: target.actorId,
          title: target.title,
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求设置 -100 里 77 的管理员头衔。权限还在。",
    });
    expect(JSON.stringify(done)).not.toContain("ops");
    expect(seen).toEqual([{ chatId: "-100", actorId: "77", title: "ops" }]);
    const spaced = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 hello world", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求设置 -100 里 77 的管理员头衔。权限还在。",
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[1]).toEqual({
      chatId: "-100",
      actorId: "77",
      title: "hello world",
    });
    const positive = await runOperatorCommand({
      event: event({ text: "/admintitle 42 77 ops", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求设置 42 里 77 的管理员头衔。权限还在。",
    });
    expect(seen[2]).toEqual({ chatId: "42", actorId: "77", title: "ops" });
    const cleared = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉 -100 里 77 的管理员头衔。权限还在。",
    });
    expect(seen[3]).toEqual({ chatId: "-100", actorId: "77", title: "" });
    const emoji = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 👍", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(emoji).toMatchObject({
      text: "已请求设置 -100 里 77 的管理员头衔。权限还在。",
    });
    expect(JSON.stringify(emoji)).not.toContain("👍");
    expect(seen[4]).toEqual({ chatId: "-100", actorId: "77", title: "👍" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/admintitle <chatId> <userId> [title]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setAdminTitle() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set the admin title of 77 in -100. The privileges stay.",
    });
    expect(JSON.stringify(english)).not.toContain("ops");
    const englishClear = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setAdminTitle() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear the admin title of 77 in -100. The privileges stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 ops", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setAdminTitle() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/admintitle", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/admintitle <chatId> <userId> [title]",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/admintitle -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setAdminTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/admintitle <chatId> <userId> [title]",
    });
    const exact = "a".repeat(16);
    const fitted = await runOperatorCommand({
      event: event({ text: `/admintitle -100 77 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求设置 -100 里 77 的管理员头衔。权限还在。",
    });
    expect(JSON.stringify(fitted)).not.toContain(exact);
    expect(seen[5]?.title).toBe(exact);
    const tooLong = "a".repeat(17);
    const overflow = await runOperatorCommand({
      event: event({ text: `/admintitle -100 77 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setAdminTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(6);
    const hidden = await runOperatorCommand({
      event: event({ text: `/admintitle -100 77 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(hidden).toMatchObject({
      text: "已请求设置 -100 里 77 的管理员头衔。权限还在。",
    });
    expect(JSON.stringify(hidden)).not.toContain(phrase);
    expect(seen[6]?.title).toBe(phrase);
    const invalid = await runOperatorCommand({
      event: event({ text: `/admintitle ${phrase} 77 ops`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setAdminTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/admintitle -100 77 ops", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setAdminTitle() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain("ops");
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"admintitle"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/admintitle -200 77 ops",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setAdminTitle() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("declines one suggested post and keeps the comment out of the reply", async () => {
    const deps = kit();
    const seen: {
      chatId: string;
      messageId: string;
      comment?: string;
    }[] = [];
    const remember = {
      async declinePost(target: {
        chatId: string;
        messageId: string;
        comment?: string;
      }) {
        seen.push(
          target.comment === undefined
            ? { chatId: target.chatId, messageId: target.messageId }
            : {
                chatId: target.chatId,
                messageId: target.messageId,
                comment: target.comment,
              },
        );
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/declinepost -100 55", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求拒绝 -100 的建议帖 55。这条不会发出。其它建议帖还在。",
    });
    expect(seen).toEqual([{ chatId: "-100", messageId: "55" }]);
    expect(JSON.stringify(seen[0])).not.toContain("comment");
    const noted = await runOperatorCommand({
      event: event({ text: `/declinepost -100 55 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(noted).toMatchObject({
      text: "已请求拒绝 -100 的建议帖 55。这条不会发出。其它建议帖还在。",
    });
    expect(JSON.stringify(noted)).not.toContain(phrase);
    expect(seen[1]).toEqual({
      chatId: "-100",
      messageId: "55",
      comment: phrase,
    });
    const spaced = await runOperatorCommand({
      event: event({
        text: "/declinepost -100 55 hello world",
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(JSON.stringify(spaced)).not.toContain("hello");
    expect(seen[2]).toEqual({
      chatId: "-100",
      messageId: "55",
      comment: "hello world",
    });
    const first = await runOperatorCommand({
      event: event({ text: "/declinepost -100 1", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(first).toMatchObject({
      text: "已请求拒绝 -100 的建议帖 1。这条不会发出。其它建议帖还在。",
    });
    expect(seen[3]).toEqual({ chatId: "-100", messageId: "1" });
    const positive = await runOperatorCommand({
      event: event({ text: "/declinepost 42 55", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求拒绝 42 的建议帖 55。这条不会发出。其它建议帖还在。",
    });
    expect(seen[4]).toEqual({ chatId: "42", messageId: "55" });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain(
        "/declinepost <chatId> <messageId> [comment]",
      );
    }
    const english = await runOperatorCommand({
      event: event({ text: "/declinepost -100 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async declinePost() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to decline suggested post 55 in -100. This post stays unpublished. The other suggested posts stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/declinepost -100 55", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async declinePost() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/declinepost", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/declinepost <chatId> <messageId> [comment]",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/declinepost -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declinePost() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/declinepost <chatId> <messageId> [comment]",
    });
    const leading = await runOperatorCommand({
      event: event({ text: "/declinepost -100 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declinePost() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(leading).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(5);
    const exact = "a".repeat(128);
    const fitted = await runOperatorCommand({
      event: event({ text: `/declinepost -100 55 ${exact}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(fitted).toMatchObject({
      text: "已请求拒绝 -100 的建议帖 55。这条不会发出。其它建议帖还在。",
    });
    expect(JSON.stringify(fitted)).not.toContain(exact);
    expect(seen[5]?.comment).toBe(exact);
    const tooLong = "a".repeat(129);
    const overflow = await runOperatorCommand({
      event: event({ text: `/declinepost -100 55 ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declinePost() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(overflow).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(overflow)).not.toContain(tooLong);
    expect(seen).toHaveLength(6);
    const invalid = await runOperatorCommand({
      event: event({ text: `/declinepost ${phrase} 55`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declinePost() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/declinepost -100 55", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/declinepost -100 55 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async declinePost() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"declinepost"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/declinepost -200 55",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async declinePost() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("deletes one ephemeral message for one recipient", async () => {
    const deps = kit();
    const seen: {
      chatId: string;
      messageId: string;
      audienceId?: string;
    }[] = [];
    const remember = {
      async deleteMessage(target: {
        chatId: string;
        messageId: string;
        audienceId?: string;
      }) {
        seen.push({
          chatId: target.chatId,
          messageId: target.messageId,
          ...(target.audienceId === undefined
            ? {}
            : { audienceId: target.audienceId }),
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 55", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求删除 -100 里发给 77 的临时消息 55。对方离线时可能收不到这次删除。其它消息还在。",
    });
    expect(seen).toEqual([
      { chatId: "-100", messageId: "55", audienceId: "77" },
    ]);
    expect(seen[0]).not.toHaveProperty("actorId");
    const first = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 1", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(first).toMatchObject({
      text: "已请求删除 -100 里发给 77 的临时消息 1。对方离线时可能收不到这次删除。其它消息还在。",
    });
    expect(seen[1]).toEqual({
      chatId: "-100",
      messageId: "1",
      audienceId: "77",
    });
    const positive = await runOperatorCommand({
      event: event({ text: "/delephemeral 42 77 55", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(positive).toMatchObject({
      text: "已请求删除 42 里发给 77 的临时消息 55。对方离线时可能收不到这次删除。其它消息还在。",
    });
    expect(seen[2]).toEqual({
      chatId: "42",
      messageId: "55",
      audienceId: "77",
    });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain(
        "/delephemeral <chatId> <userId> <messageId>",
      );
    }
    const english = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 55", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async deleteMessage() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to delete ephemeral message 55 sent to 77 in -100. An offline recipient may not see the deletion. The other messages stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 55", chatId: "-100" }),
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
      event: event({ text: "/delephemeral", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/delephemeral <chatId> <userId> <messageId>",
    });
    const short = await runOperatorCommand({
      event: event({ text: "/delephemeral -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({
      text: "用法：/delephemeral <chatId> <userId> <messageId>",
    });
    const extra = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 55 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/delephemeral <chatId> <userId> <messageId>",
    });
    expect(seen).toHaveLength(3);
    const leading = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 01", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(leading).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/delephemeral ${phrase} 77 55`, direct: true }),
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
    const missing = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 55", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/delephemeral -100 77 55", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"delephemeral"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/delephemeral -200 77 55",
        direct: true,
        actorId: "7",
      }),
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

  it("sets this bot's default administrator rights", async () => {
    const deps = kit();
    const seen: {
      forChannels: boolean;
      rights?: DefaultAdministratorRights;
    }[] = [];
    const remember = {
      async setDefaultRights(target: DefaultRightsTarget) {
        seen.push(
          target.rights === undefined
            ? { forChannels: target.forChannels }
            : { forChannels: target.forChannels, rights: { ...target.rights } },
        );
      },
    };
    const off = {
      anonymous: false,
      manageChat: false,
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
    };
    const done = await runOperatorCommand({
      event: event({
        text: "/myrights manage_chat delete_messages",
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求设置这个 bot 在群和超级群里的默认管理员权限。加入时仍可修改。已有群不受影响。",
    });
    expect(JSON.stringify(done)).not.toContain("manage_chat");
    expect(seen).toEqual([
      {
        forChannels: false,
        rights: { ...off, manageChat: true, deleteMessages: true },
      },
    ]);
    expect(seen[0]).not.toHaveProperty("chatId");
    const channels = await runOperatorCommand({
      event: event({
        text: "/myrights channels post_messages anonymous",
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(channels).toMatchObject({
      text: "已请求设置这个 bot 在频道里的默认管理员权限。加入时仍可修改。已有频道不受影响。",
    });
    expect(seen[1]).toEqual({
      forChannels: true,
      rights: { ...off, anonymous: true, postMessages: true },
    });
    const cleared = await runOperatorCommand({
      event: event({ text: "/myrights clear", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉这个 bot 在群和超级群里的默认管理员权限。已有群不受影响。",
    });
    expect(seen[2]).toEqual({ forChannels: false });
    expect(JSON.stringify(seen[2])).not.toContain("rights");
    const clearedChannels = await runOperatorCommand({
      event: event({ text: "/myrights channels clear", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(clearedChannels).toMatchObject({
      text: "已请求清掉这个 bot 在频道里的默认管理员权限。已有频道不受影响。",
    });
    expect(seen[3]).toEqual({ forChannels: true });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/myrights [channels] <clear|right...>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/myrights manage_chat", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setDefaultRights() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set this bot's default admin rights for groups and supergroups. People can still change the list before adding the bot. Existing groups stay.",
    });
    const englishClear = await runOperatorCommand({
      event: event({ text: "/myrights channels clear", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setDefaultRights() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear this bot's default admin rights for channels. Existing channels stay.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/myrights clear", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setDefaultRights() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/myrights", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/myrights [channels] <clear|right...>",
    });
    const bareChannels = await runOperatorCommand({
      event: event({ text: "/myrights channels", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(bareChannels).toMatchObject({
      text: "用法：/myrights [channels] <clear|right...>",
    });
    expect(seen).toHaveLength(4);
    const mixed = await runOperatorCommand({
      event: event({ text: "/myrights clear manage_chat", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(mixed).toMatchObject({ text: "参数无效" });
    const duplicate = await runOperatorCommand({
      event: event({
        text: "/myrights manage_chat manage_chat",
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async setDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(duplicate).toMatchObject({ text: "参数无效" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/myrights ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(4);
    const missing = await runOperatorCommand({
      event: event({ text: "/myrights clear", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/myrights clear", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setDefaultRights() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"myrights"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/myrights clear",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reads this bot's default administrator rights", async () => {
    const deps = kit();
    const seen: { forChannels: boolean }[] = [];
    const off = {
      anonymous: "off",
      manageChat: "off",
      deleteMessages: "off",
      manageVideoChats: "off",
      restrictMembers: "off",
      promoteMembers: "off",
      changeInfo: "off",
      inviteUsers: "off",
      postStories: "off",
      editStories: "off",
      deleteStories: "off",
      postMessages: "off",
      editMessages: "off",
      pinMessages: "off",
      manageTopics: "off",
      manageDirectMessages: "off",
      manageTags: "off",
      sendWelcomeMessages: "off",
    } as const;
    const remember = {
      async readDefaultRights(
        target: DefaultRightsQuery,
      ): Promise<DefaultRightsSnapshot> {
        seen.push({ forChannels: target.forChannels });
        if (target.forChannels) {
          return { ...off, postMessages: "on" };
        }
        return {
          ...off,
          anonymous: "unknown",
          manageChat: "on",
        };
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/botrights", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: [
        "botrights 群",
        "匿名 未知",
        "管理 on",
        "删除 off",
        "视频 off",
        "限制 off",
        "提升 off",
        "资料 off",
        "邀请 off",
        "故事 off",
        "改故事 off",
        "删故事 off",
        "发帖 off",
        "编辑 off",
        "置顶 off",
        "话题 off",
        "私信 off",
        "标签 off",
        "欢迎 off",
      ].join("\n"),
    });
    expect(seen).toEqual([{ forChannels: false }]);
    expect(seen[0]).not.toHaveProperty("chatId");
    expect(JSON.stringify(done)).not.toContain(phrase);
    const channels = await runOperatorCommand({
      event: event({ text: "/botrights channels", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(channels).toMatchObject({
      text: [
        "botrights 频道",
        "匿名 off",
        "管理 off",
        "删除 off",
        "视频 off",
        "限制 off",
        "提升 off",
        "资料 off",
        "邀请 off",
        "故事 off",
        "改故事 off",
        "删故事 off",
        "发帖 on",
        "编辑 off",
        "置顶 off",
        "话题 off",
        "私信 off",
        "标签 off",
        "欢迎 off",
      ].join("\n"),
    });
    expect(seen[1]).toEqual({ forChannels: true });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/botrights [channels]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/botrights", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: remember,
      ...kit(),
    });
    expect(english.status).toBe("reply");
    if (english.status === "reply") {
      expect(
        english.text.startsWith(
          "botrights groups\nanonymous unknown\nmanage on\ndelete off\n",
        ),
      ).toBe(true);
      expect(english.text.split("\n")).toHaveLength(19);
    }
    const skipped = await runOperatorCommand({
      event: event({ text: "/botrights", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readDefaultRights() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/botrights channels extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/botrights [channels]",
    });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/botrights ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/botrights", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/botrights", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readDefaultRights() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"botrights"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/botrights",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readDefaultRights() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("sets the private command menu from the fixed catalog", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      keys: readonly string[];
      commands: readonly { command: string; description: string }[];
    }[] = [];
    const remember = {
      async setCommandMenu(target: {
        tenantId: string;
        commands: readonly { command: string; description: string }[];
      }) {
        seen.push({
          tenantId: target.tenantId,
          keys: Object.keys(target),
          commands: target.commands.map((item) => ({
            command: item.command,
            description: item.description,
          })),
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/setcommands", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求设置私聊里的命令菜单。群菜单不变。已有单独语言列表的人不受影响。",
    });
    expect(seen).toHaveLength(1);
    const menu = seen[0]?.commands ?? [];
    expect(menu).toHaveLength(99);
    expect(menu.length).toBeLessThanOrEqual(100);
    expect(menu[0]).toEqual({ command: "help", description: "/help" });
    expect(menu.find((item) => item.command === "whitelist")).toEqual({
      command: "whitelist",
      description: "/whitelist <chatId>",
    });
    expect(menu.find((item) => item.command === "botrights")).toEqual({
      command: "botrights",
      description: "/botrights [channels]",
    });
    expect(menu.find((item) => item.command === "setcommands")).toEqual({
      command: "setcommands",
      description: "/setcommands [private]",
    });
    expect(menu.find((item) => item.command === "commands")).toEqual({
      command: "commands",
      description: "/commands [private]",
    });
    expect(menu.find((item) => item.command === "delcommands")).toEqual({
      command: "delcommands",
      description: "/delcommands [private]",
    });
    expect(menu.find((item) => item.command === "menubutton")).toEqual({
      command: "menubutton",
      description: "/menubutton <commands|default>",
    });
    expect(menu.find((item) => item.command === "button")).toEqual({
      command: "button",
      description: "/button",
    });
    expect(menu.find((item) => item.command === "botname")).toEqual({
      command: "botname",
      description: "/botname [name]",
    });
    expect(menu.find((item) => item.command === "myname")).toEqual({
      command: "myname",
      description: "/myname",
    });
    expect(menu.find((item) => item.command === "botdesc")).toEqual({
      command: "botdesc",
      description: "/botdesc [description]",
    });
    expect(menu.find((item) => item.command === "mydesc")).toEqual({
      command: "mydesc",
      description: "/mydesc",
    });
    expect(menu.find((item) => item.command === "botshort")).toEqual({
      command: "botshort",
      description: "/botshort [short]",
    });
    expect(menu.find((item) => item.command === "myshort")).toEqual({
      command: "myshort",
      description: "/myshort",
    });
    expect(menu.find((item) => item.command === "who")).toEqual({
      command: "who",
      description: "/who",
    });
    expect(menu.find((item) => item.command === "hook")).toEqual({
      command: "hook",
      description: "/hook",
    });
    expect(menu.find((item) => item.command === "guard")).toEqual({
      command: "guard",
      description: "/guard <chatId>",
    });
    expect(menu.find((item) => item.command === "joinbot")).toEqual({
      command: "joinbot",
      description: "/joinbot <chatId>",
    });
    expect(menu.find((item) => item.command === "reactions")).toEqual({
      command: "reactions",
      description: "/reactions <chatId>",
    });
    expect(menu.find((item) => item.command === "community")).toEqual({
      command: "community",
      description: "/community <chatId>",
    });
    expect(menu.find((item) => item.command === "canstickers")).toEqual({
      command: "canstickers",
      description: "/canstickers <chatId>",
    });
    expect(menu.find((item) => item.command === "parent")).toEqual({
      command: "parent",
      description: "/parent <chatId>",
    });
    expect(menu.find((item) => item.command === "personal")).toEqual({
      command: "personal",
      description: "/personal <chatId>",
    });
    expect(menu.find((item) => item.command === "privacy")).toEqual({
      command: "privacy",
      description: "/privacy <chatId>",
    });
    expect(menu.find((item) => item.command === "banfor")).toEqual({
      command: "banfor",
      description: "/banfor <chatId> <actorId> <seconds>",
    });
    expect(menu.find((item) => item.command === "allows")).toEqual({
      command: "allows",
      description: "/allows <chatId> <actorId>",
    });
    expect(menu.find((item) => item.command === "canadmin")).toEqual({
      command: "canadmin",
      description: "/canadmin <chatId> <actorId>",
    });
    expect(menu.find((item) => item.command === "kick")).toEqual({
      command: "kick",
      description: "/kick <chatId> <actorId>",
    });
    expect(menu.at(-1)).toEqual({
      command: "allowhost",
      description: "/allowhost <chatId> [add|remove <host>|reset]",
    });
    expect(menu.find((item) => item.command === "verifyfail")).toEqual({
      command: "verifyfail",
      description: "/verifyfail <chatId> [stay|kick|ban|reset]",
    });
    expect(menu.find((item) => item.command === "verifyfor")).toEqual({
      command: "verifyfor",
      description: "/verifyfor <chatId> [seconds|reset]",
    });
    expect(menu.find((item) => item.command === "rulemute")).toEqual({
      command: "rulemute",
      description: "/rulemute <chatId> [seconds|reset]",
    });
    expect(menu.find((item) => item.command === "repeat")).toEqual({
      command: "repeat",
      description: "/repeat <chatId> [count [seconds]|reset]",
    });
    expect(menu.find((item) => item.command === "keyword")).toEqual({
      command: "keyword",
      description: "/keyword <chatId> [add|remove <token>|reset]",
    });
    expect(menu.find((item) => item.command === "flood")).toEqual({
      command: "flood",
      description: "/flood <chatId> [count [seconds]|reset]",
    });
    expect(menu.find((item) => item.command === "report")).toEqual({
      command: "report",
      description: "/report <chatId> [targetId|reset]",
    });
    expect(menu.find((item) => item.command === "warnlimit")).toEqual({
      command: "warnlimit",
      description: "/warnlimit <chatId> [limit|reset]",
    });
    expect(menu.find((item) => item.command === "warns")).toEqual({
      command: "warns",
      description: "/warns <chatId> [actorId]",
    });
    expect(menu.find((item) => item.command === "warn")).toEqual({
      command: "warn",
      description: "/warn <chatId> <actorId>",
    });
    expect(menu.find((item) => item.command === "unwarn")).toEqual({
      command: "unwarn",
      description: "/unwarn <chatId> <actorId>",
    });
    expect(new Set(menu.map((item) => item.command)).size).toBe(menu.length);
    for (const item of menu) {
      expect(item.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.description.length).toBeLessThanOrEqual(256);
      expect(item).not.toHaveProperty("isEphemeral");
      expect(item).not.toHaveProperty("is_ephemeral");
    }
    expect(seen[0]?.keys).toEqual(["tenantId", "commands"]);
    expect(seen[0]?.tenantId).toBe("local");
    expect(JSON.stringify(seen)).not.toContain(phrase);
    expect(JSON.stringify(done)).not.toContain("/help");
    expect(JSON.stringify(done)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/setcommands private", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(named).toMatchObject({
      text: "已请求设置私聊里的命令菜单。群菜单不变。已有单独语言列表的人不受影响。",
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.commands).toEqual(menu);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/setcommands [private]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/setcommands", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: remember,
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set the command menu in private chats. Group menus stay. People who already have a language-specific list are unchanged.",
    });
    expect(seen).toHaveLength(3);
    const skipped = await runOperatorCommand({
      event: event({ text: "/setcommands", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setCommandMenu() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/setcommands private extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/setcommands [private]",
    });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/setcommands ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/setcommands", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/setcommands", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setCommandMenu() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"setcommands"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/setcommands",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/setcommands ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
  });

  it("reads the private command menu", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const remember = {
      async readCommandMenu(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        if (seen.length === 1) {
          return [
            {
              command: "help",
              description: "/help",
              ephemeral: "unknown" as const,
            },
            {
              command: "stickers",
              description: "/stickers <chatId> <name>",
              ephemeral: "off" as const,
            },
          ];
        }
        if (seen.length === 2) {
          return [
            {
              command: "help",
              description: "/help",
              ephemeral: "on" as const,
            },
          ];
        }
        return [];
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/commands", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: [
        "命令 2",
        "help /help 未知",
        "stickers /stickers <chatId> <name> off",
      ].join("\n"),
    });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(done)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/commands private", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(named).toMatchObject({
      text: "命令 1\nhelp /help on",
    });
    expect(seen[1]?.keys).toEqual(["tenantId"]);
    const empty = await runOperatorCommand({
      event: event({ text: "/commands", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(empty).toMatchObject({ text: "命令 0" });
    expect(empty.status).toBe("reply");
    if (empty.status === "reply") {
      expect(empty.text.split("\n")).toHaveLength(1);
    }
    const wide = Array.from({ length: 20 }, (_, index) => ({
      command: `cmd${index}`,
      description: "x".repeat(200),
      ephemeral: "unknown" as const,
    }));
    const fitted = await runOperatorCommand({
      event: event({ text: "/commands", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommandMenu() {
          return wide;
        },
      },
      ...kit(),
    });
    expect(fitted.status).toBe("reply");
    if (fitted.status === "reply") {
      expect(fitted.text.length).toBeLessThanOrEqual(3500);
      expect(fitted.text.startsWith("命令 20\n")).toBe(true);
      const lines = fitted.text.split("\n");
      const omitted = Number(/^\+(\d+)$/.exec(lines.at(-1) ?? "")?.[1]);
      expect(omitted).toBeGreaterThan(0);
      expect(lines.length - 2 + omitted).toBe(20);
    }
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/commands [private]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/commands", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readCommandMenu() {
          return [
            {
              command: "help",
              description: "/help",
              ephemeral: "unknown" as const,
            },
          ];
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "commands 1\nhelp /help unknown",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/commands", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readCommandMenu() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/commands private extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/commands [private]" });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/commands ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/commands", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/commands", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommandMenu() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"commands"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/commands",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/commands ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
  });

  it("clears the private command menu", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const remember = {
      async deleteCommandMenu(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/delcommands", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求清掉私聊里的命令菜单。更高一层的菜单会显示出来。群菜单不变。已有单独语言列表的人不受影响。",
    });
    expect(seen).toEqual([{ tenantId: "local", keys: ["tenantId"] }]);
    expect(JSON.stringify(done)).not.toContain("/help");
    expect(JSON.stringify(done)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/delcommands private", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(named).toMatchObject({
      text: "已请求清掉私聊里的命令菜单。更高一层的菜单会显示出来。群菜单不变。已有单独语言列表的人不受影响。",
    });
    expect(seen[1]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/delcommands [private]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/delcommands", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: remember,
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to clear the command menu in private chats. A higher-level menu will show. Group menus stay. People who already have a language-specific list are unchanged.",
    });
    expect(seen).toHaveLength(3);
    const skipped = await runOperatorCommand({
      event: event({ text: "/delcommands", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async deleteCommandMenu() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/delcommands private extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/delcommands [private]",
    });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/delcommands ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/delcommands", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/delcommands", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteCommandMenu() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"delcommands"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/delcommands",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deleteCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/delcommands ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deleteCommandMenu() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
  });

  it("sets the default menu button to the command list", async () => {
    const deps = kit();
    const seen: { tenantId: string; kind: string; keys: readonly string[] }[] =
      [];
    const remember = {
      async setMenuButton(target: { tenantId: string; kind: string }) {
        seen.push({
          tenantId: target.tenantId,
          kind: target.kind,
          keys: Object.keys(target),
        });
      },
    };
    const done = await runOperatorCommand({
      event: event({ text: "/menubutton commands", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求把默认菜单按钮设成命令列表。某个私聊里单独设过的按钮不受影响。",
    });
    expect(seen).toEqual([
      { tenantId: "local", kind: "commands", keys: ["tenantId", "kind"] },
    ]);
    expect(JSON.stringify(done)).not.toContain(phrase);
    const restored = await runOperatorCommand({
      event: event({ text: "/menubutton default", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(restored).toMatchObject({
      text: "已请求把默认菜单按钮恢复成默认。某个私聊里单独设过的按钮不受影响。",
    });
    expect(seen[1]).toEqual({
      tenantId: "local",
      kind: "default",
      keys: ["tenantId", "kind"],
    });
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/menubutton <commands|default>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/menubutton commands", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: remember,
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set the default menu button to the command list. A button set for one private chat stays.",
    });
    const englishDefault = await runOperatorCommand({
      event: event({ text: "/menubutton default", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: remember,
      ...kit(),
    });
    expect(englishDefault).toMatchObject({
      text: "Asked to restore the default menu button. A button set for one private chat stays.",
    });
    expect(seen).toHaveLength(4);
    const skipped = await runOperatorCommand({
      event: event({ text: "/menubutton commands", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setMenuButton() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/menubutton", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/menubutton <commands|default>",
    });
    const extra = await runOperatorCommand({
      event: event({ text: "/menubutton commands extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({
      text: "用法：/menubutton <commands|default>",
    });
    expect(seen).toHaveLength(4);
    const invalid = await runOperatorCommand({
      event: event({ text: `/menubutton ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/menubutton commands", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/menubutton default", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setMenuButton() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"menubutton"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/menubutton commands",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/menubutton ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
  });

  it("reads the default menu button", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const states = ["commands", "default", "web_app"] as const;
    const remember = {
      async readMenuButton(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        return states[seen.length - 1] ?? "default";
      },
    };
    const commands = await runOperatorCommand({
      event: event({ text: "/button", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(commands).toMatchObject({ text: "菜单按钮 命令" });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(commands)).not.toContain(phrase);
    const restored = await runOperatorCommand({
      event: event({ text: "/button", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(restored).toMatchObject({ text: "菜单按钮 默认" });
    const webApp = await runOperatorCommand({
      event: event({ text: "/button", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(webApp).toMatchObject({ text: "菜单按钮 应用" });
    expect(JSON.stringify(webApp)).not.toContain("https://");
    expect(seen).toHaveLength(3);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/button");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/button", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readMenuButton() {
          return "web_app" as const;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "menu button web app" });
    const skipped = await runOperatorCommand({
      event: event({ text: "/button", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readMenuButton() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/button extra more", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/button" });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/button ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/button", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/button", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMenuButton() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"button"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/button",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/button ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readMenuButton() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
  });

  it("sets the bot name without a language", async () => {
    const deps = kit();
    const seen: { tenantId: string; name: string; keys: readonly string[] }[] =
      [];
    const remember = {
      async setBotName(target: { tenantId: string; name: string }) {
        seen.push({
          tenantId: target.tenantId,
          name: target.name,
          keys: Object.keys(target),
        });
      },
    };
    const named = await runOperatorCommand({
      event: event({ text: `/botname ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(named).toMatchObject({
      text: "已请求设置这个 bot 的名字。已有单独语言名字的人不受影响。",
    });
    expect(seen).toEqual([
      { tenantId: "local", name: phrase, keys: ["tenantId", "name"] },
    ]);
    expect(JSON.stringify(named)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/botname", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉这个 bot 的默认名字。已有单独语言名字的人不受影响。",
    });
    expect(seen[1]).toEqual({
      tenantId: "local",
      name: "",
      keys: ["tenantId", "name"],
    });
    const spaced = await runOperatorCommand({
      event: event({ text: "/botname  alpha   beta", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求设置这个 bot 的名字。已有单独语言名字的人不受影响。",
    });
    expect(seen[2]?.name).toBe("alpha beta");
    expect(JSON.stringify(spaced)).not.toContain("alpha");
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/botname [name]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/botname hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setBotName() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set this bot's name. People who already have a language-specific name are unchanged.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const englishClear = await runOperatorCommand({
      event: event({ text: "/botname", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setBotName() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear this bot's default name. People who already have a language-specific name are unchanged.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: `/botname ${phrase}`, chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setBotName() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const tooLong = `${phrase}${"x".repeat(64)}`;
    let called = false;
    const invalid = await runOperatorCommand({
      event: event({ text: `/botname ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setBotName() {
          called = true;
        },
      },
      ...kit(),
    });
    expect(called).toBe(false);
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(3);
    const missing = await runOperatorCommand({
      event: event({ text: `/botname ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/botname ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setBotName() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"botname"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: `/botname ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setBotName() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignLong = await runOperatorCommand({
      event: event({
        text: `/botname ${tooLong}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setBotName() {
          called = true;
        },
      },
      ...kit(),
    });
    expect(called).toBe(false);
    expect(foreignLong).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the default bot name", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const names = [phrase, "", "Ada"] as const;
    const remember = {
      async readBotName(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        return names[seen.length - 1] ?? "";
      },
    };
    const named = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(named).toMatchObject({ text: `名字 ${phrase}` });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({ text: "名字 空" });
    const short = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(short).toMatchObject({ text: "名字 Ada" });
    expect(seen).toHaveLength(3);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/myname");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotName() {
          return phrase;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: `name ${phrase}` });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotName() {
          return "";
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({ text: "name empty" });
    const skipped = await runOperatorCommand({
      event: event({ text: "/myname", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readBotName() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/myname extra more", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotName() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/myname" });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/myname ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotName() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/myname", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotName() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"myname"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/myname",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotName() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/myname ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotName() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("sets the bot description without a language", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      description: string;
      keys: readonly string[];
    }[] = [];
    const remember = {
      async setBotDescription(target: {
        tenantId: string;
        description: string;
      }) {
        seen.push({
          tenantId: target.tenantId,
          description: target.description,
          keys: Object.keys(target),
        });
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: `/botdesc ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: "已请求设置这个 bot 的简介。已有单独语言简介的人不受影响。",
    });
    expect(seen).toEqual([
      {
        tenantId: "local",
        description: phrase,
        keys: ["tenantId", "description"],
      },
    ]);
    expect(JSON.stringify(described)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/botdesc", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉这个 bot 的默认简介。已有单独语言简介的人不受影响。",
    });
    expect(seen[1]).toEqual({
      tenantId: "local",
      description: "",
      keys: ["tenantId", "description"],
    });
    const spaced = await runOperatorCommand({
      event: event({ text: "/botdesc  alpha   beta", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求设置这个 bot 的简介。已有单独语言简介的人不受影响。",
    });
    expect(seen[2]?.description).toBe("alpha beta");
    expect(JSON.stringify(spaced)).not.toContain("alpha");
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/botdesc [description]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/botdesc hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setBotDescription() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set this bot's description. People who already have a language-specific description are unchanged.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const englishClear = await runOperatorCommand({
      event: event({ text: "/botdesc", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setBotDescription() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear this bot's default description. People who already have a language-specific description are unchanged.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: `/botdesc ${phrase}`, chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setBotDescription() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const tooLong = `${phrase}${"x".repeat(512)}`;
    let called = false;
    const invalid = await runOperatorCommand({
      event: event({ text: `/botdesc ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setBotDescription() {
          called = true;
        },
      },
      ...kit(),
    });
    expect(called).toBe(false);
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(3);
    const missing = await runOperatorCommand({
      event: event({ text: `/botdesc ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/botdesc ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setBotDescription() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"botdesc"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: `/botdesc ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setBotDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignLong = await runOperatorCommand({
      event: event({
        text: `/botdesc ${tooLong}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setBotDescription() {
          called = true;
        },
      },
      ...kit(),
    });
    expect(called).toBe(false);
    expect(foreignLong).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the default bot description", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const descriptions = [phrase, "", "Ada"] as const;
    const remember = {
      async readBotDescription(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        return descriptions[seen.length - 1] ?? "";
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({ text: `简介 ${phrase}` });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({ text: "简介 空" });
    const short = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(short).toMatchObject({ text: "简介 Ada" });
    expect(seen).toHaveLength(3);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/mydesc");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotDescription() {
          return phrase;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: `description ${phrase}` });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotDescription() {
          return "";
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({ text: "description empty" });
    const skipped = await runOperatorCommand({
      event: event({ text: "/mydesc", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readBotDescription() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/mydesc extra more", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/mydesc" });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/mydesc ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/mydesc", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotDescription() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"mydesc"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/mydesc",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/mydesc ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("sets the bot short description without a language", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      shortDescription: string;
      keys: readonly string[];
    }[] = [];
    const remember = {
      async setBotShortDescription(target: {
        tenantId: string;
        shortDescription: string;
      }) {
        seen.push({
          tenantId: target.tenantId,
          shortDescription: target.shortDescription,
          keys: Object.keys(target),
        });
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: `/botshort ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: "已请求设置这个 bot 的短简介。已有单独语言短简介的人不受影响。",
    });
    expect(seen).toEqual([
      {
        tenantId: "local",
        shortDescription: phrase,
        keys: ["tenantId", "shortDescription"],
      },
    ]);
    expect(JSON.stringify(described)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/botshort", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: "已请求清掉这个 bot 的默认短简介。已有单独语言短简介的人不受影响。",
    });
    expect(seen[1]).toEqual({
      tenantId: "local",
      shortDescription: "",
      keys: ["tenantId", "shortDescription"],
    });
    const spaced = await runOperatorCommand({
      event: event({ text: "/botshort  alpha   beta", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(spaced).toMatchObject({
      text: "已请求设置这个 bot 的短简介。已有单独语言短简介的人不受影响。",
    });
    expect(seen[2]?.shortDescription).toBe("alpha beta");
    expect(JSON.stringify(spaced)).not.toContain("alpha");
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/botshort [short]");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/botshort hello", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setBotShortDescription() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to set this bot's short description. People who already have a language-specific short description are unchanged.",
    });
    expect(JSON.stringify(english)).not.toContain("hello");
    const englishClear = await runOperatorCommand({
      event: event({ text: "/botshort", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async setBotShortDescription() {},
      },
      ...kit(),
    });
    expect(englishClear).toMatchObject({
      text: "Asked to clear this bot's default short description. People who already have a language-specific short description are unchanged.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: `/botshort ${phrase}`, chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async setBotShortDescription() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const tooLong = `${phrase}${"x".repeat(120)}`;
    let called = false;
    const invalid = await runOperatorCommand({
      event: event({ text: `/botshort ${tooLong}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setBotShortDescription() {
          called = true;
        },
      },
      ...kit(),
    });
    expect(called).toBe(false);
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    expect(seen).toHaveLength(3);
    const exact = await runOperatorCommand({
      event: event({ text: `/botshort ${"y".repeat(120)}`, direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(exact).toMatchObject({
      text: "已请求设置这个 bot 的短简介。已有单独语言短简介的人不受影响。",
    });
    expect(seen[3]?.shortDescription).toBe("y".repeat(120));
    expect(seen).toHaveLength(4);
    const missing = await runOperatorCommand({
      event: event({ text: `/botshort ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: `/botshort ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async setBotShortDescription() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"botshort"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: `/botshort ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setBotShortDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignLong = await runOperatorCommand({
      event: event({
        text: `/botshort ${tooLong}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async setBotShortDescription() {
          called = true;
        },
      },
      ...kit(),
    });
    expect(called).toBe(false);
    expect(foreignLong).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(4);
  });

  it("reads the default bot short description", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const shorts = [phrase, "", "Ada"] as const;
    const remember = {
      async readBotShortDescription(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        return shorts[seen.length - 1] ?? "";
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({ text: `短简介 ${phrase}` });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({ text: "短简介 空" });
    const short = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(short).toMatchObject({ text: "短简介 Ada" });
    expect(seen).toHaveLength(3);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/myshort");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotShortDescription() {
          return phrase;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: `short description ${phrase}` });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotShortDescription() {
          return "";
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({ text: "short description empty" });
    const skipped = await runOperatorCommand({
      event: event({ text: "/myshort", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readBotShortDescription() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/myshort extra more", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotShortDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/myshort" });
    expect(seen).toHaveLength(3);
    const invalid = await runOperatorCommand({
      event: event({ text: `/myshort ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotShortDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/myshort", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotShortDescription() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"myshort"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/myshort",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotShortDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/myshort ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotShortDescription() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the bot identity and drops the display name", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const identities = [
      {
        id: "42",
        username: "giftbot",
        joinGroups: "on" as const,
        readAllGroupMessages: "off" as const,
        guestQueries: "on" as const,
        joinRequestQueries: "off" as const,
      },
      {
        id: "7",
        username: "",
        joinGroups: "unknown" as const,
        readAllGroupMessages: "unknown" as const,
        guestQueries: "unknown" as const,
        joinRequestQueries: "unknown" as const,
      },
    ];
    const remember = {
      async readBotIdentity(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        const identity = identities[seen.length - 1];
        if (identity === undefined) {
          throw new Error("called");
        }
        return identity;
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: [
        "机器人 42",
        "用户名 giftbot",
        "入群 on",
        "群消息 off",
        "访客 on",
        "入群查询 off",
      ].join("\n"),
    });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(deps.logger.entries)).not.toContain("giftbot");
    expect(JSON.stringify(described)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: [
        "机器人 7",
        "用户名 空",
        "入群 未知",
        "群消息 未知",
        "访客 未知",
        "入群查询 未知",
      ].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/who");
      expect(help.text).not.toContain("/who ");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotIdentity() {
          return {
            id: "42",
            username: "giftbot",
            joinGroups: "on" as const,
            readAllGroupMessages: "off" as const,
            guestQueries: "on" as const,
            joinRequestQueries: "off" as const,
          };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: [
        "bot 42",
        "username giftbot",
        "groups on",
        "group messages off",
        "guests on",
        "join queries off",
      ].join("\n"),
    });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readBotIdentity() {
          return {
            id: "7",
            username: "",
            joinGroups: "unknown" as const,
            readAllGroupMessages: "unknown" as const,
            guestQueries: "unknown" as const,
            joinRequestQueries: "unknown" as const,
          };
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({
      text: [
        "bot 7",
        "username empty",
        "groups unknown",
        "group messages unknown",
        "guests unknown",
        "join queries unknown",
      ].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/who", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readBotIdentity() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/who extra more", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotIdentity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/who" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/who ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotIdentity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const leaked = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotIdentity() {
          return {
            id: "42",
            username: phrase,
            joinGroups: "on" as const,
            readAllGroupMessages: "off" as const,
            guestQueries: "on" as const,
            joinRequestQueries: "off" as const,
          };
        },
      },
      ...kit(),
    });
    expect(leaked).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(leaked)).not.toContain(phrase);
    const flagged = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotIdentity() {
          return {
            id: "42",
            username: "giftbot",
            joinGroups: "on",
            readAllGroupMessages: "off",
            guestQueries: "maybe",
            joinRequestQueries: "off",
          } as never;
        },
      },
      ...kit(),
    });
    expect(flagged).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/who", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readBotIdentity() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain('"command":"who"');
    const foreign = await runOperatorCommand({
      event: event({
        text: "/who",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotIdentity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/who ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readBotIdentity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(2);
  });

  it("reads the webhook backlog", async () => {
    const deps = kit();
    const seen: { tenantId: string; keys: readonly string[] }[] = [];
    const snapshots = [
      {
        pendingUpdateCount: 3,
        customCertificate: "off" as const,
        maxConnections: 40,
        lastErrorDate: 1_700_000_000,
      },
      {
        pendingUpdateCount: 0,
        customCertificate: "unknown" as const,
        maxConnections: null,
        lastErrorDate: null,
      },
    ];
    const remember = {
      async readWebhook(target: { tenantId: string }) {
        seen.push({ tenantId: target.tenantId, keys: Object.keys(target) });
        const snapshot = snapshots[seen.length - 1];
        if (snapshot === undefined) {
          throw new Error("called");
        }
        return snapshot;
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["待投递 3", "证书 off", "连接 40", "上次错误 1700000000"].join(
        "\n",
      ),
    });
    expect(seen[0]).toEqual({ tenantId: "local", keys: ["tenantId"] });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: ["待投递 0", "证书 未知", "连接 未知", "上次错误 未知"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/hook");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readWebhook() {
          return {
            pendingUpdateCount: 3,
            customCertificate: "off" as const,
            maxConnections: 40,
            lastErrorDate: 1_700_000_000,
          };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: [
        "pending 3",
        "certificate off",
        "connections 40",
        "last error 1700000000",
      ].join("\n"),
    });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readWebhook() {
          return {
            pendingUpdateCount: 0,
            customCertificate: "unknown" as const,
            maxConnections: null,
            lastErrorDate: null,
          };
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({
      text: [
        "pending 0",
        "certificate unknown",
        "connections unknown",
        "last error unknown",
      ].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/hook", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readWebhook() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/hook extra more", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readWebhook() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/hook" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/hook ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readWebhook() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const wide = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readWebhook() {
          return {
            pendingUpdateCount: 3,
            customCertificate: "off" as const,
            maxConnections: 101,
            lastErrorDate: 1_700_000_000,
          };
        },
      },
      ...kit(),
    });
    expect(wide).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/hook", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readWebhook() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain('"command":"hook"');
    const foreign = await runOperatorCommand({
      event: event({
        text: "/hook",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readWebhook() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/hook ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readWebhook() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(2);
  });

  it("reads the chat guard posture and drops the title", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const full = {
      type: "supergroup" as const,
      forum: "on" as const,
      directMessages: "off" as const,
      joinByRequest: "on" as const,
      joinToSend: "off" as const,
      nativeAntiSpam: "on" as const,
      slowModeSeconds: 30,
      autoDeleteSeconds: 86400,
      boostExemption: 2,
      protectedContent: "on" as const,
      hiddenMembers: "off" as const,
      visibleHistory: "on" as const,
      maxReactions: 11,
      linkedChatId: "-100777",
    };
    const empty = {
      type: "group" as const,
      forum: "unknown" as const,
      directMessages: "unknown" as const,
      joinByRequest: "unknown" as const,
      joinToSend: "unknown" as const,
      nativeAntiSpam: "unknown" as const,
      slowModeSeconds: null,
      autoDeleteSeconds: null,
      boostExemption: null,
      protectedContent: "unknown" as const,
      hiddenMembers: "unknown" as const,
      visibleHistory: "unknown" as const,
      maxReactions: 0,
      linkedChatId: null,
    };
    const snapshots = [full, empty, full];
    const remember = {
      async readChatGuard(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const snapshot = snapshots[seen.length - 1];
        if (snapshot === undefined) {
          throw new Error("called");
        }
        return snapshot;
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: [
        "群 -100",
        "类型 超级群",
        "话题 on",
        "频道私聊 off",
        "审核入群 on",
        "入群发言 off",
        "官方反垃圾 on",
        "慢速 30",
        "自毁 86400",
        "加速豁免 2",
        "防转发 on",
        "隐藏成员 off",
        "可见历史 on",
        "反应 11",
        "关联 -100777",
      ].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: [
        "群 -100",
        "类型 群",
        "话题 未知",
        "频道私聊 未知",
        "审核入群 未知",
        "入群发言 未知",
        "官方反垃圾 未知",
        "慢速 未知",
        "自毁 未知",
        "加速豁免 未知",
        "防转发 未知",
        "隐藏成员 未知",
        "可见历史 未知",
        "反应 0",
        "关联 未知",
      ].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/guard <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readChatGuard() {
          return {
            type: "supergroup" as const,
            forum: "on" as const,
            directMessages: "off" as const,
            joinByRequest: "on" as const,
            joinToSend: "off" as const,
            nativeAntiSpam: "on" as const,
            slowModeSeconds: 30,
            autoDeleteSeconds: 86400,
            boostExemption: 2,
            protectedContent: "on" as const,
            hiddenMembers: "off" as const,
            visibleHistory: "on" as const,
            maxReactions: 11,
            linkedChatId: "-100777",
          };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: [
        "chat -100",
        "type supergroup",
        "topics on",
        "direct messages off",
        "join approval on",
        "join to send off",
        "native anti-spam on",
        "slow mode 30",
        "auto-delete 86400",
        "boost exemption 2",
        "protected on",
        "hidden members off",
        "history on",
        "reactions 11",
        "linked -100777",
      ].join("\n"),
    });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readChatGuard() {
          return {
            type: "channel" as const,
            forum: "unknown" as const,
            directMessages: "unknown" as const,
            joinByRequest: "unknown" as const,
            joinToSend: "unknown" as const,
            nativeAntiSpam: "unknown" as const,
            slowModeSeconds: null,
            autoDeleteSeconds: null,
            boostExemption: null,
            protectedContent: "unknown" as const,
            hiddenMembers: "unknown" as const,
            visibleHistory: "unknown" as const,
            maxReactions: 1,
            linkedChatId: null,
          };
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({
      text: [
        "chat -100",
        "type channel",
        "topics unknown",
        "direct messages unknown",
        "join approval unknown",
        "join to send unknown",
        "native anti-spam unknown",
        "slow mode unknown",
        "auto-delete unknown",
        "boost exemption unknown",
        "protected unknown",
        "hidden members unknown",
        "history unknown",
        "reactions 1",
        "linked unknown",
      ].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/guard -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/guard", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/guard <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/guard -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/guard <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/guard ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const titled = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          return { ...full, type: phrase };
        },
      },
      ...kit(),
    });
    expect(titled).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(titled)).not.toContain(phrase);
    const linked = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          return { ...full, linkedChatId: phrase };
        },
      },
      ...kit(),
    });
    expect(linked).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(linked)).not.toContain(phrase);
    const negative = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          return { ...full, slowModeSeconds: -1 };
        },
      },
      ...kit(),
    });
    expect(negative).toMatchObject({ text: "参数无效" });
    const fractional = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          return { ...full, maxReactions: 1.5 };
        },
      },
      ...kit(),
    });
    expect(fractional).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readChatGuard() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"guard"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/guard -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: [
        "群 -100",
        "类型 超级群",
        "话题 on",
        "频道私聊 off",
        "审核入群 on",
        "入群发言 off",
        "官方反垃圾 on",
        "慢速 30",
        "自毁 86400",
        "加速豁免 2",
        "防转发 on",
        "隐藏成员 off",
        "可见历史 on",
        "反应 11",
        "关联 -100777",
      ].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/guard -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readChatGuard() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/guard ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readChatGuard() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the join-request bot and drops the display name", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const snapshots = [
      { id: "4242", username: "giftbot" },
      { id: null, username: null },
      { id: "7", username: "" },
    ];
    const remember = {
      async readJoinBot(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const snapshot = snapshots[seen.length - 1];
        if (snapshot === undefined) {
          throw new Error("called");
        }
        return snapshot;
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "机器人 4242", "用户名 giftbot"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain("giftbot");
    expect(JSON.stringify(described)).toContain("giftbot");
    expect(JSON.stringify(described)).not.toContain(phrase);
    const cleared = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(cleared).toMatchObject({
      text: ["群 -100", "机器人 未知", "用户名 未知"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/joinbot <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readJoinBot() {
          return { id: "4242", username: "giftbot" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "bot 4242", "username giftbot"].join("\n"),
    });
    const englishEmpty = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readJoinBot() {
          return { id: "7", username: "" };
        },
      },
      ...kit(),
    });
    expect(englishEmpty).toMatchObject({
      text: ["chat -100", "bot 7", "username empty"].join("\n"),
    });
    const englishUnknown = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readJoinBot() {
          return { id: null, username: null };
        },
      },
      ...kit(),
    });
    expect(englishUnknown).toMatchObject({
      text: ["chat -100", "bot unknown", "username unknown"].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/joinbot -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/joinbot", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/joinbot <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/joinbot -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/joinbot <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/joinbot ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          return { id: "4242", username: phrase };
        },
      },
      ...kit(),
    });
    expect(named).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(named)).not.toContain(phrase);
    const half = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          return { id: null, username: "giftbot" };
        },
      },
      ...kit(),
    });
    expect(half).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(half)).not.toContain("giftbot");
    const missing = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readJoinBot() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"joinbot"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/joinbot -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "机器人 7", "用户名 空"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/joinbot -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readJoinBot() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/joinbot ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readJoinBot() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the allowed reactions and drops the emoji", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const counts: Array<number | null> = [3, null, 0];
    const remember = {
      async readReactions(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const count = counts[seen.length - 1];
        if (count === undefined) {
          throw new Error("called");
        }
        return { count };
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "反应 3"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const all = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(all).toMatchObject({
      text: ["群 -100", "反应 全部"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/reactions <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readReactions() {
          return { count: 3 };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "reactions 3"].join("\n"),
    });
    const englishAll = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readReactions() {
          return { count: null };
        },
      },
      ...kit(),
    });
    expect(englishAll).toMatchObject({
      text: ["chat -100", "reactions all"].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/reactions -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/reactions", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/reactions <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/reactions -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/reactions <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/reactions ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const negative = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          return { count: -1 };
        },
      },
      ...kit(),
    });
    expect(negative).toMatchObject({ text: "参数无效" });
    const fraction = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          return { count: 1.5 };
        },
      },
      ...kit(),
    });
    expect(fraction).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readReactions() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"reactions"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/reactions -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "反应 0"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/reactions -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/reactions ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readReactions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the chat community and drops the name", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const ids: Array<string | null> = ["82002", null, "7"];
    const remember = {
      async readCommunity(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const id = ids[seen.length - 1];
        if (id === undefined) {
          throw new Error("called");
        }
        return { id };
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "社区 82002"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const none = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(none).toMatchObject({
      text: ["群 -100", "社区 无"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/community <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readCommunity() {
          return { id: "82002" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "community 82002"].join("\n"),
    });
    const englishNone = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readCommunity() {
          return { id: null };
        },
      },
      ...kit(),
    });
    expect(englishNone).toMatchObject({
      text: ["chat -100", "community none"].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/community -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readCommunity() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/community", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommunity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/community <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/community -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommunity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/community <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/community ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommunity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommunity() {
          return { id: phrase };
        },
      },
      ...kit(),
    });
    expect(named).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(named)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readCommunity() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"community"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/community -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "社区 7"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/community -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readCommunity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/community ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readCommunity() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads whether the bot can change the sticker set and drops the name", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const states = ["on", "unknown", "off"] as const;
    const remember = {
      async readStickerSetRight(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const canSet = states[seen.length - 1];
        if (canSet === undefined) {
          throw new Error("called");
        }
        return { canSet };
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "贴纸 on"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const unknown = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(unknown).toMatchObject({
      text: ["群 -100", "贴纸 未知"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/canstickers <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readStickerSetRight() {
          return { canSet: "on" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "stickers on"].join("\n"),
    });
    const englishUnknown = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readStickerSetRight() {
          return { canSet: "unknown" };
        },
      },
      ...kit(),
    });
    expect(englishUnknown).toMatchObject({
      text: ["chat -100", "stickers unknown"].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/canstickers -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readStickerSetRight() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/canstickers", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readStickerSetRight() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/canstickers <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/canstickers -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readStickerSetRight() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/canstickers <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/canstickers ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readStickerSetRight() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const flagged = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readStickerSetRight() {
          return { canSet: "maybe" as never };
        },
      },
      ...kit(),
    });
    expect(flagged).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readStickerSetRight() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"canstickers"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/canstickers -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "贴纸 off"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/canstickers -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readStickerSetRight() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/canstickers ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readStickerSetRight() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the parent channel and drops the title", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const ids: Array<string | null> = ["-100777", null, "-1001"];
    const remember = {
      async readParentChat(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const id = ids[seen.length - 1];
        if (id === undefined) {
          throw new Error("called");
        }
        return { id };
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "上级 -100777"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const none = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(none).toMatchObject({
      text: ["群 -100", "上级 无"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/parent <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readParentChat() {
          return { id: "-100777" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "parent -100777"].join("\n"),
    });
    const englishNone = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readParentChat() {
          return { id: null };
        },
      },
      ...kit(),
    });
    expect(englishNone).toMatchObject({
      text: ["chat -100", "parent none"].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/parent -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readParentChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/parent", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readParentChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/parent <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/parent -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readParentChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/parent <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/parent ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readParentChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readParentChat() {
          return { id: phrase };
        },
      },
      ...kit(),
    });
    expect(named).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(named)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readParentChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"parent"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/parent -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "上级 -1001"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/parent -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readParentChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/parent ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readParentChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads the personal channel and drops the title", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const ids: Array<string | null> = ["-100888", null, "-1002"];
    const remember = {
      async readPersonalChat(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const id = ids[seen.length - 1];
        if (id === undefined) {
          throw new Error("called");
        }
        return { id };
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "个人频道 -100888"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const none = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(none).toMatchObject({
      text: ["群 -100", "个人频道 无"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/personal <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readPersonalChat() {
          return { id: "-100888" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "personal -100888"].join("\n"),
    });
    const englishNone = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readPersonalChat() {
          return { id: null };
        },
      },
      ...kit(),
    });
    expect(englishNone).toMatchObject({
      text: ["chat -100", "personal none"].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/personal -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readPersonalChat() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/personal", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPersonalChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/personal <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/personal -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPersonalChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/personal <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/personal ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPersonalChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const named = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPersonalChat() {
          return { id: phrase };
        },
      },
      ...kit(),
    });
    expect(named).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(named)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPersonalChat() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"personal"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/personal -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "个人频道 -1002"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/personal -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readPersonalChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/personal ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readPersonalChat() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reads private-chat privacy and drops the name", async () => {
    const deps = kit();
    const seen: {
      tenantId: string;
      chatId: string;
      keys: readonly string[];
    }[] = [];
    const states = [
      { privateForwards: "on", restrictedVoice: "on" },
      { privateForwards: "unknown", restrictedVoice: "unknown" },
      { privateForwards: "off", restrictedVoice: "unknown" },
    ] as const;
    const remember = {
      async readPrivatePrivacy(target: { tenantId: string; chatId: string }) {
        seen.push({
          tenantId: target.tenantId,
          chatId: target.chatId,
          keys: Object.keys(target),
        });
        const privacy = states[seen.length - 1];
        if (privacy === undefined) {
          throw new Error("called");
        }
        return privacy;
      },
    };
    const described = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...deps,
    });
    expect(described).toMatchObject({
      text: ["群 -100", "私密转发 on", "语音视频 on"].join("\n"),
    });
    expect(seen[0]).toEqual({
      tenantId: "local",
      chatId: "-100",
      keys: ["tenantId", "chatId"],
    });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(described)).not.toContain(phrase);
    const unknown = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      moderator: remember,
      ...kit(),
    });
    expect(unknown).toMatchObject({
      text: ["群 -100", "私密转发 未知", "语音视频 未知"].join("\n"),
    });
    expect(seen).toHaveLength(2);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/privacy <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readPrivatePrivacy() {
          return { privateForwards: "on", restrictedVoice: "off" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100", "private forwards on", "voice video off"].join("\n"),
    });
    const englishUnknown = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readPrivatePrivacy() {
          return { privateForwards: "unknown", restrictedVoice: "unknown" };
        },
      },
      ...kit(),
    });
    expect(englishUnknown).toMatchObject({
      text: [
        "chat -100",
        "private forwards unknown",
        "voice video unknown",
      ].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/privacy -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readPrivatePrivacy() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/privacy", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPrivatePrivacy() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/privacy <chatId>" });
    const extra = await runOperatorCommand({
      event: event({ text: "/privacy -100 extra", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPrivatePrivacy() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/privacy <chatId>" });
    expect(seen).toHaveLength(2);
    const invalid = await runOperatorCommand({
      event: event({ text: `/privacy ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPrivatePrivacy() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const flagged = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPrivatePrivacy() {
          return {
            privateForwards: "maybe" as never,
            restrictedVoice: "on",
          };
        },
      },
      ...kit(),
    });
    expect(flagged).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const rejected = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPrivatePrivacy() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"privacy"',
    );
    const owned = await runOperatorCommand({
      event: event({ text: "/privacy -100", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: remember,
      ...kit(),
    });
    expect(owned).toMatchObject({
      text: ["群 -100", "私密转发 off", "语音视频 未知"].join("\n"),
    });
    expect(seen).toHaveLength(3);
    const foreign = await runOperatorCommand({
      event: event({ text: "/privacy -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readPrivatePrivacy() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const foreignPhrase = await runOperatorCommand({
      event: event({
        text: `/privacy ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readPrivatePrivacy() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreignPhrase).toMatchObject({ text: "参数无效" });
    expect(seen).toHaveLength(3);
  });

  it("reports default speaking permissions without the chat title", async () => {
    const deps = kit();
    const seen: string[] = [];
    const text = [
      "perms -100",
      "发言 on",
      "音频 off",
      "文件 未知",
      "图片 off",
      "视频 off",
      "视频留言 off",
      "语音 off",
      "投票 off",
      "其他 off",
      "预览 off",
      "反应 off",
      "标签 off",
      "资料 off",
      "邀请 off",
      "置顶 off",
      "话题 off",
    ].join("\n");
    const done = await runOperatorCommand({
      event: event({ text: "/perms -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPermissions(target) {
          seen.push(target.chatId);
          return {
            sendMessages: "on",
            sendAudios: "off",
            sendDocuments: "unknown",
            sendPhotos: "off",
            sendVideos: "off",
            sendVideoNotes: "off",
            sendVoiceNotes: "off",
            sendPolls: "off",
            sendOtherMessages: "off",
            addWebPagePreviews: "off",
            reactToMessages: "off",
            editTag: "off",
            changeInfo: "off",
            inviteUsers: "off",
            pinMessages: "off",
            manageTopics: "off",
          };
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text });
    expect(seen).toEqual(["-100"]);
    expect(JSON.stringify(done)).not.toContain(phrase);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/perms <chatId>");
    }
    const english = await runOperatorCommand({
      event: event({ text: "/perms -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readPermissions() {
          return {
            sendMessages: "on",
            sendAudios: "off",
            sendDocuments: "unknown",
            sendPhotos: "off",
            sendVideos: "off",
            sendVideoNotes: "off",
            sendVoiceNotes: "off",
            sendPolls: "off",
            sendOtherMessages: "off",
            addWebPagePreviews: "off",
            reactToMessages: "off",
            editTag: "off",
            changeInfo: "off",
            inviteUsers: "off",
            pinMessages: "off",
            manageTopics: "off",
          };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: [
        "perms -100",
        "messages on",
        "audios off",
        "documents unknown",
        "photos off",
        "videos off",
        "video notes off",
        "voice notes off",
        "polls off",
        "other off",
        "previews off",
        "reactions off",
        "tag off",
        "info off",
        "invite off",
        "pin off",
        "topics off",
      ].join("\n"),
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/perms -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readPermissions() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/perms", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/perms <chatId>" });
    const invalid = await runOperatorCommand({
      event: event({ text: `/perms ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPermissions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/perms -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/perms -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readPermissions() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"perms"',
    );
    const foreign = await runOperatorCommand({
      event: event({ text: "/perms -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readPermissions() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("deletes several messages in one request", async () => {
    const deps = kit();
    const batches: { chatId: string; messageIds: readonly string[] }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/deletes -100 88 89", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessage() {
          throw new Error("called");
        },
        async deleteMessages(target) {
          batches.push({
            chatId: target.chatId,
            messageIds: target.messageIds,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已请求删除 -100 的 2 条。找不到的会跳过",
    });
    expect(batches).toEqual([{ chatId: "-100", messageIds: ["88", "89"] }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain(
        "/deletes <chatId> <messageId> [messageId...]",
      );
    }
    const english = await runOperatorCommand({
      event: event({ text: "/deletes -100 88 89", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async deleteMessages() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked to delete 2 messages in -100. Missing ones are skipped.",
    });
    const skipped = await runOperatorCommand({
      event: event({ text: "/deletes -100 88 89", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessages() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");
    const usage = await runOperatorCommand({
      event: event({ text: "/deletes -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/deletes <chatId> <messageId> [messageId...]",
    });
    const invalid = await runOperatorCommand({
      event: event({ text: `/deletes -100 88 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessages() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const repeated = await runOperatorCommand({
      event: event({ text: "/deletes -100 88 88", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessages() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(repeated).toMatchObject({ text: "参数无效" });
    const full = Array.from({ length: 100 }, (_, index) => String(index + 1));
    const accepted = await runOperatorCommand({
      event: event({
        text: `/deletes -100 ${full.join(" ")}`,
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessages(target) {
          batches.push({
            chatId: target.chatId,
            messageIds: target.messageIds,
          });
        },
      },
      ...kit(),
    });
    expect(accepted).toMatchObject({
      text: "已请求删除 -100 的 100 条。找不到的会跳过",
    });
    expect(batches[1]?.messageIds).toEqual(full);
    const over = await runOperatorCommand({
      event: event({
        text: `/deletes -100 ${full.join(" ")} 101`,
        direct: true,
      }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessages() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(over).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/deletes -100 88 89", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/deletes -100 88 89", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async deleteMessages() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).toContain(
      '"command":"deletes"',
    );
    const foreign = await runOperatorCommand({
      event: event({
        text: "/deletes -200 88 89",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async deleteMessages() {
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

  it("bans a member until a chosen second", async () => {
    const deps = kit();
    const banned: {
      chatId: string;
      actorId: string;
      durationSeconds: number;
    }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 3600", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor(target) {
          banned.push({
            chatId: target.chatId,
            actorId: target.actorId,
            durationSeconds: target.durationSeconds,
          });
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已限时封禁 -100 77 3600 秒" });
    expect(banned).toEqual([
      { chatId: "-100", actorId: "77", durationSeconds: 3600 },
    ]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("/banfor <chatId> <actorId> <seconds>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 30", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async banActorFor() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Banned 77 in -100 for 30 seconds",
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 3600", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/banfor -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/banfor <chatId> <actorId> <seconds>",
    });

    const extra = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 3600 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "参数无效" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/banfor -100 ${phrase} 3600`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const rejectedSeconds: number[] = [];
    const short = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 29", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor(target) {
          rejectedSeconds.push(target.durationSeconds);
        },
      },
      ...kit(),
    });
    expect(short).toMatchObject({ text: "参数无效" });

    const long = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 31622401", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor(target) {
          rejectedSeconds.push(target.durationSeconds);
        },
      },
      ...kit(),
    });
    expect(long).toMatchObject({ text: "参数无效" });
    expect(rejectedSeconds).toEqual([]);

    const floor = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 30", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor(target) {
          banned.push({
            chatId: target.chatId,
            actorId: target.actorId,
            durationSeconds: target.durationSeconds,
          });
        },
      },
      ...kit(),
    });
    expect(floor).toMatchObject({ text: "已限时封禁 -100 77 30 秒" });

    const ceiling = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 31622400", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor(target) {
          banned.push({
            chatId: target.chatId,
            actorId: target.actorId,
            durationSeconds: target.durationSeconds,
          });
        },
      },
      ...kit(),
    });
    expect(ceiling).toMatchObject({ text: "已限时封禁 -100 77 31622400 秒" });
    expect(banned).toEqual([
      { chatId: "-100", actorId: "77", durationSeconds: 3600 },
      { chatId: "-100", actorId: "77", durationSeconds: 30 },
      { chatId: "-100", actorId: "77", durationSeconds: 31622400 },
    ]);

    const missing = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 3600", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/banfor -100 77 3600", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async banActorFor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({
        text: "/banfor -200 77 3600",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async banActorFor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reads one member's individual allows", async () => {
    const off = {
      sendMessages: "off",
      sendAudios: "off",
      sendDocuments: "off",
      sendPhotos: "off",
      sendVideos: "off",
      sendVideoNotes: "off",
      sendVoiceNotes: "off",
      sendPolls: "off",
      sendOtherMessages: "off",
      addWebPagePreviews: "off",
      reactToMessages: "off",
      editTag: "off",
      changeInfo: "off",
      inviteUsers: "off",
      pinMessages: "off",
      manageTopics: "off",
    } as const;
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows(target) {
          seen.push(target.actorId);
          return {
            kind: "restricted",
            inChat: true,
            untilDate: 1_700_003_600,
            permissions: { ...off, sendMessages: "on" },
          };
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: [
        "群 -100 77",
        "人 在",
        "直到 1700003600",
        "发言 on",
        "音频 off",
        "文件 off",
        "图片 off",
        "视频 off",
        "视频留言 off",
        "语音 off",
        "投票 off",
        "其他 off",
        "预览 off",
        "反应 off",
        "标签 off",
        "资料 off",
        "邀请 off",
        "置顶 off",
        "话题 off",
      ].join("\n"),
    });
    expect(seen).toEqual(["77"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/allows <chatId> <actorId>");
    }

    const open = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows() {
          return { kind: "none" };
        },
      },
      ...kit(),
    });
    expect(open).toMatchObject({
      text: ["群 -100 77", "单独限制 无"].join("\n"),
    });
    expect(JSON.stringify(open)).not.toContain("发言");

    const away = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows() {
          return {
            kind: "restricted",
            inChat: false,
            untilDate: null,
            permissions: off,
          };
        },
      },
      ...kit(),
    });
    expect(away.status).toBe("reply");
    if (away.status === "reply") {
      expect(away.text.startsWith("群 -100 77\n人 不在\n发言 off")).toBe(true);
      expect(away.text).not.toContain("直到");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readMemberAllows() {
          return { kind: "none" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100 77", "individual none"].join("\n"),
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/allows -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/allows -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/allows <chatId> <actorId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/allows -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const unknown = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows() {
          return {
            kind: "restricted",
            inChat: true,
            untilDate: null,
            permissions: { ...off, sendMessages: "unknown" },
          };
        },
      },
      ...kit(),
    });
    expect(unknown).toMatchObject({ text: "参数无效" });

    const missing = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/allows -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAllows() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/allows -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readMemberAllows() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reads one member's admin rights", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin(target) {
          seen.push(target.actorId);
          return {
            kind: "admin",
            editable: "on",
            admin: {
              actorId: "77",
              bot: false,
              role: "administrator",
              anonymous: false,
              rights: ["manageChat"],
            },
          };
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: ["群 -100 77", "77 管理员 管理 可改 on"].join("\n"),
    });
    expect(seen).toEqual(["77"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/canadmin <chatId> <actorId>");
    }

    const creator = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          return {
            kind: "admin",
            editable: null,
            admin: {
              actorId: "77",
              bot: false,
              role: "creator",
              anonymous: false,
              rights: [],
            },
          };
        },
      },
      ...kit(),
    });
    expect(creator).toMatchObject({
      text: ["群 -100 77", "77 创建者"].join("\n"),
    });
    expect(JSON.stringify(creator)).not.toContain("可改");
    expect(JSON.stringify(creator)).not.toContain("管理");

    const quiet = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          return {
            kind: "admin",
            editable: "off",
            admin: {
              actorId: "77",
              bot: true,
              role: "administrator",
              anonymous: true,
              rights: [],
            },
          };
        },
      },
      ...kit(),
    });
    expect(quiet).toMatchObject({
      text: ["群 -100 77", "77 机器人 管理员 匿名 可改 off"].join("\n"),
    });

    const open = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          return { kind: "none" };
        },
      },
      ...kit(),
    });
    expect(open).toMatchObject({
      text: ["群 -100 77", "管理员 无"].join("\n"),
    });
    expect(JSON.stringify(open)).not.toContain("可改");

    const english = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readMemberAdmin() {
          return { kind: "none" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100 77", "admin none"].join("\n"),
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/canadmin -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/canadmin <chatId> <actorId>",
    });

    const invalid = await runOperatorCommand({
      event: event({ text: `/canadmin -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const unknown = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          return {
            kind: "admin",
            editable: "unknown",
            admin: {
              actorId: "77",
              bot: false,
              role: "administrator",
              anonymous: false,
              rights: ["manageChat"],
            },
          };
        },
      },
      ...kit(),
    });
    expect(unknown).toMatchObject({ text: "参数无效" });

    const mismatched = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          return {
            kind: "admin",
            editable: "on",
            admin: {
              actorId: "78",
              bot: false,
              role: "administrator",
              anonymous: false,
              rights: ["manageChat"],
            },
          };
        },
      },
      ...kit(),
    });
    expect(mismatched).toMatchObject({ text: "参数无效" });

    const missing = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/canadmin -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readMemberAdmin() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/canadmin -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readMemberAdmin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("reads this bot's admin rights in one chat", async () => {
    const deps = kit();
    const seen: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin(target) {
          seen.push(target.chatId);
          return {
            kind: "admin",
            botId: "9",
            editable: "on",
            admin: {
              actorId: "9",
              bot: true,
              role: "administrator",
              anonymous: false,
              rights: ["deleteMessages", "restrictMembers"],
            },
          };
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: ["群 -100 机器人 9", "9 机器人 管理员 删除 限制 可改 on"].join(
        "\n",
      ),
    });
    expect(seen).toEqual(["-100"]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/cani <chatId>");
    }

    const creator = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          return {
            kind: "admin",
            botId: "9",
            editable: null,
            admin: {
              actorId: "9",
              bot: true,
              role: "creator",
              anonymous: false,
              rights: [],
            },
          };
        },
      },
      ...kit(),
    });
    expect(creator).toMatchObject({
      text: ["群 -100 机器人 9", "9 机器人 创建者"].join("\n"),
    });
    expect(JSON.stringify(creator)).not.toContain("可改");

    const open = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          return { kind: "none", botId: "9" };
        },
      },
      ...kit(),
    });
    expect(open).toMatchObject({
      text: ["群 -100 机器人 9", "管理员 无"].join("\n"),
    });

    const english = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async readOwnAdmin() {
          return { kind: "none", botId: "9" };
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: ["chat -100 bot 9", "admin none"].join("\n"),
    });

    const skipped = await runOperatorCommand({
      event: event({ text: "/cani -100", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/cani", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/cani <chatId>" });

    const extra = await runOperatorCommand({
      event: event({ text: "/cani -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/cani <chatId>" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/cani ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const unnamed = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          return { kind: "none", botId: "bot" };
        },
      },
      ...kit(),
    });
    expect(unnamed).toMatchObject({ text: "参数无效" });

    const mismatched = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          return {
            kind: "admin",
            botId: "9",
            editable: "on",
            admin: {
              actorId: "8",
              bot: true,
              role: "administrator",
              anonymous: false,
              rights: ["deleteMessages"],
            },
          };
        },
      },
      ...kit(),
    });
    expect(mismatched).toMatchObject({ text: "参数无效" });

    const missing = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/cani -100", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async readOwnAdmin() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const foreign = await runOperatorCommand({
      event: event({ text: "/cani -200", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async readOwnAdmin() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
  });

  it("removes a member who can rejoin", async () => {
    const deps = kit();
    const kicked: { chatId: string; actorId: string }[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor(target) {
          kicked.push({ chatId: target.chatId, actorId: target.actorId });
          return "removed";
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已移出 -100 77" });
    expect(kicked).toEqual([{ chatId: "-100", actorId: "77" }]);
    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/kick <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async kickActor() {
          return "removed" as const;
        },
      },
      ...kit(),
    });
    expect(english).toMatchObject({ text: "Removed 77 from -100" });

    const away = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor() {
          return "absent" as const;
        },
      },
      ...kit(),
    });
    expect(away).toMatchObject({ text: "-100 77 不在群里" });

    const awayEn = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async kickActor() {
          return "absent" as const;
        },
      },
      ...kit(),
    });
    expect(awayEn).toMatchObject({ text: "77 is not in -100" });

    const admin = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor() {
          return "admin" as const;
        },
      },
      ...kit(),
    });
    expect(admin).toMatchObject({ text: "-100 77 是管理员" });

    const adminEn = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      moderator: {
        async kickActor() {
          return "admin" as const;
        },
      },
      ...kit(),
    });
    expect(adminEn).toMatchObject({ text: "77 is an admin in -100" });

    const skipped = await runOperatorCommand({
      event: event({ text: "/kick -100 77", chatId: "-100" }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor() {
          throw new Error(phrase);
        },
      },
      ...kit(),
    });
    expect(skipped.status).toBe("skip");

    const usage = await runOperatorCommand({
      event: event({ text: "/kick -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/kick <chatId> <actorId>" });

    const extra = await runOperatorCommand({
      event: event({ text: "/kick -100 77 1", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(extra).toMatchObject({ text: "用法：/kick <chatId> <actorId>" });

    const invalid = await runOperatorCommand({
      event: event({ text: `/kick -100 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);

    const failed = kit();
    const hidden = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async kickActor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(hidden).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);

    const missing = await runOperatorCommand({
      event: event({ text: "/kick -100 77", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });

    const foreign = await runOperatorCommand({
      event: event({ text: "/kick -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      moderator: {
        async kickActor() {
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
      text: "rule -100 spam_keywords disabled switch actions delete",
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
      text: "rule -100 via_inline enabled switch actions delete",
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
      text: "rule -100 via_inline disabled file actions delete",
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
      text: "rule -100 spam_keywords disabled switch actions delete",
    });
    const bare = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule via_inline on", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(bare).toMatchObject({
      text: "用法：/rule [chatId] <ruleId> [on|off|reset|file|log|report|captcha|decline|delete|warn|mute|ban]",
    });
    const status = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule -100 via_inline", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(status).toMatchObject({
      text: "rule -100 via_inline disabled file actions delete",
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
      text: "用法：/rule [chatId] <ruleId> [on|off|reset|file|log|report|captcha|decline|delete|warn|mute|ban]",
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
      text: "用法：/rule [chatId] <ruleId> [on|off|reset|file|log|report|captcha|decline|delete|warn|mute|ban]",
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
      text: "Usage: /rule [chatId] <ruleId> [on|off|reset|file|log|report|captcha|decline|delete|warn|mute|ban]",
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
      expect(help.text).toContain(
        "/rule [chatId] <ruleId> [on|off|reset|file|log|report|captcha|decline|delete|warn|mute|ban]",
      );
    }
  });

  it("replaces one rule action from private chat and leaves the file alone", async () => {
    const deps = kit();
    const file = ruleFile();
    const scoped = directory(["-100"]);
    const warned = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -100 spam_keywords warn",
        direct: true,
      }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(warned).toMatchObject({
      status: "reply",
      command: "rule",
      text: "rule -100 spam_keywords enabled file actions warn",
    });
    const listed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(listed).toMatchObject({ status: "reply" });
    if (listed.status === "reply") {
      expect(listed.text).toContain("spam_keywords enabled file");
      expect(listed.text).toContain("actions warn");
      expect(listed.text).toContain("via_inline disabled file");
    }
    const off = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -100 spam_keywords off",
        direct: true,
      }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(off).toMatchObject({
      text: "rule -100 spam_keywords disabled switch actions warn",
    });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -200", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(other).toMatchObject({ status: "reply" });
    if (other.status === "reply") {
      expect(other.text).toContain("actions delete");
      expect(other.text).not.toContain("actions warn");
    }
    const restored = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -100 spam_keywords file",
        direct: true,
      }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(restored).toMatchObject({
      text: "rule -100 spam_keywords disabled switch actions delete",
    });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rules -100", direct: true }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(again).toMatchObject({ status: "reply" });
    if (again.status === "reply") {
      expect(again.text).toContain("actions delete");
      expect(again.text).not.toContain("actions warn");
    }
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule -100 spam_keywords mute" }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -200 spam_keywords ban",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
      source: file,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const allowed = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -100 spam_keywords allow",
        direct: true,
      }),
      adminActorIds: ["42"],
      source: file,
    });
    expect(allowed).toMatchObject({
      text: "用法：/rule [chatId] <ruleId> [on|off|reset|file|log|report|captcha|decline|delete|warn|mute|ban]",
    });
    const full = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rule -100 via_inline mute",
        direct: true,
      }),
      adminActorIds: ["42"],
      source: file,
      runtime: {
        ...deps.runtime,
        async setRuleAction() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("rule_action_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rule -100 spam_keywords", direct: true }),
      adminActorIds: ["42"],
      source: file,
      runtime: {
        ...deps.runtime,
        async listRuleActions() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("asks someone already in the chat to pass the button check", async () => {
    const deps = kit();
    const store = memoryCaptcha();
    const restricted: {
      chatId: string;
      actorId: string;
      durationSeconds: number;
    }[] = [];
    const deleted: string[] = [];
    const nonce = "0123456789abcdef";
    const done = await runOperatorCommand({
      event: event({ text: "/captcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor(target) {
          restricted.push({
            chatId: target.chatId,
            actorId: target.actorId,
            durationSeconds: target.durationSeconds,
          });
        },
        async deleteMessage(target) {
          deleted.push(target.messageId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({
      text: "已要求验证 -100 77",
      issuedChallenge: { chatId: "-100", actorId: "77" },
    });
    expect(done).not.toMatchObject({ text: expect.stringContaining(nonce) });
    expect(restricted).toEqual([
      { chatId: "-100", actorId: "77", durationSeconds: 300 },
    ]);
    const saved = await store.get("local", "-100", "77");
    expect(saved?.nonce).toBe(nonce);
    expect(saved?.expiresAt).toBe("2026-11-01T00:05:00.000Z");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(nonce);

    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(help.status).toBe("reply");
    if (help.status === "reply") {
      expect(help.text).toContain("\n/captcha <chatId> <actorId>");
    }

    const english = await runOperatorCommand({
      event: event({ text: "/captcha -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      captcha: memoryCaptcha(),
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Asked 77 in -100 to pass the check",
    });

    await store.put(
      parseCaptchaChallenge({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        nonce,
        expiresAt: "2026-11-01T00:05:00.000Z",
        messageId: "15",
      }),
    );
    const again = await runOperatorCommand({
      event: event({ text: "/captcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => "abcdef0123456789",
      moderator: {
        async restrictActor() {},
        async deleteMessage(target) {
          deleted.push(target.messageId);
        },
      },
      ...kit(),
    });
    expect(again).toMatchObject({
      issuedChallenge: { chatId: "-100", actorId: "77" },
    });
    expect(deleted).toEqual(["15"]);
    expect((await store.get("local", "-100", "77"))?.nonce).toBe(
      "abcdef0123456789",
    );

    const usage = await runOperatorCommand({
      event: event({ text: "/captcha -100", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({ text: "用法：/captcha <chatId> <actorId>" });

    const odd = await runOperatorCommand({
      event: event({ text: "/captcha -100 abc", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(odd).toMatchObject({ text: "参数无效" });

    const grouped = await runOperatorCommand({
      event: event({ text: "/captcha -100 77" }),
      adminActorIds: ["42"],
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(grouped).toEqual({ status: "skip" });

    const foreign = await runOperatorCommand({
      event: event({ text: "/captcha -200 77", direct: true, actorId: "7" }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });

    const failed = kit();
    const failedStore = memoryCaptcha();
    const rejected = await runOperatorCommand({
      event: event({ text: "/captcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: failedStore,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => nonce,
      moderator: {
        async restrictActor() {
          throw new Error(phrase);
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(await failedStore.get("local", "-100", "77")).toBeNull();
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain(nonce);
  });

  it("cancels a pending captcha and opens the chat again", async () => {
    const deps = kit();
    const store = memoryCaptcha();
    const nonce = "0123456789abcdef";
    await store.put(
      parseCaptchaChallenge({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        nonce,
        expiresAt: "2026-11-01T00:05:00.000Z",
        messageId: "55",
      }),
    );
    const released: { chatId: string; actorId: string }[] = [];
    const deleted: string[] = [];
    const done = await runOperatorCommand({
      event: event({ text: "/uncaptcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      moderator: {
        async releaseActor(target) {
          released.push({ chatId: target.chatId, actorId: target.actorId });
        },
        async deleteMessage(target) {
          deleted.push(target.messageId);
        },
      },
      ...deps,
    });
    expect(done).toMatchObject({ text: "已取消验证 -100 77" });
    expect(released).toEqual([{ chatId: "-100", actorId: "77" }]);
    expect(deleted).toEqual(["55"]);
    expect(await store.get("local", "-100", "77")).toBeNull();
    expect(JSON.stringify(deps.logger.entries)).not.toContain(nonce);

    const help = await runOperatorCommand({
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    if (help.status === "reply") {
      expect(help.text).toContain("\n/uncaptcha <chatId> <actorId>");
    }

    const englishStore = memoryCaptcha();
    await englishStore.put(
      parseCaptchaChallenge({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        nonce,
        expiresAt: "2026-11-01T00:05:00.000Z",
      }),
    );
    const english = await runOperatorCommand({
      event: event({ text: "/uncaptcha -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      captcha: englishStore,
      moderator: {
        async releaseActor() {},
      },
      ...kit(),
    });
    expect(english).toMatchObject({
      text: "Cancelled the check for 77 in -100",
    });
    expect(await englishStore.get("local", "-100", "77")).toBeNull();

    const absent = await runOperatorCommand({
      event: event({ text: "/uncaptcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: memoryCaptcha(),
      moderator: {
        async releaseActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(absent).toMatchObject({ text: "-100 77 没有待验证" });

    const usage = await runOperatorCommand({
      event: event({ text: "/uncaptcha -100", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      moderator: {
        async releaseActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(usage).toMatchObject({
      text: "用法：/uncaptcha <chatId> <actorId>",
    });

    const grouped = await runOperatorCommand({
      event: event({ text: "/uncaptcha -100 77" }),
      adminActorIds: ["42"],
      captcha: store,
      moderator: {
        async releaseActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(grouped).toEqual({ status: "skip" });

    const foreign = await runOperatorCommand({
      event: event({
        text: "/uncaptcha -200 77",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      captcha: store,
      moderator: {
        async releaseActor() {
          throw new Error("called");
        },
      },
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });

    const failed = kit();
    const failedStore = memoryCaptcha();
    await failedStore.put(
      parseCaptchaChallenge({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        nonce,
        expiresAt: "2026-11-01T00:05:00.000Z",
        messageId: "55",
      }),
    );
    const rejected = await runOperatorCommand({
      event: event({ text: "/uncaptcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: failedStore,
      moderator: {
        async releaseActor() {
          throw new Error(phrase);
        },
        async deleteMessage() {
          throw new Error("deleted");
        },
      },
      ...failed,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(await failedStore.get("local", "-100", "77")).toMatchObject({
      nonce,
      messageId: "55",
    });
    expect(JSON.stringify(failed.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(failed.logger.entries)).not.toContain(nonce);
  });

  it("warns a member and bans on the third warning", async () => {
    const deps = kit();
    const warns = createMemoryWarnStore();
    const banned: { chatId: string; actorId: string }[] = [];
    const first = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(first).toMatchObject({ text: "已警告 -100 77 1/3" });
    expect(banned).toEqual([]);
    await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    const third = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(third).toMatchObject({ text: "已警告并封禁 -100 77" });
    expect(banned).toEqual([{ chatId: "-100", actorId: "77" }]);
    const again = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(again).toMatchObject({ text: "-100 77 已达 3 次警告" });
    expect(banned).toHaveLength(1);
    const shown = await runOperatorCommand({
      event: event({ text: "/warns -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(shown).toMatchObject({ text: "-100 77 警告 3/3" });
    const listed = await runOperatorCommand({
      event: event({ text: "/warns -100", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(listed).toMatchObject({ text: "-100\n77 3/3" });
    expect(JSON.stringify(listed)).not.toContain(phrase);
  });

  it("lists warnings for one chat and skips the others", async () => {
    const deps = kit();
    const warns = createMemoryWarnStore();
    await warns.write({ tenantId: "local", chatId: "-100", actorId: "10" }, 1);
    await warns.write({ tenantId: "local", chatId: "-100", actorId: "9" }, 3);
    await warns.write({ tenantId: "local", chatId: "-100", actorId: "8" }, 3);
    await warns.write({ tenantId: "local", chatId: "-200", actorId: "9" }, 2);
    const listed = await runOperatorCommand({
      event: event({ text: "/warns -100", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(listed).toMatchObject({ text: "-100\n8 3/3\n9 3/3\n10 1/3" });
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const empty = await runOperatorCommand({
      event: event({ text: "/warns -300", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(empty).toMatchObject({ text: "-300 没有警告" });
    const english = await runOperatorCommand({
      event: event({ text: "/warns -300", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      warns,
      ...deps,
    });
    expect(english).toMatchObject({ text: "No warnings in -300" });
    const usage = await runOperatorCommand({
      event: event({ text: "/warns -100 77 extra", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(usage).toMatchObject({
      text: "用法：/warns <chatId> [actorId]",
    });
    const foreign = await runOperatorCommand({
      event: event({
        text: "/warns -200",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      warns,
      ...deps,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const grouped = await runOperatorCommand({
      event: event({ text: "/warns -100" }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(grouped.status).not.toBe("reply");
    const bad = await runOperatorCommand({
      event: event({ text: "/warns chat", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(bad).toMatchObject({ text: "参数无效" });
    const missing = await runOperatorCommand({
      event: event({ text: "/warns -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const logged = kit();
    const broken = {
      async read(): Promise<number> {
        return 0;
      },
      async increment(): Promise<number> {
        return 1;
      },
      async write(): Promise<void> {
        return;
      },
      async clear(): Promise<boolean> {
        return false;
      },
      async list(): Promise<readonly { actorId: string; count: number }[]> {
        throw new Error(phrase);
      },
      async readLimit(): Promise<number> {
        return 3;
      },
      async writeLimit(): Promise<void> {
        return;
      },
    };
    const failed = await runOperatorCommand({
      event: event({ text: "/warns -100", direct: true }),
      adminActorIds: ["42"],
      warns: broken,
      ...logged,
    });
    expect(failed).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(logged.logger.entries)).toContain(
      "operator_rejected",
    );
    expect(JSON.stringify(logged.logger.entries)).not.toContain(phrase);
  });

  it("sets a warning limit for one chat", async () => {
    const deps = kit();
    const warns = createMemoryWarnStore();
    let called = 0;
    const moderator = {
      async banActor() {
        called += 1;
      },
    };
    const shown = await runOperatorCommand({
      event: event({ text: "/warnlimit -100", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator,
      ...deps,
    });
    expect(shown).toMatchObject({ text: "-100 警告上限 3" });
    const set = await runOperatorCommand({
      event: event({ text: "/warnlimit -100 5", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator,
      ...deps,
    });
    expect(set).toMatchObject({ text: "已设置 -100 警告上限 5" });
    expect(await warns.readLimit("local", "-100")).toBe(5);
    expect(await warns.readLimit("local", "-200")).toBe(3);
    const again = await runOperatorCommand({
      event: event({ text: "/warnlimit -100", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator,
      ...deps,
    });
    expect(again).toMatchObject({ text: "-100 警告上限 5" });
    const english = await runOperatorCommand({
      event: event({ text: "/warnlimit -100 reset", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      warns,
      moderator,
      ...deps,
    });
    expect(english).toMatchObject({
      text: "Set the warning limit for -100 to 3",
    });
    expect(await warns.readLimit("local", "-100")).toBe(3);
    const usage = await runOperatorCommand({
      event: event({ text: "/warnlimit -100 5 extra", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(usage).toMatchObject({
      text: "用法：/warnlimit <chatId> [limit|reset]",
    });
    const bad = await runOperatorCommand({
      event: event({ text: "/warnlimit -100 11", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(bad).toMatchObject({ text: "参数无效" });
    const nameless = await runOperatorCommand({
      event: event({ text: "/warnlimit chat", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(nameless).toMatchObject({ text: "参数无效" });
    const foreign = await runOperatorCommand({
      event: event({
        text: "/warnlimit -200 4",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      warns,
      ...deps,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const grouped = await runOperatorCommand({
      event: event({ text: "/warnlimit -100 4" }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(grouped.status).not.toBe("reply");
    expect(called).toBe(0);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const logged = kit();
    const broken = {
      async read(): Promise<number> {
        return 0;
      },
      async increment(): Promise<number> {
        return 1;
      },
      async write(): Promise<void> {
        return;
      },
      async clear(): Promise<boolean> {
        return false;
      },
      async list(): Promise<readonly { actorId: string; count: number }[]> {
        return [];
      },
      async readLimit(): Promise<number> {
        throw new Error(phrase);
      },
      async writeLimit(): Promise<void> {
        return;
      },
    };
    const failed = await runOperatorCommand({
      event: event({ text: "/warnlimit -100", direct: true }),
      adminActorIds: ["42"],
      warns: broken,
      ...logged,
    });
    expect(failed).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(logged.logger.entries)).toContain(
      "operator_rejected",
    );
    expect(JSON.stringify(logged.logger.entries)).not.toContain(phrase);
    const unwritable = {
      async read(): Promise<number> {
        return 0;
      },
      async increment(): Promise<number> {
        return 1;
      },
      async write(): Promise<void> {
        return;
      },
      async clear(): Promise<boolean> {
        return false;
      },
      async list(): Promise<readonly { actorId: string; count: number }[]> {
        return [];
      },
      async readLimit(): Promise<number> {
        return 3;
      },
      async writeLimit(): Promise<void> {
        throw new Error(phrase);
      },
    };
    const rejected = await runOperatorCommand({
      event: event({ text: "/warnlimit -100 4", direct: true }),
      adminActorIds: ["42"],
      warns: unwritable,
      ...logged,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(logged.logger.entries)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/warnlimit -100", direct: true }),
      adminActorIds: ["42"],
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "参数无效" });
  });

  it("sends one chat's reports to a chosen chat", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "report",
      text: "-100 上报默认",
    });
    const set = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 77", direct: true }),
      adminActorIds: ["42"],
    });
    expect(set).toMatchObject({ text: "已设置 -100 上报到 77" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 上报 77" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 上报默认" });
    const same = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(same).toMatchObject({ text: "参数无效" });
    const kept = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(kept).toMatchObject({ text: "-100 上报 77" });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "-100 上报默认" });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 88", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({
      text: "Set reports for -100 to 88",
    });
    const englishShow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -300", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishShow).toMatchObject({
      text: "Reports for -300 use the default",
    });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 77 extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/report <chatId> [targetId|reset]",
    });
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 77" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/report -200 77",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/report -100 ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100 79", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async setReportChat() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("report_chat_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/report -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async getReportChat() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/report <chatId> [targetId|reset]");
    }
  });

  it("lets one chat tighten its flood window", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "flood",
      text: "-100 洪泛 5 条 / 10 秒",
    });
    const set = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 2", direct: true }),
      adminActorIds: ["42"],
    });
    expect(set).toMatchObject({ text: "已设置 -100 洪泛 2 条 / 10 秒" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 洪泛 2 条 / 10 秒" });
    const widened = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 4 20", direct: true }),
      adminActorIds: ["42"],
    });
    expect(widened).toMatchObject({ text: "已设置 -100 洪泛 4 条 / 20 秒" });
    const keptWindow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 8", direct: true }),
      adminActorIds: ["42"],
    });
    expect(keptWindow).toMatchObject({ text: "已设置 -100 洪泛 8 条 / 20 秒" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 洪泛 5 条 / 10 秒" });
    const low = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 1", direct: true }),
      adminActorIds: ["42"],
    });
    expect(low).toMatchObject({ text: "参数无效" });
    const still = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(still).toMatchObject({ text: "-100 洪泛 8 条 / 20 秒" });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "已设置 -100 洪泛 5 条 / 10 秒" });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 8 20", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({
      text: "Set flood for -100 to 8 in 20s",
    });
    const englishShow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -300", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishShow).toMatchObject({
      text: "Flood for -300 is 5 in 10s",
    });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 8 20 extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/flood <chatId> [count [seconds]|reset]",
    });
    const resetUsage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 reset extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(resetUsage).toMatchObject({
      text: "用法：/flood <chatId> [count [seconds]|reset]",
    });
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 2" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/flood -200 2",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/flood -100 ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100 6", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async setFloodPolicy() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("flood_policy_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/flood -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async getFloodPolicy() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/flood <chatId> [count [seconds]|reset]");
    }
  });

  it("adds one chat's extra keyword and leaves the other chat alone", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "keyword",
      text: "-100 关键词 0",
    });
    const added = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 add 发票", direct: true }),
      adminActorIds: ["42"],
    });
    expect(added).toMatchObject({ text: "已添加 -100 关键词 1" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 关键词 1\n发票" });
    const second = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 add 代开", direct: true }),
      adminActorIds: ["42"],
    });
    expect(second).toMatchObject({ text: "已添加 -100 关键词 2" });
    const listed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(listed).toMatchObject({ text: "-100 关键词 2\n发票\n代开" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 关键词 0" });
    const removed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 remove 发票", direct: true }),
      adminActorIds: ["42"],
    });
    expect(removed).toMatchObject({ text: "已移除 -100 关键词 1" });
    const absent = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 remove 发票", direct: true }),
      adminActorIds: ["42"],
    });
    expect(absent).toMatchObject({ text: "没有这个关键词" });
    expect(JSON.stringify(absent)).not.toContain("发票");
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "-100 关键词 0" });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 add VIP", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({ text: "Added a keyword to -100, now 1" });
    const englishShow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishShow).toMatchObject({ text: "Keywords for -100: 1\nvip" });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: `/keyword -100 add 发票 ${phrase}`, direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/keyword <chatId> [add|remove <token>|reset]",
    });
    expect(JSON.stringify(usage)).not.toContain(phrase);
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/keyword -100 add ${"a".repeat(33)}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain("a".repeat(33));
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 add 发票" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/keyword -200 add 发票",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100 add 新词", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async addKeyword() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("keyword_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain("新词");
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/keyword -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async listKeywords() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("lets one chat tighten its repeat window", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "repeat",
      text: "-100 重复 3 条 / 60 秒",
    });
    const set = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 2", direct: true }),
      adminActorIds: ["42"],
    });
    expect(set).toMatchObject({ text: "已设置 -100 重复 2 条 / 60 秒" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 重复 2 条 / 60 秒" });
    const widened = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 4 20", direct: true }),
      adminActorIds: ["42"],
    });
    expect(widened).toMatchObject({ text: "已设置 -100 重复 4 条 / 20 秒" });
    const keptWindow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 8", direct: true }),
      adminActorIds: ["42"],
    });
    expect(keptWindow).toMatchObject({ text: "已设置 -100 重复 8 条 / 20 秒" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 重复 3 条 / 60 秒" });
    const low = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 1", direct: true }),
      adminActorIds: ["42"],
    });
    expect(low).toMatchObject({ text: "参数无效" });
    const still = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(still).toMatchObject({ text: "-100 重复 8 条 / 20 秒" });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "已设置 -100 重复 3 条 / 60 秒" });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 8 20", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({
      text: "Set repeat for -100 to 8 in 20s",
    });
    const englishShow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -300", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishShow).toMatchObject({
      text: "Repeat for -300 is 3 in 60s",
    });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 8 20 extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/repeat <chatId> [count [seconds]|reset]",
    });
    const resetUsage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 reset extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(resetUsage).toMatchObject({
      text: "用法：/repeat <chatId> [count [seconds]|reset]",
    });
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 2" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/repeat -200 2",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/repeat -100 ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100 6", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async setRepeatPolicy() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("repeat_policy_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/repeat -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async getRepeatPolicy() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/repeat <chatId> [count [seconds]|reset]");
    }
  });

  it("lets one chat shorten the automatic mute", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "rulemute",
      text: "-100 规则禁言 3600 秒",
    });
    const set = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 120", direct: true }),
      adminActorIds: ["42"],
    });
    expect(set).toMatchObject({ text: "已设置 -100 规则禁言 120 秒" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 规则禁言 120 秒" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 规则禁言 3600 秒" });
    const low = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 29", direct: true }),
      adminActorIds: ["42"],
    });
    expect(low).toMatchObject({ text: "参数无效" });
    const still = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(still).toMatchObject({ text: "-100 规则禁言 120 秒" });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "已设置 -100 规则禁言 3600 秒" });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 120", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({ text: "Set rule mute for -100 to 120s" });
    const englishShow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -300", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishShow).toMatchObject({ text: "Rule mute for -300 is 3600s" });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 120 extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/rulemute <chatId> [seconds|reset]",
    });
    const resetUsage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 reset extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(resetUsage).toMatchObject({
      text: "用法：/rulemute <chatId> [seconds|reset]",
    });
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 120" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/rulemute -200 120",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/rulemute -100 ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100 90", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async setMuteDuration() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("mute_duration_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/rulemute -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async getMuteDuration() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const muted: { durationSeconds: number }[] = [];
    const manual = await runOperatorCommand({
      ...deps,
      event: event({ text: "/mute -100 77", direct: true }),
      adminActorIds: ["42"],
      moderator: {
        async muteActor(target) {
          muted.push({ durationSeconds: target.durationSeconds });
        },
      },
    });
    expect(manual).toMatchObject({ text: "已禁言 -100 77 3600 秒" });
    expect(muted).toEqual([{ durationSeconds: 3600 }]);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/rulemute <chatId> [seconds|reset]");
    }
  });

  it("lets one chat shorten verification and uses that window for /captcha", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "verifyfor",
      text: "-100 验证 300 秒",
    });
    const set = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 120", direct: true }),
      adminActorIds: ["42"],
    });
    expect(set).toMatchObject({ text: "已设置 -100 验证 120 秒" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 验证 120 秒" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 验证 300 秒" });
    const low = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 29", direct: true }),
      adminActorIds: ["42"],
    });
    expect(low).toMatchObject({ text: "参数无效" });
    const still = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(still).toMatchObject({ text: "-100 验证 120 秒" });
    const day = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 86400", direct: true }),
      adminActorIds: ["42"],
    });
    expect(day).toMatchObject({ text: "已设置 -100 验证 86400 秒" });
    const tooLong = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 86401", direct: true }),
      adminActorIds: ["42"],
    });
    expect(tooLong).toMatchObject({ text: "参数无效" });
    const kept = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(kept).toMatchObject({ text: "-100 验证 86400 秒" });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "已设置 -100 验证 300 秒" });
    await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 120", direct: true }),
      adminActorIds: ["42"],
    });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({ text: "Verification for -100 is 120s" });
    const englishSet = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -300 90", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishSet).toMatchObject({
      text: "Set verification for -300 to 90s",
    });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 120 extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/verifyfor <chatId> [seconds|reset]",
    });
    const resetUsage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 reset extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(resetUsage).toMatchObject({
      text: "用法：/verifyfor <chatId> [seconds|reset]",
    });
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 120" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/verifyfor -200 120",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/verifyfor -100 ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100 90", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async setCaptchaTtl() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("captcha_ttl_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfor -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async getCaptchaTtl() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const store = memoryCaptcha();
    const restricted: { chatId: string; durationSeconds: number }[] = [];
    const challenged = await runOperatorCommand({
      ...deps,
      event: event({ text: "/captcha -100 77", direct: true }),
      adminActorIds: ["42"],
      captcha: store,
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => "0123456789abcdef",
      moderator: {
        async restrictActor(target) {
          restricted.push({
            chatId: target.chatId,
            durationSeconds: target.durationSeconds,
          });
        },
      },
    });
    expect(challenged).toMatchObject({ text: "已要求验证 -100 77" });
    expect(restricted).toEqual([{ chatId: "-100", durationSeconds: 120 }]);
    expect((await store.get("local", "-100", "77"))?.expiresAt).toBe(
      "2026-11-01T00:02:00.000Z",
    );
    const untouched: { durationSeconds: number }[] = [];
    const failedChallenge = await runOperatorCommand({
      ...deps,
      event: event({ text: "/captcha -200 77", direct: true }),
      adminActorIds: ["42"],
      captcha: memoryCaptcha(),
      clock: createFixedClock("2026-11-01T00:00:00.000Z"),
      createNonce: () => "fedcba9876543210",
      moderator: {
        async restrictActor(target) {
          untouched.push({ durationSeconds: target.durationSeconds });
        },
      },
      runtime: {
        ...deps.runtime,
        async getCaptchaTtl() {
          throw new Error(phrase);
        },
      },
    });
    expect(failedChallenge).toMatchObject({ text: "参数无效" });
    expect(untouched).toEqual([]);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/verifyfor <chatId> [seconds|reset]");
    }
  });

  it("lets one chat kick people who miss verification", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "verifyfail",
      text: "-100 验证失败后留下",
    });
    const set = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 kick", direct: true }),
      adminActorIds: ["42"],
    });
    expect(set).toMatchObject({ text: "已设置 -100 验证失败后移出" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 验证失败后移出" });
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 验证失败后留下" });
    const bad = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 leave", direct: true }),
      adminActorIds: ["42"],
    });
    expect(bad).toMatchObject({ text: "参数无效" });
    const still = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(still).toMatchObject({ text: "-100 验证失败后移出" });
    const ban = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 ban", direct: true }),
      adminActorIds: ["42"],
    });
    expect(ban).toMatchObject({ text: "已设置 -100 验证失败后封禁" });
    const stay = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 stay", direct: true }),
      adminActorIds: ["42"],
    });
    expect(stay).toMatchObject({ text: "已设置 -100 验证失败后留下" });
    await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 kick", direct: true }),
      adminActorIds: ["42"],
    });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "已设置 -100 验证失败后留下" });
    await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 kick", direct: true }),
      adminActorIds: ["42"],
    });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({
      text: "Verification failure for -100 is kick",
    });
    const englishSet = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -300 ban", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishSet).toMatchObject({
      text: "Set verification failure for -300 to ban",
    });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 kick extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/verifyfail <chatId> [stay|kick|ban|reset]",
    });
    const resetUsage = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 reset extra", direct: true }),
      adminActorIds: ["42"],
    });
    expect(resetUsage).toMatchObject({
      text: "用法：/verifyfail <chatId> [stay|kick|ban|reset]",
    });
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 kick" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/verifyfail -200 kick",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const noisy = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/verifyfail -100 ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(noisy).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(noisy)).not.toContain(phrase);
    const full = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100 ban", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async setCaptchaFail() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("captcha_fail_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/verifyfail -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async getCaptchaFail() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const help = await runOperatorCommand({
      ...deps,
      event: event({ text: "/help", direct: true }),
      adminActorIds: ["42"],
    });
    expect(help).toMatchObject({ status: "reply" });
    if (help.status === "reply") {
      expect(help.text).toContain("/verifyfail <chatId> [stay|kick|ban|reset]");
      expect(help.text).toContain(
        "/allowhost <chatId> [add|remove <host>|reset]",
      );
    }
  });

  it("lets one chat keep a short link host", async () => {
    const deps = kit();
    const scoped = directory(["-100"]);
    const shown = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(shown).toMatchObject({
      status: "reply",
      command: "allowhost",
      text: "-100 放行主机 0",
    });
    const added = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 add bit.ly", direct: true }),
      adminActorIds: ["42"],
    });
    expect(added).toMatchObject({ text: "已添加 -100 放行主机 1" });
    const again = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(again).toMatchObject({ text: "-100 放行主机 1\nbit.ly" });
    const duplicate = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 add bit.ly", direct: true }),
      adminActorIds: ["42"],
    });
    expect(duplicate).toMatchObject({ text: "已添加 -100 放行主机 1" });
    const folded = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/allowhost -100 add bit\uFF0Ely",
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(folded).toMatchObject({ text: "已添加 -100 放行主机 1" });
    expect(JSON.stringify(folded)).not.toContain("\uFF0E");
    const other = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -200", direct: true }),
      adminActorIds: ["42"],
    });
    expect(other).toMatchObject({ text: "-200 放行主机 0" });
    const path = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/allowhost -100 add bit.ly/secret",
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(path).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(path)).not.toContain("secret");
    const still = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100", direct: true }),
      adminActorIds: ["42"],
    });
    expect(still).toMatchObject({ text: "-100 放行主机 1\nbit.ly" });
    const removed = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 remove bit.ly", direct: true }),
      adminActorIds: ["42"],
    });
    expect(removed).toMatchObject({ text: "已移除 -100 放行主机 0" });
    const absent = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 remove bit.ly", direct: true }),
      adminActorIds: ["42"],
    });
    expect(absent).toMatchObject({ text: "没有这个主机" });
    expect(JSON.stringify(absent)).not.toContain("bit.ly");
    const restored = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 add example.com", direct: true }),
      adminActorIds: ["42"],
    });
    expect(restored).toMatchObject({ text: "已添加 -100 放行主机 1" });
    const reset = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 reset", direct: true }),
      adminActorIds: ["42"],
    });
    expect(reset).toMatchObject({ text: "-100 放行主机 0" });
    const english = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 add Bit.LY", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english).toMatchObject({
      text: "Added an allowed host to -100, now 1",
    });
    const englishShow = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(englishShow).toMatchObject({
      text: "Allowed hosts for -100: 1\nbit.ly",
    });
    const usage = await runOperatorCommand({
      ...deps,
      event: event({
        text: `/allowhost -100 add bit.ly ${phrase}`,
        direct: true,
      }),
      adminActorIds: ["42"],
    });
    expect(usage).toMatchObject({
      text: "用法：/allowhost <chatId> [add|remove <host>|reset]",
    });
    expect(JSON.stringify(usage)).not.toContain(phrase);
    const group = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100 add bit.ly" }),
      adminActorIds: ["42"],
    });
    expect(group).toMatchObject({ status: "skip" });
    const foreign = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/allowhost -200 add bit.ly",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: scoped,
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const full = await runOperatorCommand({
      ...deps,
      event: event({
        text: "/allowhost -100 add tinyurl.com",
        direct: true,
      }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async addAllowHost() {
          return false;
        },
      },
    });
    expect(full).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("allow_host_full");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    expect(JSON.stringify(deps.logger.entries)).not.toContain("tinyurl.com");
    const broken = await runOperatorCommand({
      ...deps,
      event: event({ text: "/allowhost -100", direct: true }),
      adminActorIds: ["42"],
      runtime: {
        ...deps.runtime,
        async listAllowHosts() {
          throw new Error(phrase);
        },
      },
    });
    expect(broken).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(deps.logger.entries)).toContain("operator_rejected");
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
  });

  it("bans on the second warning when the chat limit is 2", async () => {
    const deps = kit();
    const warns = createMemoryWarnStore();
    await warns.writeLimit("local", "-100", 2);
    const banned: { chatId: string; actorId: string }[] = [];
    const first = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(first).toMatchObject({ text: "已警告 -100 77 1/2" });
    expect(banned).toEqual([]);
    const second = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor(target) {
          banned.push({ chatId: target.chatId, actorId: target.actorId });
        },
      },
      ...deps,
    });
    expect(second).toMatchObject({ text: "已警告并封禁 -100 77" });
    expect(banned).toEqual([{ chatId: "-100", actorId: "77" }]);
    const listed = await runOperatorCommand({
      event: event({ text: "/warns -100", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(listed).toMatchObject({ text: "-100\n77 2/2" });
    const shown = await runOperatorCommand({
      event: event({ text: "/warns -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(shown).toMatchObject({ text: "-100 77 警告 2/2" });
    expect(JSON.stringify(listed)).not.toContain(phrase);
  });

  it("rolls the third warning back when the ban fails", async () => {
    const deps = kit();
    const warns = createMemoryWarnStore();
    const target = { tenantId: "local", chatId: "-100", actorId: "77" };
    await warns.write(target, 2);
    const rejected = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async banActor() {
          throw new Error(phrase);
        },
      },
      ...deps,
    });
    expect(rejected).toMatchObject({ text: "参数无效" });
    expect(await warns.read(target)).toBe(2);
    expect(JSON.stringify(deps.logger.entries)).not.toContain(phrase);
    const missing = await runOperatorCommand({
      event: event({ text: "/warn -100 77 extra", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...kit(),
    });
    expect(missing).toMatchObject({ text: "用法：/warn <chatId> <actorId>" });
    const grouped = await runOperatorCommand({
      event: event({ text: "/warn -100 77" }),
      adminActorIds: ["42"],
      warns,
      ...kit(),
    });
    expect(grouped).toEqual({ status: "skip" });
    expect(await warns.read(target)).toBe(2);
  });

  it("clears a warning without lifting a ban", async () => {
    const deps = kit();
    const warns = createMemoryWarnStore();
    await warns.write({ tenantId: "local", chatId: "-100", actorId: "77" }, 2);
    let unbanned = 0;
    const cleared = await runOperatorCommand({
      event: event({ text: "/unwarn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      moderator: {
        async unbanActor() {
          unbanned += 1;
        },
      },
      ...deps,
    });
    expect(cleared).toMatchObject({ text: "已清除警告 -100 77" });
    expect(unbanned).toBe(0);
    const absent = await runOperatorCommand({
      event: event({ text: "/unwarn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(absent).toMatchObject({ text: "-100 77 没有警告" });
    const english = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      locale: "en",
      warns,
      ...deps,
    });
    expect(english).toMatchObject({
      text: "Warned 77 in -100 (1/3)",
    });
    const shown = await runOperatorCommand({
      event: event({ text: "/warns -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(shown).toMatchObject({ text: "-100 77 警告 1/3" });
  });

  it("rejects a warning that cannot be stored or enforced", async () => {
    const deps = kit();
    const missing = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      ...deps,
    });
    expect(missing).toMatchObject({ text: "参数无效" });
    const warns = createMemoryWarnStore();
    const target = { tenantId: "local", chatId: "-100", actorId: "77" };
    await warns.write(target, 2);
    const unenforced = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...deps,
    });
    expect(unenforced).toMatchObject({ text: "参数无效" });
    expect(await warns.read(target)).toBe(2);
    const invalid = await runOperatorCommand({
      event: event({ text: "/warn -100 abc", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...kit(),
    });
    expect(invalid).toMatchObject({ text: "参数无效" });
    const foreign = await runOperatorCommand({
      event: event({
        text: "/warn -200 77",
        direct: true,
        actorId: "7",
      }),
      adminActorIds: ["42"],
      chats: directory(["-100"]),
      warns,
      ...kit(),
    });
    expect(foreign).toMatchObject({ text: "没有权限" });
    const logged = kit();
    const broken = {
      async read(): Promise<number> {
        throw new Error(phrase);
      },
      async increment(): Promise<number> {
        return 1;
      },
      async write(): Promise<void> {
        return;
      },
      async clear(): Promise<boolean> {
        return false;
      },
      async list(): Promise<readonly { actorId: string; count: number }[]> {
        return [];
      },
      async readLimit(): Promise<number> {
        return 3;
      },
      async writeLimit(): Promise<void> {
        return;
      },
    };
    const unread = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns: broken,
      ...logged,
    });
    expect(unread).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(logged.logger.entries)).not.toContain(phrase);
    const capped = {
      async read(): Promise<number> {
        return 0;
      },
      async increment(): Promise<number> {
        throw new WarnCapacityError();
      },
      async write(): Promise<void> {
        return;
      },
      async clear(): Promise<boolean> {
        throw new Error(phrase);
      },
      async list(): Promise<readonly { actorId: string; count: number }[]> {
        return [];
      },
      async readLimit(): Promise<number> {
        return 3;
      },
      async writeLimit(): Promise<void> {
        return;
      },
    };
    const full = await runOperatorCommand({
      event: event({ text: "/warn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns: capped,
      ...kit(),
    });
    expect(full).toMatchObject({ text: "参数无效" });
    const unclearedLog = kit();
    const stuck = {
      async read(): Promise<number> {
        return 1;
      },
      async increment(): Promise<number> {
        return 1;
      },
      async write(): Promise<void> {
        return;
      },
      async clear(): Promise<boolean> {
        throw new Error(phrase);
      },
      async list(): Promise<readonly { actorId: string; count: number }[]> {
        return [];
      },
      async readLimit(): Promise<number> {
        return 3;
      },
      async writeLimit(): Promise<void> {
        return;
      },
    };
    const failedClear = await runOperatorCommand({
      event: event({ text: "/unwarn -100 77", direct: true }),
      adminActorIds: ["42"],
      warns: stuck,
      ...unclearedLog,
    });
    expect(failedClear).toMatchObject({ text: "参数无效" });
    expect(JSON.stringify(unclearedLog.logger.entries)).not.toContain(phrase);
    const uncleared = await runOperatorCommand({
      event: event({ text: "/unwarn -100", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...kit(),
    });
    expect(uncleared).toMatchObject({
      text: "用法：/unwarn <chatId> <actorId>",
    });
    const quiet = await runOperatorCommand({
      event: event({ text: "/warns -100 88", direct: true }),
      adminActorIds: ["42"],
      warns,
      ...kit(),
    });
    expect(quiet).toMatchObject({ text: "-100 88 没有警告" });
  });
});

function memoryCaptcha(): CaptchaStore {
  const values = new Map<string, ReturnType<typeof parseCaptchaChallenge>>();
  return {
    async get(tenantId, chatId, actorId) {
      return values.get(`${tenantId}:${chatId}:${actorId}`) ?? null;
    },
    async put(challenge) {
      const parsed = parseCaptchaChallenge(challenge);
      values.set(
        `${parsed.tenantId}:${parsed.chatId}:${parsed.actorId}`,
        parsed,
      );
    },
    async delete(tenantId, chatId, actorId) {
      values.delete(`${tenantId}:${chatId}:${actorId}`);
    },
    async deleteMany(challenges) {
      for (const challenge of challenges) {
        values.delete(
          `${challenge.tenantId}:${challenge.chatId}:${challenge.actorId}`,
        );
      }
    },
    async take(tenantId, chatId, actorId, nonce) {
      const current = values.get(`${tenantId}:${chatId}:${actorId}`);
      if (current === undefined || current.nonce !== nonce) {
        return null;
      }
      values.delete(`${tenantId}:${chatId}:${actorId}`);
      return current;
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
