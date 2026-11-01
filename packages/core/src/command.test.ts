import { describe, expect, it } from "vitest";
import type { Cache } from "./cache.js";
import { runOperatorCommand } from "./command.js";
import { parseEvent } from "./event.js";
import { createMemoryLogger } from "./logger.js";
import { loadPolicy } from "./policy-load.js";
import type { PolicyStore } from "./policy-store.js";
import type { AuditRecord, Storage } from "./ports.js";
import { parseAuditRecord } from "./ports.js";
import { prefilterPolicySchema } from "./prefilter.js";
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

function storage(): Storage & { readonly records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  return {
    records,
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
    async getRuleSet() {
      return null;
    },
    async putRuleSet() {
      return undefined;
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
});
