import { describe, expect, it } from "vitest";
import { bindWarnStoreContract } from "./warn.contract.js";
import {
  createMemoryWarnStore,
  normalizeWarnLimit,
  sortWarnCounts,
} from "./warn.js";

bindWarnStoreContract(createMemoryWarnStore);

describe("normalizeWarnLimit", () => {
  it("keeps 1 through 10 and sends anything else back to 3", () => {
    expect(normalizeWarnLimit(1)).toBe(1);
    expect(normalizeWarnLimit(10)).toBe(10);
    expect(normalizeWarnLimit(3)).toBe(3);
    expect(normalizeWarnLimit(0)).toBe(3);
    expect(normalizeWarnLimit(11)).toBe(3);
    expect(normalizeWarnLimit(1.5)).toBe(3);
  });
});

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
