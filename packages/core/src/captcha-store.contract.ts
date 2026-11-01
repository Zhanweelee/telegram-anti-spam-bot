import { describe, expect, it } from "vitest";
import type { CaptchaStore } from "./captcha.js";

export function bindCaptchaStoreContract(create: () => CaptchaStore): void {
  describe("captcha store contract", () => {
    it("returns null when no challenge is stored", async () => {
      const store = create();
      expect(await store.get("tenant_a", "chat_1", "user_1")).toBeNull();
    });

    it("round-trips one actor and isolates the others", async () => {
      const store = create();
      const challenge = {
        tenantId: "tenant_a",
        chatId: "chat_1",
        actorId: "user_1",
        nonce: "ab".repeat(8),
        expiresAt: "2026-11-01T00:05:00.000Z",
      };
      await store.put(challenge);
      expect(await store.get("tenant_a", "chat_1", "user_1")).toEqual(
        challenge,
      );
      expect(await store.get("tenant_b", "chat_1", "user_1")).toBeNull();
      expect(await store.get("tenant_a", "chat_2", "user_1")).toBeNull();
      expect(await store.get("tenant_a", "chat_1", "user_2")).toBeNull();
    });

    it("replaces the challenge and deletes only that actor", async () => {
      const store = create();
      const first = {
        tenantId: "tenant_a",
        chatId: "chat_1",
        actorId: "user_1",
        nonce: "ab".repeat(8),
        expiresAt: "2026-11-01T00:05:00.000Z",
      };
      const second = { ...first, nonce: "cd".repeat(8) };
      await store.put(first);
      await store.put(second);
      await store.put({ ...first, actorId: "user_2", nonce: "ef".repeat(8) });
      await store.delete("tenant_a", "chat_1", "user_1");
      expect(await store.get("tenant_a", "chat_1", "user_1")).toBeNull();
      expect(await store.get("tenant_a", "chat_1", "user_2")).toMatchObject({
        nonce: "ef".repeat(8),
      });
    });

    it("lists only challenges due at the clock", async () => {
      const store = create();
      const due = {
        tenantId: "tenant_a",
        chatId: "chat_1",
        actorId: "user_1",
        nonce: "ab".repeat(8),
        expiresAt: "2026-11-01T00:05:00.000Z",
      };
      await store.put(due);
      await store.put({
        ...due,
        actorId: "user_2",
        nonce: "cd".repeat(8),
        expiresAt: "2026-11-01T00:10:00.000Z",
      });
      expect(await store.listExpired("2026-11-01T00:05:00.000Z")).toEqual([
        due,
      ]);
      expect(await store.listExpired("2026-11-01T00:04:00.000Z")).toEqual([]);
    });
  });
}
