import { bindPolicyStoreContract } from "@tasb/core/testing";
import { describe, expect, it } from "vitest";
import {
  createKvChatDirectory,
  createKvPolicyStore,
  createKvRulePackArchive,
  createKvRuleSubscriptionStore,
  createKvRuntimeStore,
  type StringStore,
} from "./index.js";

bindPolicyStoreContract(() => createKvPolicyStore(createMapStore().store));

function createMapStore(): {
  readonly store: StringStore;
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      async get(key) {
        return values.get(key) ?? null;
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };
}

describe("kv policy store", () => {
  it("returns null when the stored document is not a policy", async () => {
    const backing = createMapStore();
    const store = createKvPolicyStore(backing.store);
    await store.put("tenant_a", "chat_1", {
      exemptAdmins: false,
      allowActorIds: [],
    });
    const key = [...backing.values.keys()][0];
    expect(key).toBeTypeOf("string");
    const secret = "请免费领取礼品";
    if (key !== undefined) {
      backing.values.set(key, JSON.stringify({ text: secret }));
    }
    const loaded = await store.get("tenant_a", "chat_1");
    expect(loaded).toBeNull();
    expect(JSON.stringify(loaded)).not.toContain(secret);

    if (key !== undefined) {
      backing.values.set(key, "{");
    }
    expect(await store.get("tenant_a", "chat_1")).toBeNull();
  });
});

describe("kv runtime store", () => {
  it("keeps dry-run and rule switches after a new store reads the same KV", async () => {
    const backing = createMapStore();
    const first = createKvRuntimeStore(backing.store);
    expect(await first.getDryRun("local", "-100")).toBe(false);
    expect(backing.values.size).toBe(0);
    await first.setDryRun("local", "-100", true);
    expect(await first.setRuleSwitch("local", "-100", "via_inline", true)).toBe(
      true,
    );
    const second = createKvRuntimeStore(backing.store);
    expect(await second.getDryRun("local", "-100")).toBe(true);
    expect(await second.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    await second.setDryRun("local", "-100", false);
    expect(await second.getDryRun("local", "-100")).toBe(false);
    expect(await second.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    await second.clearRuleSwitch("local", "-100", "via_inline");
    expect(await second.listRuleSwitches("local", "-100")).toEqual([]);

    const policy = createKvPolicyStore(backing.store);
    await policy.put("local", "-100", {
      exemptAdmins: true,
      allowActorIds: [],
    });
    expect(await second.listRuleSwitches("local", "-100")).toEqual([]);
    expect(await policy.get("local", "-100")).toMatchObject({
      exemptAdmins: true,
    });
  });

  it("treats a corrupt document as empty and hides the text", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    const store = createKvRuntimeStore(backing.store);
    await store.setDryRun("local", "chat_1", true);
    const key = [...backing.values.keys()][0];
    expect(key?.startsWith("runtime")).toBe(true);
    if (key !== undefined) {
      backing.values.set(key, JSON.stringify({ dryRun: true, text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.getDryRun("local", "chat_1")).toBe(false);
    expect(await fresh.listRuleSwitches("local", "chat_1")).toEqual([]);
    expect(
      JSON.stringify(await fresh.listRuleSwitches("local", "chat_1")),
    ).not.toContain(secret);
  });

  it("keeps at most 32 switches and does not write the rejected id", async () => {
    const backing = createMapStore();
    const store = createKvRuntimeStore(backing.store);
    for (let index = 0; index < 32; index += 1) {
      expect(
        await store.setRuleSwitch("local", "full", `rule_${index}`, true),
      ).toBe(true);
    }
    expect(await store.setRuleSwitch("local", "full", "rule_extra", true)).toBe(
      false,
    );
    expect(await store.setRuleSwitch("local", "full", "rule_0", false)).toBe(
      true,
    );
    const saved = [...backing.values.values()].join("\n");
    expect(saved).not.toContain("rule_extra");
    expect(await store.listRuleSwitches("local", "full")).toHaveLength(32);
  });

  it("reads KV once per ttl for both dry-run and switches", async () => {
    const backing = createMapStore();
    let now = 0;
    let gets = 0;
    const store = createKvRuntimeStore(
      {
        async get(key) {
          gets += 1;
          return backing.store.get(key);
        },
        put: (key, value) => backing.store.put(key, value),
      },
      { now: () => now, ttlMs: 60_000 },
    );
    await store.setRuleSwitch("local", "chat_1", "regex_hint", true);
    gets = 0;
    expect(await store.listRuleSwitches("local", "chat_1")).toEqual([
      { ruleId: "regex_hint", enabled: true },
    ]);
    expect(await store.getDryRun("local", "chat_1")).toBe(false);
    expect(gets).toBe(0);
    now = 60_000;
    expect(await store.getDryRun("local", "chat_1")).toBe(false);
    expect(gets).toBe(1);
    expect(await store.listRuleSwitches("local", "chat_1")).toEqual([
      { ruleId: "regex_hint", enabled: true },
    ]);
    expect(gets).toBe(1);
  });
});

describe("kv chat directory", () => {
  it("remembers operators after a new store reads the same KV", async () => {
    const backing = createMapStore();
    const first = createKvChatDirectory(backing.store);
    expect(
      await first.noteBot({
        tenantId: "local",
        chatId: "-100",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("ok");
    const second = createKvChatDirectory(backing.store);
    expect(await second.chatsFor("local", "7")).toEqual(["-100"]);
    expect(await second.list("local")).toEqual(["-100"]);
    expect(await second.chatsFor("other", "7")).toEqual([]);
    await second.noteMember({
      tenantId: "local",
      chatId: "-100",
      actorId: "8",
      admin: true,
    });
    expect(await second.chatsFor("local", "8")).toEqual(["-100"]);
    await second.noteMember({
      tenantId: "local",
      chatId: "-100",
      actorId: "8",
      admin: false,
    });
    expect(await second.chatsFor("local", "8")).toEqual([]);
    expect(await second.list("local")).toEqual(["-100"]);
    await second.noteBot({
      tenantId: "local",
      chatId: "-100",
      actorId: "7",
      state: "gone",
    });
    expect(await second.list("local")).toEqual([]);
    expect(await second.chatsFor("local", "7")).toEqual([]);
    const key = [...backing.values.keys()][0];
    expect(key?.startsWith("chats")).toBe(true);
  });

  it("treats a corrupt directory as empty and hides the title", async () => {
    const backing = createMapStore();
    const title = "机密群名";
    const store = createKvChatDirectory(backing.store);
    await store.noteBot({
      tenantId: "local",
      chatId: "-100",
      actorId: "7",
      state: "admin",
    });
    const key = [...backing.values.keys()][0];
    if (key !== undefined) {
      backing.values.set(key, JSON.stringify({ title }));
    }
    const fresh = createKvChatDirectory(backing.store);
    expect(await fresh.list("local")).toEqual([]);
    expect(JSON.stringify(await fresh.list("local"))).not.toContain(title);
  });

  it("stops new chats at 256 and extra actors at 32", async () => {
    const backing = createMapStore();
    const store = createKvChatDirectory(backing.store);
    for (let index = 0; index < 256; index += 1) {
      expect(
        await store.noteBot({
          tenantId: "local",
          chatId: String(-1000 - index),
          actorId: "7",
          state: "admin",
        }),
      ).toBe("ok");
    }
    expect(
      await store.noteBot({
        tenantId: "local",
        chatId: "-1",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("full");
    expect(await store.list("local")).toHaveLength(256);
    expect(await store.chatsFor("local", "7")).toHaveLength(256);
    for (let index = 0; index < 31; index += 1) {
      expect(
        await store.noteMember({
          tenantId: "local",
          chatId: "-1000",
          actorId: String(100 + index),
          admin: true,
        }),
      ).toBe("ok");
    }
    expect(
      await store.noteMember({
        tenantId: "local",
        chatId: "-1000",
        actorId: "999",
        admin: true,
      }),
    ).toBe("ok");
    expect(await store.chatsFor("local", "999")).toEqual([]);
    expect(
      await store.noteBot({
        tenantId: "local\nextra",
        chatId: "-100",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("ok");
    expect(await store.list("local")).toHaveLength(256);
  });

  it("reads the tenant document once per ttl", async () => {
    const backing = createMapStore();
    let now = 0;
    let gets = 0;
    const store = createKvChatDirectory(
      {
        async get(key) {
          gets += 1;
          return backing.store.get(key);
        },
        put: (key, value) => backing.store.put(key, value),
      },
      { now: () => now, ttlMs: 60_000 },
    );
    await store.noteBot({
      tenantId: "local",
      chatId: "-100",
      actorId: "7",
      state: "admin",
    });
    gets = 0;
    expect(await store.list("local")).toEqual(["-100"]);
    expect(await store.chatsFor("local", "7")).toEqual(["-100"]);
    expect(gets).toBe(0);
    now = 60_000;
    expect(await store.chatsFor("local", "7")).toEqual(["-100"]);
    expect(gets).toBe(1);
    expect(await store.list("local")).toEqual(["-100"]);
    expect(gets).toBe(1);
  });
});

describe("kv rule subscriptions", () => {
  it("keeps a pack id after a new store reads the same KV", async () => {
    const backing = createMapStore();
    let puts = 0;
    const counted: StringStore = {
      get: (key) => backing.store.get(key),
      async put(key, value) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRuleSubscriptionStore(counted);
    expect(await first.get("local", "-100")).toBeNull();
    expect(puts).toBe(0);
    await first.put("local", "-100", "community");
    expect(puts).toBe(1);
    await first.put("local", "-100", "community");
    expect(puts).toBe(1);
    const key = [...backing.values.keys()][0];
    expect(key?.startsWith("pack")).toBe(true);
    const second = createKvRuleSubscriptionStore(backing.store);
    expect(await second.get("local", "-100")).toBe("community");
    await second.put("local", "-100", null);
    const cleared = createKvRuleSubscriptionStore(backing.store);
    expect(await cleared.get("local", "-100")).toBeNull();
  });

  it("treats a corrupt document as unsubscribed and hides the text", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    const store = createKvRuleSubscriptionStore(backing.store);
    await store.put("local", "-100", "community");
    const key = [...backing.values.keys()][0];
    if (key !== undefined) {
      backing.values.set(
        key,
        JSON.stringify({ packId: "community", text: secret }),
      );
    }
    const fresh = createKvRuleSubscriptionStore(backing.store);
    expect(await fresh.get("local", "-100")).toBeNull();
    expect(JSON.stringify(await fresh.get("local", "-100"))).not.toContain(
      secret,
    );
    expect(key === undefined ? "" : backing.values.get(key)).toContain(secret);
  });

  it("stores a 129th chat without pack_full", async () => {
    const backing = createMapStore();
    const store = createKvRuleSubscriptionStore(backing.store);
    for (let index = 0; index < 129; index += 1) {
      await store.put("local", String(-1000 - index), "community");
    }
    const fresh = createKvRuleSubscriptionStore(backing.store);
    expect(await fresh.get("local", "-1000")).toBe("community");
    expect(await fresh.get("local", "-1128")).toBe("community");
    expect(backing.values.size).toBe(129);
  });

  it("reads KV once per ttl after a write", async () => {
    const backing = createMapStore();
    let now = 0;
    let gets = 0;
    const store = createKvRuleSubscriptionStore(
      {
        async get(key) {
          gets += 1;
          return backing.store.get(key);
        },
        put: (key, value) => backing.store.put(key, value),
      },
      { now: () => now, ttlMs: 60_000 },
    );
    await store.put("local", "-100", "community");
    gets = 0;
    expect(await store.get("local", "-100")).toBe("community");
    expect(await store.get("local", "-100")).toBe("community");
    expect(gets).toBe(0);
    now = 60_000;
    expect(await store.get("local", "-100")).toBe("community");
    expect(gets).toBe(1);
    expect(await store.get("local", "-100")).toBe("community");
    expect(gets).toBe(1);
  });
});

const archivedRules = {
  version: 1 as const,
  aggregate: "max" as const,
  rules: [
    {
      id: "spam_keywords",
      enabled: true,
      detectorIds: ["keyword"],
      threshold: 1,
      actions: ["delete" as const],
    },
  ],
};

describe("kv rule pack archive", () => {
  it("keeps the last rules after a new archive reads the same KV", async () => {
    const backing = createMapStore();
    let puts = 0;
    const counted: StringStore = {
      get: (key) => backing.store.get(key),
      async put(key, value) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRulePackArchive(counted);
    expect(await first.get("local", "-100", "community")).toBeNull();
    await first.put("local", "-100", "community", archivedRules);
    expect(puts).toBe(1);
    await first.put("local", "-100", "community", archivedRules);
    expect(puts).toBe(1);
    const key = [...backing.values.keys()][0];
    expect(key?.startsWith("pack-rules")).toBe(true);
    const second = createKvRulePackArchive(backing.store);
    expect(await second.get("local", "-100", "community")).toEqual(
      archivedRules,
    );
  });

  it("does not rewrite a corrupt document and hides the text", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    const archive = createKvRulePackArchive(backing.store);
    await archive.put("local", "-100", "community", archivedRules);
    const key = [...backing.values.keys()][0];
    if (key !== undefined) {
      backing.values.set(key, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRulePackArchive(backing.store);
    expect(await fresh.get("local", "-100", "community")).toBeNull();
    expect(
      JSON.stringify(await fresh.get("local", "-100", "community")),
    ).not.toContain(secret);
    expect(key === undefined ? "" : backing.values.get(key)).toContain(secret);
  });

  it("skips a document above the character cap", async () => {
    const backing = createMapStore();
    const archive = createKvRulePackArchive(backing.store, { maxChars: 32 });
    await expect(
      archive.put("local", "-100", "community", archivedRules),
    ).rejects.toThrow("pack_archive_too_large");
    expect(backing.values.size).toBe(0);
    const fresh = createKvRulePackArchive(backing.store);
    expect(await fresh.get("local", "-100", "community")).toBeNull();
  });

  it("reads KV once per ttl when the rules are unchanged", async () => {
    const backing = createMapStore();
    let now = 0;
    let gets = 0;
    let puts = 0;
    const archive = createKvRulePackArchive(
      {
        async get(key) {
          gets += 1;
          return backing.store.get(key);
        },
        async put(key, value) {
          puts += 1;
          await backing.store.put(key, value);
        },
      },
      { now: () => now, ttlMs: 60_000 },
    );
    await archive.put("local", "-100", "community", archivedRules);
    expect(puts).toBe(1);
    gets = 0;
    puts = 0;
    await archive.put("local", "-100", "community", archivedRules);
    expect(gets).toBe(0);
    expect(puts).toBe(0);
    now = 60_000;
    await archive.put("local", "-100", "community", archivedRules);
    expect(gets).toBe(1);
    expect(puts).toBe(0);
    expect(await archive.get("local", "-100", "community")).toEqual(
      archivedRules,
    );
  });
});
