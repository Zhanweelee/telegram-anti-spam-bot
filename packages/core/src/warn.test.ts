import { describe, expect, it } from "vitest";
import { bindWarnStoreContract } from "./warn.contract.js";
import { createMemoryWarnStore, sortWarnCounts } from "./warn.js";

bindWarnStoreContract(createMemoryWarnStore);

describe("sortWarnCounts", () => {
  it("orders a tie by the decimal actor id", () => {
    expect(
      sortWarnCounts([
        { actorId: "10", count: 2 },
        { actorId: "2", count: 2 },
        { actorId: "2", count: 2 },
        { actorId: "b", count: 1 },
        { actorId: "a", count: 1 },
        { actorId: "a", count: 1 },
      ]),
    ).toEqual([
      { actorId: "2", count: 2 },
      { actorId: "2", count: 2 },
      { actorId: "10", count: 2 },
      { actorId: "a", count: 1 },
      { actorId: "a", count: 1 },
      { actorId: "b", count: 1 },
    ]);
  });
});

describe("createMemoryWarnStore", () => {
  it("keeps the count inside one store object", async () => {
    const store = createMemoryWarnStore();
    const target = { tenantId: "local", chatId: "-100", actorId: "77" };
    await store.increment(target);
    expect(await store.read(target)).toBe(1);
  });
});
