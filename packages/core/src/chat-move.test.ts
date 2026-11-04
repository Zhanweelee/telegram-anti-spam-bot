import { describe, expect, it } from "vitest";
import { copyMissingChatSettings } from "./chat-move.js";
import type { PolicyStore } from "./policy-store.js";
import type { PrefilterPolicy } from "./prefilter.js";
import type {
  FloodPolicy,
  RuleActionOverride,
  RuleSwitch,
  RuntimeStore,
} from "./runtime.js";

interface Saved {
  dry: Set<string>;
  switches: Map<string, RuleSwitch[]>;
  actions: Map<string, RuleActionOverride[]>;
  reports: Map<string, string>;
  floods: Map<string, FloodPolicy>;
  keywords: Map<string, string[]>;
  repeats: Map<string, FloodPolicy>;
  mutes: Map<string, number>;
  captchas: Map<string, number>;
  fails: Map<string, "kick" | "ban">;
  hosts: Map<string, string[]>;
  refuseSwitch: boolean;
  refuseMute: boolean;
  refuseKeywordAfter: number;
}

function savedRuntime(saved: Saved): RuntimeStore {
  return {
    async getDryRun(_tenantId, chatId) {
      return saved.dry.has(chatId);
    },
    async setDryRun(_tenantId, chatId, enabled) {
      if (enabled) {
        saved.dry.add(chatId);
        return;
      }
      saved.dry.delete(chatId);
    },
    async listRuleSwitches(_tenantId, chatId) {
      return saved.switches.get(chatId) ?? [];
    },
    async setRuleSwitch(_tenantId, chatId, ruleId, enabled) {
      if (saved.refuseSwitch) {
        return false;
      }
      const current = saved.switches.get(chatId) ?? [];
      saved.switches.set(chatId, [...current, { ruleId, enabled }]);
      return true;
    },
    async listRuleActions(_tenantId, chatId) {
      return saved.actions.get(chatId) ?? [];
    },
    async setRuleAction(_tenantId, chatId, ruleId, action) {
      const current = saved.actions.get(chatId) ?? [];
      saved.actions.set(chatId, [...current, { ruleId, action }]);
      return true;
    },
    async getReportChat(_tenantId, chatId) {
      return saved.reports.get(chatId) ?? null;
    },
    async setReportChat(_tenantId, chatId, targetId) {
      saved.reports.set(chatId, targetId);
      return true;
    },
    async getFloodPolicy(_tenantId, chatId) {
      return saved.floods.get(chatId) ?? null;
    },
    async setFloodPolicy(_tenantId, chatId, policy) {
      saved.floods.set(chatId, policy);
      return true;
    },
    async listKeywords(_tenantId, chatId) {
      return saved.keywords.get(chatId) ?? [];
    },
    async addKeyword(_tenantId, chatId, keyword) {
      const current = saved.keywords.get(chatId) ?? [];
      if (current.length >= saved.refuseKeywordAfter) {
        return false;
      }
      saved.keywords.set(chatId, [...current, keyword]);
      return true;
    },
    async getRepeatPolicy(_tenantId, chatId) {
      return saved.repeats.get(chatId) ?? null;
    },
    async setRepeatPolicy(_tenantId, chatId, policy) {
      saved.repeats.set(chatId, policy);
      return true;
    },
    async getMuteDuration(_tenantId, chatId) {
      return saved.mutes.get(chatId) ?? null;
    },
    async setMuteDuration(_tenantId, chatId, seconds) {
      if (saved.refuseMute) {
        return false;
      }
      saved.mutes.set(chatId, seconds);
      return true;
    },
    async getCaptchaTtl(_tenantId, chatId) {
      return saved.captchas.get(chatId) ?? null;
    },
    async setCaptchaTtl(_tenantId, chatId, seconds) {
      saved.captchas.set(chatId, seconds);
      return true;
    },
    async getCaptchaFail(_tenantId, chatId) {
      return saved.fails.get(chatId) ?? null;
    },
    async setCaptchaFail(_tenantId, chatId, action) {
      if (action !== "kick" && action !== "ban") {
        return false;
      }
      saved.fails.set(chatId, action);
      return true;
    },
    async listAllowHosts(_tenantId, chatId) {
      return saved.hosts.get(chatId) ?? [];
    },
    async addAllowHost(_tenantId, chatId, host) {
      const current = saved.hosts.get(chatId) ?? [];
      saved.hosts.set(chatId, [...current, host]);
      return true;
    },
    async clearRuleSwitch(_tenantId, chatId, ruleId) {
      const current = saved.switches.get(chatId) ?? [];
      saved.switches.set(
        chatId,
        current.filter((item) => item.ruleId !== ruleId),
      );
    },
    async clearRuleAction(_tenantId, chatId, ruleId) {
      const current = saved.actions.get(chatId) ?? [];
      saved.actions.set(
        chatId,
        current.filter((item) => item.ruleId !== ruleId),
      );
    },
    async clearReportChat(_tenantId, chatId) {
      saved.reports.delete(chatId);
    },
    async clearFloodPolicy(_tenantId, chatId) {
      saved.floods.delete(chatId);
    },
    async removeKeyword(_tenantId, chatId, keyword) {
      const current = saved.keywords.get(chatId) ?? [];
      saved.keywords.set(
        chatId,
        current.filter((item) => item !== keyword),
      );
      return current.includes(keyword);
    },
    async clearKeywords(_tenantId, chatId) {
      saved.keywords.delete(chatId);
    },
    async clearRepeatPolicy(_tenantId, chatId) {
      saved.repeats.delete(chatId);
    },
    async clearMuteDuration(_tenantId, chatId) {
      saved.mutes.delete(chatId);
    },
    async clearCaptchaTtl(_tenantId, chatId) {
      saved.captchas.delete(chatId);
    },
    async clearCaptchaFail(_tenantId, chatId) {
      saved.fails.delete(chatId);
    },
    async removeAllowHost(_tenantId, chatId, host) {
      const current = saved.hosts.get(chatId) ?? [];
      saved.hosts.set(
        chatId,
        current.filter((item) => item !== host),
      );
      return current.includes(host);
    },
    async clearAllowHosts(_tenantId, chatId) {
      saved.hosts.delete(chatId);
    },
  };
}

function blank(): Saved {
  return {
    dry: new Set(),
    switches: new Map(),
    actions: new Map(),
    reports: new Map(),
    floods: new Map(),
    keywords: new Map(),
    repeats: new Map(),
    mutes: new Map(),
    captchas: new Map(),
    fails: new Map(),
    hosts: new Map(),
    refuseSwitch: false,
    refuseMute: false,
    refuseKeywordAfter: 32,
  };
}

function policyStore(rows: Map<string, PrefilterPolicy>): PolicyStore {
  return {
    async get(_tenantId, chatId) {
      return rows.get(chatId) ?? null;
    },
    async put(_tenantId, chatId, policy) {
      rows.set(chatId, policy);
    },
  };
}

describe("copyMissingChatSettings", () => {
  it("copies settings that the new chat has not saved", async () => {
    const saved = blank();
    saved.dry.add("old");
    saved.switches.set("old", [{ ruleId: "link", enabled: false }]);
    saved.actions.set("old", [{ ruleId: "keyword", action: "mute" }]);
    saved.reports.set("old", "424242");
    saved.floods.set("old", { threshold: 8, windowSeconds: 20 });
    saved.keywords.set("old", ["迁移专属词", "第二个词"]);
    saved.repeats.set("old", { threshold: 4, windowSeconds: 30 });
    saved.mutes.set("old", 90);
    saved.captchas.set("old", 60);
    saved.fails.set("old", "ban");
    saved.hosts.set("old", ["example.com"]);
    const rows = new Map<string, PrefilterPolicy>([
      ["old", { exemptAdmins: false, allowActorIds: ["user_kept"] }],
    ]);
    const runtime = savedRuntime(saved);
    const copied = await copyMissingChatSettings({
      runtime,
      policy: policyStore(rows),
      tenantId: "tenant_a",
      fromChatId: "old",
      toChatId: "new",
    });
    expect(copied).toBe(13);
    expect(saved.dry.has("old")).toBe(true);
    expect(saved.dry.has("new")).toBe(true);
    expect(saved.switches.get("new")).toEqual([
      { ruleId: "link", enabled: false },
    ]);
    expect(saved.actions.get("new")).toEqual([
      { ruleId: "keyword", action: "mute" },
    ]);
    expect(saved.reports.get("new")).toBe("424242");
    expect(saved.floods.get("new")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(saved.keywords.get("new")).toEqual(["迁移专属词", "第二个词"]);
    expect(saved.keywords.get("old")).toEqual(["迁移专属词", "第二个词"]);
    expect(saved.repeats.get("new")).toEqual({
      threshold: 4,
      windowSeconds: 30,
    });
    expect(saved.mutes.get("new")).toBe(90);
    expect(saved.captchas.get("new")).toBe(60);
    expect(saved.fails.get("new")).toBe("ban");
    expect(saved.hosts.get("new")).toEqual(["example.com"]);
    expect(rows.get("new")).toEqual({
      exemptAdmins: false,
      allowActorIds: ["user_kept"],
    });
    expect(
      await copyMissingChatSettings({
        runtime,
        policy: policyStore(rows),
        tenantId: "tenant_a",
        fromChatId: "old",
        toChatId: "new",
      }),
    ).toBe(0);
  });

  it("leaves settings the new chat already saved", async () => {
    const saved = blank();
    saved.switches.set("old", [{ ruleId: "link", enabled: true }]);
    saved.switches.set("kept", [{ ruleId: "forum_notice", enabled: true }]);
    saved.keywords.set("old", ["迁移专属词"]);
    saved.keywords.set("kept", ["已有词"]);
    saved.floods.set("old", { threshold: 8, windowSeconds: 20 });
    saved.floods.set("kept", { threshold: 2, windowSeconds: 1 });
    saved.mutes.set("old", 90);
    saved.refuseMute = true;
    saved.refuseSwitch = true;
    const rows = new Map<string, PrefilterPolicy>([
      ["old", { exemptAdmins: true, allowActorIds: ["user_old"] }],
      ["kept", { exemptAdmins: false, allowActorIds: ["user_kept"] }],
    ]);
    const copied = await copyMissingChatSettings({
      runtime: savedRuntime(saved),
      policy: policyStore(rows),
      tenantId: "tenant_a",
      fromChatId: "old",
      toChatId: "kept",
    });
    expect(copied).toBe(0);
    expect(saved.switches.get("kept")).toEqual([
      { ruleId: "forum_notice", enabled: true },
    ]);
    expect(saved.keywords.get("kept")).toEqual(["已有词"]);
    expect(saved.floods.get("kept")).toEqual({
      threshold: 2,
      windowSeconds: 1,
    });
    expect(saved.mutes.has("kept")).toBe(false);
    expect(rows.get("kept")?.allowActorIds).toEqual(["user_kept"]);
  });

  it("stops when a write is refused and skips an identical id", async () => {
    const saved = blank();
    saved.switches.set("old", [{ ruleId: "link", enabled: true }]);
    saved.keywords.set("old", ["迁移专属词", "第二个词"]);
    saved.refuseSwitch = true;
    saved.refuseKeywordAfter = 1;
    const runtime = savedRuntime(saved);
    const copied = await copyMissingChatSettings({
      runtime,
      tenantId: "tenant_a",
      fromChatId: "old",
      toChatId: "new",
    });
    expect(copied).toBe(1);
    expect(saved.switches.has("new")).toBe(false);
    expect(saved.keywords.get("new")).toEqual(["迁移专属词"]);
    expect(
      await copyMissingChatSettings({
        runtime,
        tenantId: "tenant_a",
        fromChatId: "same",
        toChatId: "same",
      }),
    ).toBe(0);
    expect(
      await copyMissingChatSettings({
        runtime,
        policy: policyStore(new Map()),
        tenantId: "tenant_a",
        fromChatId: "empty",
        toChatId: "other",
      }),
    ).toBe(0);
  });
});
