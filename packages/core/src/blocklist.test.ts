import { describe, expect, it } from "vitest";
import { bindBlocklistStoreContract } from "./blocklist.contract.js";
import {
  blocklistEntrySchema,
  createMemoryBlocklistStore,
  parseBlocklistEntry,
} from "./blocklist.js";

bindBlocklistStoreContract(createMemoryBlocklistStore);

const phrase = "请免费领取礼品";

describe("blocklist entry schema", () => {
  it("stores ids and hashes and drops a raw-text field", () => {
    expect(parseBlocklistEntry({ kind: "actor", value: "user_1" })).toEqual({
      kind: "actor",
      value: "user_1",
    });
    expect(
      blocklistEntrySchema.safeParse({
        kind: "actor",
        value: "user_1",
        text: phrase,
      }).success,
    ).toBe(false);
    expect(
      blocklistEntrySchema.safeParse({ kind: "hash", value: "ab" }).success,
    ).toBe(false);
  });

  it("snapshots only chats and identifiers", async () => {
    const store = createMemoryBlocklistStore();
    await store.setEnabled("tenant_a", "chat_1", true);
    await store.add("tenant_a", { kind: "actor", value: "user_1" });
    await store.add("tenant_a", { kind: "hash", value: "cd".repeat(32) });
    await expect(
      store.add("tenant_a", { kind: "hash", value: phrase }),
    ).rejects.toThrow();
    const dumped = JSON.stringify(store.snapshot());
    expect(dumped).not.toContain(phrase);
    expect(dumped).not.toContain('"text"');
    expect(store.snapshot().entries).toEqual([
      { tenantId: "tenant_a", kind: "actor", value: "user_1" },
      { tenantId: "tenant_a", kind: "hash", value: "cd".repeat(32) },
    ]);
  });
});
