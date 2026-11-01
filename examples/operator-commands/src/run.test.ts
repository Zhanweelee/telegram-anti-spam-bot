import { createMemoryStorage } from "@tasb/adapter-memory";
import { describe, expect, it } from "vitest";
import { runPrivateCommand } from "./run.js";

describe("operator command example", () => {
  it("shows help to a configured admin and hides audit text", async () => {
    const phrase = "请免费领取礼品";
    const help = await runPrivateCommand({
      text: `/help ${phrase}`,
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(help).toContain("/logs");
    expect(help).toContain("/blocklist");
    expect(help).not.toContain(phrase);

    const storage = createMemoryStorage();
    await storage.appendAudit({
      tenantId: "local",
      chatId: "-100",
      eventId: "evt_1",
      action: "delete",
      score: 1,
      reasons: ["keyword_match"],
      evidence: [{ kind: "keyword", summary: phrase }],
      ruleIds: ["spam_keywords"],
      createdAt: "2026-11-01T00:00:00Z",
    });
    const logs = await runPrivateCommand({
      text: "/logs -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    expect(logs).toContain("evt_1");
    expect(logs).not.toContain(phrase);

    const exported = await runPrivateCommand({
      text: "/export -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    expect(exported).toContain('"audits"');
    expect(exported).not.toContain('"text"');
    const forgotten = await runPrivateCommand({
      text: "/forget -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    expect(forgotten).toBe("已删除 1 条");
    expect(
      await storage.listAudits({
        tenantId: "local",
        chatId: "-100",
        limit: 10,
      }),
    ).toEqual([]);
  });
});
