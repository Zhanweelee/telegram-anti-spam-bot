import { describe, expect, it } from "vitest";
import {
  MAX_WARN_ACTORS,
  MAX_WARN_CHATS,
  WarnCapacityError,
  type WarnStore,
} from "./warn.js";

const target = {
  tenantId: "local",
  chatId: "-100",
  actorId: "77",
};

export function bindWarnStoreContract(create: () => WarnStore): void {
  describe("warn store contract", () => {
    it("counts one actor and clears that count", async () => {
      const store = create();
      expect(await store.read(target)).toBe(0);
      expect(await store.increment(target)).toBe(1);
      expect(await store.increment(target)).toBe(2);
      expect(await store.read(target)).toBe(2);
      expect(await store.clear(target)).toBe(true);
      expect(await store.read(target)).toBe(0);
      expect(await store.clear(target)).toBe(false);
    });

    it("keeps two chats apart", async () => {
      const store = create();
      await store.increment(target);
      await store.increment({ ...target, chatId: "-200" });
      await store.increment({ ...target, chatId: "-200" });
      expect(await store.read(target)).toBe(1);
      expect(await store.read({ ...target, chatId: "-200" })).toBe(2);
    });

    it("refuses a new chat or actor past the cap", async () => {
      const store = create();
      for (let index = 0; index < MAX_WARN_CHATS; index += 1) {
        await store.increment({
          ...target,
          chatId: String(index),
          actorId: "1",
        });
      }
      await expect(
        store.increment({ ...target, chatId: "overflow", actorId: "1" }),
      ).rejects.toBeInstanceOf(WarnCapacityError);
      const crowded = create();
      for (let index = 0; index < MAX_WARN_ACTORS; index += 1) {
        await crowded.increment({ ...target, actorId: String(index) });
      }
      await expect(
        crowded.increment({ ...target, actorId: "overflow" }),
      ).rejects.toBeInstanceOf(WarnCapacityError);
      expect(await crowded.increment({ ...target, actorId: "0" })).toBe(2);
    });

    it("writes a lower count without keeping a zero", async () => {
      const store = create();
      await store.increment(target);
      await store.increment(target);
      await store.write(target, 1);
      expect(await store.read(target)).toBe(1);
      await store.write(target, 0);
      expect(await store.read(target)).toBe(0);
      expect(await store.clear(target)).toBe(false);
    });
  });
}
