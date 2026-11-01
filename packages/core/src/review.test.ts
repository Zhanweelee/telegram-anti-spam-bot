import { describe, expect, it } from "vitest";
import type { AuditRecord } from "./ports.js";
import {
  buildReviewSample,
  createMemoryReviewQueue,
  parseReviewSample,
} from "./review.js";
import { bindReviewQueueContract } from "./testing.js";

const phrase = "请免费领取礼品";

bindReviewQueueContract(createMemoryReviewQueue);

const audit: AuditRecord = {
  tenantId: "local",
  chatId: "-100",
  eventId: "tg_9",
  messageId: "10",
  textSha256: "cd".repeat(32),
  action: "delete",
  score: 1,
  reasons: ["keyword_match", `${"x".repeat(81)}`, `line\n${phrase}`],
  evidence: [{ kind: "keyword", summary: phrase }],
  ruleIds: ["spam_keywords"],
  createdAt: "2026-11-01T00:00:00.000Z",
};

describe("buildReviewSample", () => {
  it("keeps the hash and drops evidence and long reasons", () => {
    const sample = buildReviewSample(
      audit,
      "false_positive",
      "2026-11-01T00:05:00.000Z",
    );
    expect(sample).toEqual({
      tenantId: "local",
      chatId: "-100",
      eventId: "tg_9",
      label: "false_positive",
      textSha256: "cd".repeat(32),
      action: "delete",
      score: 1,
      reasons: ["keyword_match", "redacted", "redacted"],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:05:00.000Z",
    });
    expect(JSON.stringify(sample)).not.toContain(phrase);
    expect(JSON.stringify(sample)).not.toContain("messageId");
  });

  it("rejects a document that names message text", () => {
    expect(() => parseReviewSample({ text: phrase })).toThrow();
  });

  it("orders samples by time and then event id", async () => {
    const queue = createMemoryReviewQueue();
    const earlier = "2026-11-01T00:00:00.000Z";
    const later = "2026-11-01T00:05:00.000Z";
    await queue.enqueue({ ...auditSample(later), eventId: "evt_late" });
    await queue.enqueue({ ...auditSample(earlier), eventId: "evt_b" });
    await queue.enqueue({ ...auditSample(earlier), eventId: "evt_a" });
    const listed = await queue.list({ tenantId: "local" });
    expect(listed.map((item) => item.eventId)).toEqual([
      "evt_a",
      "evt_b",
      "evt_late",
    ]);
  });
});

function auditSample(createdAt: string) {
  return buildReviewSample(audit, "confirmed", createdAt);
}
