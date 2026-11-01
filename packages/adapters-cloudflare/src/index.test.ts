import { bindPolicyStoreContract } from "@tasb/core/testing";
import { describe, expect, it } from "vitest";
import { createKvPolicyStore, type StringStore } from "./index.js";

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
