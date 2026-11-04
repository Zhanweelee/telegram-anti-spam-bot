import {
  bindBlocklistStoreContract,
  bindPolicyStoreContract,
} from "@tasb/core/testing";
import { describe, expect, it } from "vitest";
import {
  createKvBlocklistStore,
  createKvChatDirectory,
  createKvPolicyStore,
  createKvRulePackArchive,
  createKvRuleSubscriptionStore,
  createKvRuntimeStore,
  type StringStore,
} from "./index.js";

bindPolicyStoreContract(() => createKvPolicyStore(createMapStore().store));
bindBlocklistStoreContract(() =>
  createKvBlocklistStore(createMapStore().store),
);

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

  it("keeps a rule action in a separate key", async () => {
    const backing = createMapStore();
    const first = createKvRuntimeStore(backing.store);
    expect(
      await first.setRuleAction("local", "-100", "spam_keywords", "warn"),
    ).toBe(true);
    expect(await first.listRuleSwitches("local", "-100")).toEqual([]);
    expect(await first.getDryRun("local", "-100")).toBe(false);
    const second = createKvRuntimeStore(backing.store);
    expect(await second.listRuleActions("local", "-100")).toEqual([
      { ruleId: "spam_keywords", action: "warn" },
    ]);
    expect(
      await second.setRuleSwitch("local", "-100", "via_inline", true),
    ).toBe(true);
    expect(await second.listRuleActions("local", "-100")).toEqual([
      { ruleId: "spam_keywords", action: "warn" },
    ]);
    const keys = [...backing.values.keys()];
    expect(keys.some((key) => key.startsWith("runtime-action"))).toBe(true);
    expect(keys.some((key) => key.startsWith("runtime\n"))).toBe(true);
    const actionKey = keys.find((key) => key.startsWith("runtime-action"));
    const runtimeKey = keys.find((key) => key.startsWith("runtime\n"));
    expect(backing.values.get(runtimeKey ?? "")).not.toContain("warn");
    expect(backing.values.get(actionKey ?? "")).not.toContain("via_inline");
    await second.clearRuleAction("local", "-100", "spam_keywords");
    expect(await second.listRuleActions("local", "-100")).toEqual([]);
    expect(await second.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);

    const secret = "请免费领取礼品";
    if (actionKey !== undefined) {
      backing.values.set(actionKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.listRuleActions("local", "-100")).toEqual([]);
    expect(await fresh.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    expect(
      JSON.stringify(await fresh.listRuleActions("local", "-100")),
    ).not.toContain(secret);
    for (let index = 0; index < 32; index += 1) {
      expect(
        await fresh.setRuleAction("local", "full", `rule_${index}`, "log"),
      ).toBe(true);
    }
    expect(
      await fresh.setRuleAction("local", "full", "rule_extra", "ban"),
    ).toBe(false);
    expect([...backing.values.values()].join("\n")).not.toContain("rule_extra");
  });

  it("keeps a report chat in a separate key", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    const first = createKvRuntimeStore(backing.store);
    expect(await first.getReportChat("local", "-100")).toBeNull();
    expect(await first.setReportChat("local", "-100", "77")).toBe(true);
    expect(await first.setRuleSwitch("local", "-100", "via_inline", true)).toBe(
      true,
    );
    const second = createKvRuntimeStore(backing.store);
    expect(await second.getReportChat("local", "-100")).toBe("77");
    expect(await second.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    const keys = [...backing.values.keys()];
    const reportKey = keys.find((key) => key.startsWith("runtime-report"));
    const runtimeKey = keys.find((key) => key.startsWith("runtime\n"));
    expect(reportKey).toBeDefined();
    expect(backing.values.get(runtimeKey ?? "")).not.toContain("77");
    expect(backing.values.get(reportKey ?? "")).not.toContain("via_inline");
    if (reportKey !== undefined) {
      backing.values.set(reportKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.getReportChat("local", "-100")).toBeNull();
    expect(await fresh.listRuleSwitches("local", "-100")).toEqual([
      { ruleId: "via_inline", enabled: true },
    ]);
    expect(String(await fresh.getReportChat("local", "-100"))).not.toContain(
      secret,
    );
    expect(await fresh.setReportChat("local", "-100", "not-an-id")).toBe(false);
    expect(await fresh.getReportChat("local", "-100")).toBeNull();
    await second.clearReportChat("local", "-100");
    expect(await second.getReportChat("local", "-100")).toBeNull();
  });

  it("keeps a flood policy in a separate key", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    let puts = 0;
    const counting = {
      async get(key: string) {
        return backing.store.get(key);
      },
      async put(key: string, value: string) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRuntimeStore(counting);
    expect(await first.getFloodPolicy("local", "-100")).toBeNull();
    expect(
      await first.setFloodPolicy("local", "-100", {
        threshold: 8,
        windowSeconds: 20,
      }),
    ).toBe(true);
    const written = puts;
    expect(
      await first.setFloodPolicy("local", "-100", {
        threshold: 8,
        windowSeconds: 20,
      }),
    ).toBe(true);
    expect(puts).toBe(written);
    expect(await first.setReportChat("local", "-100", "77")).toBe(true);
    const second = createKvRuntimeStore(backing.store);
    expect(await second.getFloodPolicy("local", "-100")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(await second.getReportChat("local", "-100")).toBe("77");
    const keys = [...backing.values.keys()];
    const floodKey = keys.find((key) => key.startsWith("runtime-flood"));
    const reportKey = keys.find((key) => key.startsWith("runtime-report"));
    expect(floodKey).toBeDefined();
    expect(backing.values.get(reportKey ?? "")).not.toContain("8");
    expect(backing.values.get(floodKey ?? "")).not.toContain("77");
    if (floodKey !== undefined) {
      backing.values.set(floodKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.getFloodPolicy("local", "-100")).toBeNull();
    expect(await fresh.getReportChat("local", "-100")).toBe("77");
    expect(String(await fresh.getFloodPolicy("local", "-100"))).not.toContain(
      secret,
    );
    expect(
      await fresh.setFloodPolicy("local", "-100", {
        threshold: 33,
        windowSeconds: 10,
      }),
    ).toBe(false);
    expect(await fresh.getFloodPolicy("local", "-100")).toBeNull();
    expect(
      await fresh.setFloodPolicy("local", "-100", {
        threshold: 5,
        windowSeconds: 10,
      }),
    ).toBe(true);
    expect(await fresh.getFloodPolicy("local", "-100")).toBeNull();
    await second.clearFloodPolicy("local", "-100");
    expect(await second.getFloodPolicy("local", "-100")).toBeNull();
  });

  it("keeps extra keywords in a separate key", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    let puts = 0;
    const counting = {
      async get(key: string) {
        return backing.store.get(key);
      },
      async put(key: string, value: string) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRuntimeStore(counting);
    expect(await first.listKeywords("local", "-100")).toEqual([]);
    expect(await first.addKeyword("local", "-100", "发票")).toBe(true);
    const written = puts;
    expect(await first.addKeyword("local", "-100", "发票")).toBe(true);
    expect(puts).toBe(written);
    expect(
      await first.setFloodPolicy("local", "-100", {
        threshold: 8,
        windowSeconds: 20,
      }),
    ).toBe(true);
    const second = createKvRuntimeStore(backing.store);
    expect(await second.listKeywords("local", "-100")).toEqual(["发票"]);
    expect(await second.getFloodPolicy("local", "-100")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    const keys = [...backing.values.keys()];
    const keywordKey = keys.find((key) => key.startsWith("runtime-keyword"));
    const floodKey = keys.find((key) => key.startsWith("runtime-flood"));
    expect(keywordKey).toBeDefined();
    expect(backing.values.get(floodKey ?? "")).not.toContain("发票");
    expect(backing.values.get(keywordKey ?? "")).not.toContain("8");
    if (keywordKey !== undefined) {
      backing.values.set(keywordKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.listKeywords("local", "-100")).toEqual([]);
    expect(await fresh.getFloodPolicy("local", "-100")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(
      JSON.stringify(await fresh.listKeywords("local", "-100")),
    ).not.toContain(secret);
    expect(await fresh.addKeyword("local", "-100", "a".repeat(33))).toBe(false);
    expect(await fresh.listKeywords("local", "-100")).toEqual([]);
    await second.clearKeywords("local", "-100");
    expect(await second.listKeywords("local", "-100")).toEqual([]);
  });

  it("keeps a repeat policy in a separate key", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    let puts = 0;
    const counting = {
      async get(key: string) {
        return backing.store.get(key);
      },
      async put(key: string, value: string) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRuntimeStore(counting);
    expect(await first.getRepeatPolicy("local", "-100")).toBeNull();
    expect(
      await first.setRepeatPolicy("local", "-100", {
        threshold: 4,
        windowSeconds: 30,
      }),
    ).toBe(true);
    const written = puts;
    expect(
      await first.setRepeatPolicy("local", "-100", {
        threshold: 4,
        windowSeconds: 30,
      }),
    ).toBe(true);
    expect(puts).toBe(written);
    expect(
      await first.setFloodPolicy("local", "-100", {
        threshold: 8,
        windowSeconds: 20,
      }),
    ).toBe(true);
    expect(await first.addKeyword("local", "-100", "发票")).toBe(true);
    const second = createKvRuntimeStore(backing.store);
    expect(await second.getRepeatPolicy("local", "-100")).toEqual({
      threshold: 4,
      windowSeconds: 30,
    });
    expect(await second.getFloodPolicy("local", "-100")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(await second.listKeywords("local", "-100")).toEqual(["发票"]);
    const keys = [...backing.values.keys()];
    const repeatKey = keys.find((key) => key.startsWith("runtime-repeat"));
    const floodKey = keys.find((key) => key.startsWith("runtime-flood"));
    const keywordKey = keys.find((key) => key.startsWith("runtime-keyword"));
    expect(repeatKey).toBeDefined();
    expect(repeatKey).not.toBe(floodKey);
    expect(repeatKey).not.toBe(keywordKey);
    expect(backing.values.get(floodKey ?? "")).not.toContain("30");
    expect(backing.values.get(keywordKey ?? "")).not.toContain("30");
    if (repeatKey !== undefined) {
      backing.values.set(repeatKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.getRepeatPolicy("local", "-100")).toBeNull();
    expect(await fresh.getFloodPolicy("local", "-100")).toEqual({
      threshold: 8,
      windowSeconds: 20,
    });
    expect(await fresh.listKeywords("local", "-100")).toEqual(["发票"]);
    expect(String(await fresh.getRepeatPolicy("local", "-100"))).not.toContain(
      secret,
    );
    expect(
      await fresh.setRepeatPolicy("local", "-100", {
        threshold: 1,
        windowSeconds: 60,
      }),
    ).toBe(false);
    expect(await fresh.getRepeatPolicy("local", "-100")).toBeNull();
    expect(
      await fresh.setRepeatPolicy("local", "-100", {
        threshold: 3,
        windowSeconds: 60,
      }),
    ).toBe(true);
    expect(await fresh.getRepeatPolicy("local", "-100")).toBeNull();
    await second.clearRepeatPolicy("local", "-100");
    expect(await second.getRepeatPolicy("local", "-100")).toBeNull();
    expect(backing.values.get(repeatKey ?? "")).toBe("{}");
  });

  it("keeps a rule mute duration in a separate key", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    let puts = 0;
    const counting = {
      async get(key: string) {
        return backing.store.get(key);
      },
      async put(key: string, value: string) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRuntimeStore(counting);
    expect(await first.getMuteDuration("local", "-100")).toBeNull();
    expect(await first.setMuteDuration("local", "-100", 120)).toBe(true);
    const written = puts;
    expect(await first.setMuteDuration("local", "-100", 120)).toBe(true);
    expect(puts).toBe(written);
    expect(
      await first.setRepeatPolicy("local", "-100", {
        threshold: 4,
        windowSeconds: 30,
      }),
    ).toBe(true);
    const second = createKvRuntimeStore(backing.store);
    expect(await second.getMuteDuration("local", "-100")).toBe(120);
    expect(await second.getRepeatPolicy("local", "-100")).toEqual({
      threshold: 4,
      windowSeconds: 30,
    });
    const keys = [...backing.values.keys()];
    const muteKey = keys.find((key) => key.startsWith("runtime-mute"));
    const repeatKey = keys.find((key) => key.startsWith("runtime-repeat"));
    expect(muteKey).toBeDefined();
    expect(muteKey).not.toBe(repeatKey);
    expect(backing.values.get(repeatKey ?? "")).not.toContain("120");
    if (muteKey !== undefined) {
      backing.values.set(muteKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.getMuteDuration("local", "-100")).toBeNull();
    expect(await fresh.getRepeatPolicy("local", "-100")).toEqual({
      threshold: 4,
      windowSeconds: 30,
    });
    expect(String(await fresh.getMuteDuration("local", "-100"))).not.toContain(
      secret,
    );
    expect(await fresh.setMuteDuration("local", "-100", 29)).toBe(false);
    expect(await fresh.getMuteDuration("local", "-100")).toBeNull();
    expect(await fresh.setMuteDuration("local", "-100", 3600)).toBe(true);
    expect(await fresh.getMuteDuration("local", "-100")).toBeNull();
    await second.clearMuteDuration("local", "-100");
    expect(await second.getMuteDuration("local", "-100")).toBeNull();
    expect(backing.values.get(muteKey ?? "")).toBe("{}");
  });

  it("keeps a verification window in a separate key", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    let puts = 0;
    const counting = {
      async get(key: string) {
        return backing.store.get(key);
      },
      async put(key: string, value: string) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvRuntimeStore(counting);
    expect(await first.getCaptchaTtl("local", "-100")).toBeNull();
    expect(await first.setCaptchaTtl("local", "-100", 120)).toBe(true);
    const written = puts;
    expect(await first.setCaptchaTtl("local", "-100", 120)).toBe(true);
    expect(puts).toBe(written);
    expect(await first.setMuteDuration("local", "-100", 90)).toBe(true);
    const second = createKvRuntimeStore(backing.store);
    expect(await second.getCaptchaTtl("local", "-100")).toBe(120);
    expect(await second.getMuteDuration("local", "-100")).toBe(90);
    const keys = [...backing.values.keys()];
    const captchaKey = keys.find((key) => key.startsWith("runtime-captcha"));
    const muteKey = keys.find((key) => key.startsWith("runtime-mute"));
    expect(captchaKey).toBeDefined();
    expect(captchaKey).not.toBe(muteKey);
    expect(backing.values.get(muteKey ?? "")).not.toContain("120");
    if (captchaKey !== undefined) {
      backing.values.set(captchaKey, JSON.stringify({ text: secret }));
    }
    const fresh = createKvRuntimeStore(backing.store);
    expect(await fresh.getCaptchaTtl("local", "-100")).toBeNull();
    expect(await fresh.getMuteDuration("local", "-100")).toBe(90);
    expect(String(await fresh.getCaptchaTtl("local", "-100"))).not.toContain(
      secret,
    );
    expect(await fresh.setCaptchaTtl("local", "-100", 29)).toBe(false);
    expect(await fresh.getCaptchaTtl("local", "-100")).toBeNull();
    expect(await fresh.setCaptchaTtl("local", "-100", 300)).toBe(true);
    expect(await fresh.getCaptchaTtl("local", "-100")).toBeNull();
    await second.clearCaptchaTtl("local", "-100");
    expect(await second.getCaptchaTtl("local", "-100")).toBeNull();
    expect(backing.values.get(captchaKey ?? "")).toBe("{}");
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

describe("kv blocklist store", () => {
  it("keeps opt-in and entries after a new store reads the same KV", async () => {
    const backing = createMapStore();
    let puts = 0;
    const counted: StringStore = {
      get: (key) => backing.store.get(key),
      async put(key, value) {
        puts += 1;
        await backing.store.put(key, value);
      },
    };
    const first = createKvBlocklistStore(counted);
    expect(await first.isEnabled("local", "-100")).toBe(false);
    await first.setEnabled("local", "-100", false);
    expect(puts).toBe(0);
    await first.setEnabled("local", "-100", true);
    await first.add("local", { kind: "actor", value: "user_9" });
    expect(puts).toBe(2);
    await first.setEnabled("local", "-100", true);
    await first.add("local", { kind: "actor", value: "user_9" });
    expect(puts).toBe(2);
    expect(await first.size("local")).toBe(1);
    expect(puts).toBe(2);
    const key = [...backing.values.keys()][0];
    expect(key?.startsWith("blocklist")).toBe(true);
    const second = createKvBlocklistStore(backing.store);
    expect(await second.isEnabled("local", "-100")).toBe(true);
    expect(await second.has("local", { kind: "actor", value: "user_9" })).toBe(
      true,
    );
    await second.setEnabled("local", "-100", false);
    expect(await second.isEnabled("local", "-100")).toBe(false);
    expect(await second.has("local", { kind: "actor", value: "user_9" })).toBe(
      true,
    );
    expect(puts).toBe(2);
    const stored = key === undefined ? "" : (backing.values.get(key) ?? "");
    expect(
      await second.remove("local", { kind: "actor", value: "user_9" }),
    ).toBe(true);
    const after = key === undefined ? "" : (backing.values.get(key) ?? "");
    expect(after).not.toBe(stored);
    expect(after).not.toContain("user_9");
    expect(
      await second.remove("local", { kind: "actor", value: "user_9" }),
    ).toBe(false);
    expect(key === undefined ? "" : backing.values.get(key)).toBe(after);
    const kept = createKvBlocklistStore(backing.store);
    expect(await kept.has("local", { kind: "actor", value: "user_9" })).toBe(
      false,
    );
    expect(await kept.isEnabled("local", "-100")).toBe(false);
    expect(await kept.size("local")).toBe(0);
  });

  it("does not rewrite a corrupt document and hides the text", async () => {
    const backing = createMapStore();
    const secret = "请免费领取礼品";
    const store = createKvBlocklistStore(backing.store);
    await store.setEnabled("local", "-100", true);
    const key = [...backing.values.keys()][0];
    if (key !== undefined) {
      backing.values.set(key, JSON.stringify({ text: secret }));
    }
    const fresh = createKvBlocklistStore(backing.store);
    expect(await fresh.isEnabled("local", "-100")).toBe(false);
    expect(await fresh.has("local", { kind: "actor", value: "user_9" })).toBe(
      false,
    );
    expect(
      JSON.stringify(await fresh.isEnabled("local", "-100")),
    ).not.toContain(secret);
    expect(key === undefined ? "" : backing.values.get(key)).toContain(secret);
  });

  it("reads KV once per ttl and skips an unchanged write", async () => {
    const backing = createMapStore();
    let now = 0;
    let gets = 0;
    let puts = 0;
    const store = createKvBlocklistStore(
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
    await store.setEnabled("local", "-100", true);
    expect(puts).toBe(1);
    gets = 0;
    puts = 0;
    expect(await store.isEnabled("local", "-100")).toBe(true);
    await store.setEnabled("local", "-100", true);
    expect(gets).toBe(0);
    expect(puts).toBe(0);
    now = 60_000;
    await store.setEnabled("local", "-100", true);
    expect(gets).toBe(1);
    expect(puts).toBe(0);
    expect(await store.isEnabled("local", "-100")).toBe(true);
  });
});
