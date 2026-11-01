import { describe, expect, it } from "vitest";
import {
  createMemoryRulePackArchive,
  createMemoryRuleSubscriptionStore,
  MAX_RULE_SUBSCRIPTIONS,
  parseRulePackId,
} from "./rule-pack.js";
import { openRuleSet } from "./rules-load.js";

describe("rule packs", () => {
  it("rejects ids that are not a pack name", () => {
    expect(parseRulePackId("community")).toBe("community");
    expect(parseRulePackId("off")).toBe("off");
    expect(parseRulePackId("请免费领取礼品")).toBeNull();
    expect(parseRulePackId("Community")).toBeNull();
  });

  it("caps new chats and archive entries", async () => {
    const store = createMemoryRuleSubscriptionStore();
    for (let index = 0; index < MAX_RULE_SUBSCRIPTIONS; index += 1) {
      await store.put("local", `chat_${index}`, "community");
    }
    await store.put("local", "chat_0", "other");
    await expect(store.put("local", "chat_new", "community")).rejects.toThrow(
      "pack_full",
    );
    expect(await store.get("other", "chat_0")).toBeNull();

    const archive = createMemoryRulePackArchive();
    for (let index = 0; index < MAX_RULE_SUBSCRIPTIONS; index += 1) {
      await archive.put("local", `chat_${index}`, "community", openRuleSet);
    }
    await expect(
      archive.put("local", "chat_new", "community", openRuleSet),
    ).rejects.toThrow("pack_full");
    await expect(
      archive.put("local", "chat_new", "community", {
        version: 1,
        text: "请免费领取礼品",
      } as never),
    ).rejects.toThrow();
    expect(await archive.get("local", "chat_0", "community")).toEqual(
      openRuleSet,
    );
  });
});
