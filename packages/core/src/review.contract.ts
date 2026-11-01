import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_SAMPLES,
  ReviewCapacityError,
  type ReviewQueue,
  type ReviewSample,
} from "./review.js";

const phrase = "请免费领取礼品";

const sample: ReviewSample = {
  tenantId: "tenant_a",
  chatId: "chat_1",
  eventId: "evt_1",
  label: "false_positive",
  textSha256: "ab".repeat(32),
  action: "delete",
  score: 1,
  reasons: ["keyword_match"],
  ruleIds: ["spam_keywords"],
  createdAt: "2026-11-01T00:00:00.000Z",
};

/**
 * Behavioral contract shared by every `ReviewQueue`.
 * Call it from a test file at load time so each adapter runs the same cases.
 */
export function bindReviewQueueContract(create: () => ReviewQueue): void {
  describe("review queue contract", () => {
    it("starts empty and keeps tenants apart", async () => {
      const queue = create();
      expect(await queue.list({ tenantId: "tenant_a" })).toEqual([]);
      await queue.enqueue(sample);
      expect(await queue.list({ tenantId: "tenant_a" })).toEqual([sample]);
      expect(await queue.list({ tenantId: "tenant_b" })).toEqual([]);
      expect(
        await queue.list({ tenantId: "tenant_a", chatId: "chat_2" }),
      ).toEqual([]);
    });

    it("replaces the label for the same audit and leaves the audit text out", async () => {
      const queue = create();
      await queue.enqueue(sample);
      await queue.enqueue({ ...sample, label: "confirmed" });
      const listed = await queue.list({ tenantId: "tenant_a" });
      expect(listed).toEqual([{ ...sample, label: "confirmed" }]);
      expect(JSON.stringify(listed)).not.toContain(phrase);
      expect(JSON.stringify(listed)).not.toContain('"text"');
    });

    it("rejects a sample that carries a text field", async () => {
      const queue = create();
      const extra = { ...sample, text: phrase } as ReviewSample;
      await expect(queue.enqueue(extra)).rejects.toThrow();
    });

    it("stops a new sample when the tenant is full and still updates one", async () => {
      const queue = create();
      for (let index = 0; index < MAX_REVIEW_SAMPLES; index += 1) {
        await queue.enqueue({ ...sample, eventId: `evt_${index}` });
      }
      await expect(
        queue.enqueue({ ...sample, eventId: "evt_extra" }),
      ).rejects.toBeInstanceOf(ReviewCapacityError);
      await queue.enqueue({
        ...sample,
        eventId: "evt_0",
        label: "confirmed",
      });
      const listed = await queue.list({ tenantId: "tenant_a" });
      expect(listed).toHaveLength(MAX_REVIEW_SAMPLES);
      expect(listed.find((item) => item.eventId === "evt_0")?.label).toBe(
        "confirmed",
      );
      await queue.enqueue({
        ...sample,
        tenantId: "tenant_b",
        eventId: "evt_other",
      });
      expect(await queue.list({ tenantId: "tenant_b" })).toHaveLength(1);
    });
  });
}
