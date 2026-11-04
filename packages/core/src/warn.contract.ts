import { describe, expect, it } from "vitest";
import {
  MAX_WARN_ACTORS,
  MAX_WARN_CHATS,
  MAX_WARN_LIMIT,
  MIN_WARN_LIMIT,
  WARN_LIMIT,
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

    it("lists one chat with the highest count first", async () => {
      const store = create();
      await store.increment({ ...target, actorId: "10" });
      await store.increment({ ...target, actorId: "9" });
      await store.increment({ ...target, actorId: "9" });
      await store.increment({ ...target, actorId: "9" });
      await store.increment({ ...target, actorId: "8" });
      await store.increment({ ...target, actorId: "8" });
      await store.increment({ ...target, actorId: "8" });
      await store.increment({ ...target, chatId: "-200", actorId: "9" });
      expect(await store.list(target.tenantId, target.chatId)).toEqual([
        { actorId: "8", count: 3 },
        { actorId: "9", count: 3 },
        { actorId: "10", count: 1 },
      ]);
      expect(await store.list(target.tenantId, "-200")).toEqual([
        { actorId: "9", count: 1 },
      ]);
      expect(await store.list(target.tenantId, "-300")).toEqual([]);
      await store.clear({ ...target, actorId: "9" });
      expect(await store.list(target.tenantId, target.chatId)).toEqual([
        { actorId: "8", count: 3 },
        { actorId: "10", count: 1 },
      ]);
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

    it("keeps a custom limit for one chat", async () => {
      const store = create();
      expect(await store.readLimit(target.tenantId, target.chatId)).toBe(
        WARN_LIMIT,
      );
      await store.writeLimit(target.tenantId, target.chatId, 5);
      await store.writeLimit(target.tenantId, "-200", 2);
      expect(await store.readLimit(target.tenantId, target.chatId)).toBe(5);
      expect(await store.readLimit(target.tenantId, "-200")).toBe(2);
      expect(await store.readLimit(target.tenantId, "-300")).toBe(WARN_LIMIT);
      await store.writeLimit(target.tenantId, target.chatId, WARN_LIMIT);
      expect(await store.readLimit(target.tenantId, target.chatId)).toBe(
        WARN_LIMIT,
      );
      expect(await store.readLimit(target.tenantId, "-200")).toBe(2);
      await expect(
        store.writeLimit(target.tenantId, target.chatId, MIN_WARN_LIMIT - 1),
      ).rejects.toBeInstanceOf(WarnCapacityError);
      await expect(
        store.writeLimit(target.tenantId, target.chatId, MAX_WARN_LIMIT + 1),
      ).rejects.toBeInstanceOf(WarnCapacityError);
      await expect(
        store.writeLimit(target.tenantId, target.chatId, 1.5),
      ).rejects.toBeInstanceOf(WarnCapacityError);
      const crowded = create();
      for (let index = 0; index < MAX_WARN_CHATS; index += 1) {
        await crowded.writeLimit(target.tenantId, String(index), 2);
      }
      await expect(
        crowded.writeLimit(target.tenantId, "overflow", 2),
      ).rejects.toBeInstanceOf(WarnCapacityError);
      await crowded.writeLimit(target.tenantId, "0", 4);
      expect(await crowded.readLimit(target.tenantId, "0")).toBe(4);
      expect(await crowded.readLimit(target.tenantId, "overflow")).toBe(
        WARN_LIMIT,
      );
    });
  });
}
