import { describe, expect, it } from "vitest";
import { bindWarnStoreContract } from "./warn.contract.js";
import { createMemoryWarnStore } from "./warn.js";

bindWarnStoreContract(createMemoryWarnStore);

describe("createMemoryWarnStore", () => {
  it("keeps the count inside one store object", async () => {
    const store = createMemoryWarnStore();
    const target = { tenantId: "local", chatId: "-100", actorId: "77" };
    await store.increment(target);
    expect(await store.read(target)).toBe(1);
  });
});
