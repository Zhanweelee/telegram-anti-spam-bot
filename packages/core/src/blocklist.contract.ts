import { describe, expect, it } from "vitest";
import {
  type BlocklistStore,
  MAX_BLOCKLIST_CHATS,
  MAX_BLOCKLIST_ENTRIES,
} from "./blocklist.js";

const phrase = "请免费领取礼品";
const hash = "ab".repeat(32);

/**
 * Behavioral contract shared by every `BlocklistStore`.
 * Call it from a test file at load time so each adapter runs the same cases.
 */
export function bindBlocklistStoreContract(create: () => BlocklistStore): void {
  describe("blocklist store contract", () => {
    it("starts with opt-in off and an empty shared set", async () => {
      const store = create();
      expect(await store.isEnabled("tenant_a", "chat_1")).toBe(false);
      expect(await store.has("tenant_a", { kind: "actor", value: "9" })).toBe(
        false,
      );
    });

    it("enables one chat without enabling another tenant or chat", async () => {
      const store = create();
      await store.setEnabled("tenant_a", "chat_1", true);
      expect(await store.isEnabled("tenant_a", "chat_1")).toBe(true);
      expect(await store.isEnabled("tenant_a", "chat_2")).toBe(false);
      expect(await store.isEnabled("tenant_b", "chat_1")).toBe(false);
      await store.setEnabled("tenant_a", "chat_1", false);
      expect(await store.isEnabled("tenant_a", "chat_1")).toBe(false);
    });

    it("shares actor ids and hashes inside one tenant only", async () => {
      const store = create();
      await store.add("tenant_a", { kind: "actor", value: "user_9" });
      await store.add("tenant_a", { kind: "hash", value: hash });
      expect(
        await store.has("tenant_a", { kind: "actor", value: "user_9" }),
      ).toBe(true);
      expect(await store.has("tenant_a", { kind: "hash", value: hash })).toBe(
        true,
      );
      expect(
        await store.has("tenant_b", { kind: "actor", value: "user_9" }),
      ).toBe(false);
      await store.add("tenant_a", { kind: "actor", value: "user_9" });
      expect(
        await store.has("tenant_a", { kind: "actor", value: "user_9" }),
      ).toBe(true);
    });

    it("keeps shared entries after a chat turns off", async () => {
      const store = create();
      await store.setEnabled("tenant_a", "chat_1", true);
      await store.setEnabled("tenant_a", "chat_2", true);
      await store.add("tenant_a", { kind: "actor", value: "9" });
      await store.setEnabled("tenant_a", "chat_2", false);
      expect(await store.isEnabled("tenant_a", "chat_2")).toBe(false);
      expect(await store.isEnabled("tenant_a", "chat_1")).toBe(true);
      expect(await store.has("tenant_a", { kind: "actor", value: "9" })).toBe(
        true,
      );
    });

    it("rejects message text and anything that is not an id or hash", async () => {
      const store = create();
      await expect(
        store.add("tenant_a", { kind: "actor", value: phrase }),
      ).rejects.toThrow();
      await expect(
        store.add("tenant_a", { kind: "hash", value: phrase }),
      ).rejects.toThrow();
      await expect(
        store.add("tenant_a", { kind: "actor", value: "hello world" }),
      ).rejects.toThrow();
      await expect(
        store.add("tenant_a", { kind: "hash", value: hash.toUpperCase() }),
      ).rejects.toThrow();
      await expect(
        store.add("tenant_a", {
          kind: "actor",
          value: "9",
          text: phrase,
        } as unknown as { kind: "actor"; value: string }),
      ).rejects.toThrow();
      expect(await store.has("tenant_a", { kind: "actor", value: "9" })).toBe(
        false,
      );
    });

    it("caps chats and entries per tenant", async () => {
      const store = create();
      for (let index = 0; index < MAX_BLOCKLIST_CHATS; index += 1) {
        await store.setEnabled("tenant_a", `c${index}`, true);
      }
      await store.setEnabled("tenant_a", "c0", true);
      await expect(
        store.setEnabled("tenant_a", "overflow", true),
      ).rejects.toThrow("blocklist_full");
      await store.setEnabled("tenant_b", "overflow", true);
      expect(await store.isEnabled("tenant_b", "overflow")).toBe(true);
      await store.setEnabled("tenant_a", "c0", false);
      await store.setEnabled("tenant_a", "overflow", true);
      expect(await store.isEnabled("tenant_a", "overflow")).toBe(true);

      for (let index = 0; index < MAX_BLOCKLIST_ENTRIES; index += 1) {
        await store.add("tenant_a", { kind: "actor", value: `u${index}` });
      }
      await store.add("tenant_a", { kind: "actor", value: "u0" });
      await expect(
        store.add("tenant_a", { kind: "actor", value: "overflow" }),
      ).rejects.toThrow("blocklist_full");
      await store.add("tenant_b", { kind: "actor", value: "overflow" });
      expect(
        await store.has("tenant_b", { kind: "actor", value: "overflow" }),
      ).toBe(true);
      expect(await store.has("tenant_a", { kind: "actor", value: "u0" })).toBe(
        true,
      );
    });
  });
}
