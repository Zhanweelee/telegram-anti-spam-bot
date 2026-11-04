import { describe, expect, it } from "vitest";
import { workerBlocklist } from "./blocklist-runtime.js";
import { workerCaptcha } from "./captcha-runtime.js";
import { workerChats } from "./chat-runtime.js";
import { workerRulePacks } from "./pack-runtime.js";
import { workerReview } from "./review-runtime.js";
import { workerPolicyStore, workerRuntime, workerStorage } from "./screen.js";
import { adaptD1, resolveStores, type StoreSlot } from "./stores.js";
import { workerWarns } from "./warn-runtime.js";

describe("adaptD1", () => {
  it("sends every statement in one batch", async () => {
    const batches: (readonly {
      readonly sql: string;
      readonly values: unknown[];
    }[])[] = [];
    const db = {
      prepare(sql: string) {
        const statement = {
          sql,
          values: [] as unknown[],
          bind(...values: unknown[]) {
            return { ...statement, values };
          },
        };
        return statement;
      },
      batch(
        statements: readonly {
          readonly sql: string;
          readonly values: unknown[];
        }[],
      ) {
        batches.push(statements);
        return Promise.resolve([]);
      },
    };
    const sql = adaptD1(db as unknown as D1Database);
    const first = sql.prepare("INSERT INTO audits VALUES (?)").bind("a");
    const second = sql
      .prepare("DELETE FROM captcha_challenges WHERE actor_id = ?")
      .bind("b");
    await sql.batch([first, second]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      expect.objectContaining({
        sql: "INSERT INTO audits VALUES (?)",
        values: ["a"],
      }),
      expect.objectContaining({
        sql: "DELETE FROM captcha_challenges WHERE actor_id = ?",
        values: ["b"],
      }),
    ]);
  });
});

describe("resolveStores", () => {
  it("keeps memory stores when D1 and KV are absent", () => {
    const stores = resolveStores({}, {});
    expect(stores.storage).toBe(workerStorage);
    expect(stores.policyStore).toBe(workerPolicyStore);
    expect(stores.review).toBe(workerReview);
    expect(stores.runtime).toBe(workerRuntime);
    expect(stores.chats).toBe(workerChats);
    expect(stores.subscriptions).toBe(workerRulePacks.store);
    expect(stores.archive).toBe(workerRulePacks.archive);
    expect(stores.blocklist).toBe(workerBlocklist);
    expect(stores.captcha).toBe(workerCaptcha);
    expect(stores.warns).toBe(workerWarns);
  });

  it("uses one D1 store and one KV store for the isolate", async () => {
    const queries: string[] = [];
    const values = new Map<string, string>();
    const db = {
      prepare(sql: string) {
        queries.push(sql);
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            return { results: [], success: true as const, meta: {} };
          },
          async run() {
            return { results: [], success: true as const, meta: {} };
          },
        };
        return statement;
      },
    };
    const kv = {
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async put(key: string, value: string) {
        values.set(key, value);
      },
    };
    const slot: StoreSlot = {};
    const env = {
      DB: db as unknown as D1Database,
      POLICY_KV: kv as unknown as KVNamespace,
    };
    const first = resolveStores(env, slot);
    const second = resolveStores(env, slot);
    expect(first.storage).toBe(second.storage);
    expect(first.storage).not.toBe(workerStorage);
    expect(first.policyStore).toBe(second.policyStore);
    expect(first.policyStore).not.toBe(workerPolicyStore);
    expect(first.review).toBe(second.review);
    expect(first.review).not.toBe(workerReview);
    expect(first.runtime).toBe(second.runtime);
    expect(first.runtime).not.toBe(workerRuntime);
    expect(first.chats).toBe(second.chats);
    expect(first.chats).not.toBe(workerChats);
    expect(first.subscriptions).toBe(second.subscriptions);
    expect(first.subscriptions).not.toBe(workerRulePacks.store);
    expect(first.archive).toBe(second.archive);
    expect(first.archive).not.toBe(workerRulePacks.archive);
    expect(first.blocklist).toBe(second.blocklist);
    expect(first.blocklist).not.toBe(workerBlocklist);
    expect(first.captcha).toBeDefined();
    expect(first.captcha).toBe(second.captcha);
    expect(first.captcha).not.toBe(workerCaptcha);
    expect(first.warns).toBeDefined();
    expect(first.warns).toBe(second.warns);
    expect(first.warns).not.toBe(workerWarns);
    expect(
      await first.runtime.setRuleSwitch("local", "-100", "via_inline", true),
    ).toBe(true);
    const restarted = resolveStores(env, {});
    expect(await restarted.runtime.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    expect(
      await first.runtime.setRuleAction(
        "local",
        "-100",
        "spam_keywords",
        "warn",
      ),
    ).toBe(true);
    expect(await restarted.runtime.listRuleActions("local", "-100")).toEqual([
      { ruleId: "spam_keywords", action: "warn" },
    ]);
    expect(await first.runtime.setReportChat("local", "-100", "77")).toBe(true);
    expect(await restarted.runtime.getReportChat("local", "-100")).toBe("77");
    expect(
      await first.runtime.setFloodPolicy("local", "-100", {
        threshold: 8,
        windowSeconds: 20,
      }),
    ).toBe(true);
    expect(await restarted.runtime.getFloodPolicy("local", "-100")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(await first.runtime.addKeyword("local", "-100", "发票")).toBe(true);
    expect(await restarted.runtime.listKeywords("local", "-100")).toEqual([
      "发票",
    ]);
    expect(
      await first.runtime.setRepeatPolicy("local", "-100", {
        threshold: 4,
        windowSeconds: 30,
      }),
    ).toBe(true);
    expect(await restarted.runtime.getRepeatPolicy("local", "-100")).toEqual({
      threshold: 4,
      windowSeconds: 30,
    });
    expect(await first.runtime.setMuteDuration("local", "-100", 120)).toBe(
      true,
    );
    expect(await restarted.runtime.getMuteDuration("local", "-100")).toBe(120);
    expect(await first.runtime.setCaptchaTtl("local", "-100", 120)).toBe(true);
    expect(await restarted.runtime.getCaptchaTtl("local", "-100")).toBe(120);
    expect(await first.runtime.setCaptchaFail("local", "-100", "kick")).toBe(
      true,
    );
    expect(await restarted.runtime.getCaptchaFail("local", "-100")).toBe(
      "kick",
    );
    expect(await first.runtime.addAllowHost("local", "-100", "bit.ly")).toBe(
      true,
    );
    expect(await restarted.runtime.listAllowHosts("local", "-100")).toEqual([
      "bit.ly",
    ]);
    await first.policyStore.put("local", "chat_1", {
      exemptAdmins: false,
      allowActorIds: [],
    });
    expect(values.size).toBe(11);
    expect([...values.keys()].some((key) => key.startsWith("policy"))).toBe(
      true,
    );
    expect([...values.keys()].some((key) => key.startsWith("runtime\n"))).toBe(
      true,
    );
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-action")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-report")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-flood")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-keyword")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-repeat")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-mute")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-captcha")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-captcha-fail")),
    ).toBe(true);
    expect(
      [...values.keys()].some((key) => key.startsWith("runtime-allow-host")),
    ).toBe(true);
    expect(
      await first.chats.noteBot({
        tenantId: "local",
        chatId: "-100586",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("ok");
    const directory = resolveStores(env, {});
    expect(await directory.chats.list("local")).toEqual(["-100586"]);
    expect([...values.keys()].some((key) => key.startsWith("chats"))).toBe(
      true,
    );
    await first.subscriptions.put("local", "-100", "community");
    const packs = resolveStores(env, {});
    expect(await packs.subscriptions.get("local", "-100")).toBe("community");
    expect([...values.keys()].some((key) => key.startsWith("pack\n"))).toBe(
      true,
    );
    await first.archive.put("local", "-100", "community", {
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
    });
    const archived = resolveStores(env, {});
    expect(await archived.archive.get("local", "-100", "community")).toEqual({
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
    });
    expect([...values.keys()].some((key) => key.startsWith("pack-rules"))).toBe(
      true,
    );
    await first.blocklist.setEnabled("local", "-100", true);
    await first.blocklist.add("local", { kind: "actor", value: "user_9" });
    const listed = resolveStores(env, {});
    expect(await listed.blocklist.isEnabled("local", "-100")).toBe(true);
    expect(
      await listed.blocklist.has("local", { kind: "actor", value: "user_9" }),
    ).toBe(true);
    expect([...values.keys()].some((key) => key.startsWith("blocklist"))).toBe(
      true,
    );
    expect(await first.storage.getRuleSet("local", "chat_1")).toBeNull();
    expect(await second.storage.getRuleSet("local", "chat_1")).toBeNull();
    expect(queries.filter((sql) => sql.startsWith("CREATE TABLE"))).toEqual([
      expect.stringContaining("audits"),
      expect.stringContaining("rule_sets"),
      expect.stringContaining("review_samples"),
      expect.stringContaining("captcha_challenges"),
      expect.stringContaining("warn_counts"),
      expect.stringContaining("warn_limits"),
    ]);
  });
});
