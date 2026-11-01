import { describe, expect, it } from "vitest";
import type { PolicyStore } from "./policy-store.js";

/**
 * Behavioral contract shared by every `PolicyStore`.
 * Call it from a test file at load time so each adapter runs the same cases.
 */
export function bindPolicyStoreContract(create: () => PolicyStore): void {
  describe("policy store contract", () => {
    it("returns null when nothing is stored", async () => {
      const store = create();
      expect(await store.get("tenant_a", "chat_1")).toBeNull();
    });

    it("round-trips one tenant and chat", async () => {
      const store = create();
      const policy = { exemptAdmins: false, allowActorIds: ["b", "a"] };
      await store.put("tenant_a", "chat_1", policy);
      expect(await store.get("tenant_a", "chat_1")).toEqual(policy);
      expect(await store.get("tenant_b", "chat_1")).toBeNull();
      expect(await store.get("tenant_a", "chat_2")).toBeNull();
    });

    it("replaces the policy for that chat", async () => {
      const store = create();
      await store.put("tenant_a", "chat_1", {
        exemptAdmins: true,
        allowActorIds: ["1"],
      });
      await store.put("tenant_a", "chat_1", {
        exemptAdmins: false,
        allowActorIds: [],
      });
      expect(await store.get("tenant_a", "chat_1")).toEqual({
        exemptAdmins: false,
        allowActorIds: [],
      });
    });

    it("rejects an empty actor id", async () => {
      const store = create();
      await expect(
        store.put("tenant_a", "chat_1", {
          exemptAdmins: true,
          allowActorIds: [""],
        }),
      ).rejects.toThrow();
    });

    it("rejects an actor id longer than 128 characters", async () => {
      const store = create();
      await expect(
        store.put("tenant_a", "chat_1", {
          exemptAdmins: true,
          allowActorIds: ["a".repeat(129)],
        }),
      ).rejects.toThrow();
    });

    it("rejects more than 200 actor ids", async () => {
      const store = create();
      const allowActorIds = Array.from({ length: 201 }, (_, index) => {
        return `u${index}`;
      });
      await expect(
        store.put("tenant_a", "chat_1", {
          exemptAdmins: false,
          allowActorIds,
        }),
      ).rejects.toThrow();
    });
  });
}
