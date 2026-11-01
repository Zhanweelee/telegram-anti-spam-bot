import { describe, expect, it } from "vitest";
import { parseEvent } from "./event.js";
import {
  buildReportNotice,
  createMemoryNotifier,
  formatReportNotice,
} from "./report.js";

const phrase = "请免费领取礼品";

describe("report notices", () => {
  it("drops message text and unsafe reasons", async () => {
    const event = parseEvent({
      id: "evt_1",
      tenantId: "local",
      chatId: "-100",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "5", isAdmin: false },
      message: { id: "9", text: phrase, textSha256: "ab".repeat(32) },
    });
    const notice = buildReportNotice(event, {
      action: "report",
      ruleIds: ["spam_keywords", phrase],
      score: 1,
      reasons: ["keyword_match", phrase],
      evidence: [{ kind: "keyword", summary: phrase }],
    });
    expect(notice.reasons).toEqual(["keyword_match"]);
    expect(notice.ruleIds).toEqual(["spam_keywords"]);
    expect(JSON.stringify(notice)).not.toContain(phrase);
    const text = formatReportNotice(notice);
    expect(text).toBe(
      "report -100 evt_1 score 1 rules spam_keywords reasons keyword_match",
    );
    expect(text).not.toContain(phrase);
    const empty = buildReportNotice(event, {
      action: "log",
      ruleIds: [],
      score: 0,
      reasons: [],
      evidence: [],
    });
    expect(formatReportNotice(empty)).toBe(
      "report -100 evt_1 score 0 rules none reasons none",
    );
    const notifier = createMemoryNotifier();
    await notifier.notify(notice);
    expect(notifier.notices).toEqual([notice]);
  });

  it("rejects a notice that carries a text field", async () => {
    const notifier = createMemoryNotifier();
    await expect(
      notifier.notify({
        tenantId: "local",
        chatId: "-100",
        eventId: "evt_1",
        score: 1,
        reasons: ["keyword_match"],
        ruleIds: ["spam_keywords"],
        text: phrase,
      } as never),
    ).rejects.toThrow();
    expect(notifier.notices).toHaveLength(0);
  });
});
