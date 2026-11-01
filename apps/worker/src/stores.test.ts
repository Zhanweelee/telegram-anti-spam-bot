import { describe, expect, it } from "vitest";
import { workerChats } from "./chat-runtime.js";
import { workerReview } from "./review-runtime.js";
import { workerPolicyStore, workerRuntime, workerStorage } from "./screen.js";
import { resolveStores, type StoreSlot } from "./stores.js";

describe("resolveStores", () => {
  it("keeps memory stores when D1 and KV are absent", () => {
    const stores = resolveStores({}, {});
    expect(stores.storage).toBe(workerStorage);
    expect(stores.policyStore).toBe(workerPolicyStore);
    expect(stores.review).toBe(workerReview);
    expect(stores.runtime).toBe(workerRuntime);
    expect(stores.chats).toBe(workerChats);
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
    expect(
      await first.runtime.setRuleSwitch("local", "-100", "via_inline", true),
    ).toBe(true);
    const restarted = resolveStores(env, {});
    expect(await restarted.runtime.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    await first.policyStore.put("local", "chat_1", {
      exemptAdmins: false,
      allowActorIds: [],
    });
    expect(values.size).toBe(2);
    expect([...values.keys()].some((key) => key.startsWith("policy"))).toBe(
      true,
    );
    expect([...values.keys()].some((key) => key.startsWith("runtime"))).toBe(
      true,
    );
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
    expect(await first.storage.getRuleSet("local", "chat_1")).toBeNull();
    expect(await second.storage.getRuleSet("local", "chat_1")).toBeNull();
    expect(queries.filter((sql) => sql.startsWith("CREATE TABLE"))).toEqual([
      expect.stringContaining("audits"),
      expect.stringContaining("rule_sets"),
      expect.stringContaining("review_samples"),
    ]);
  });
});
