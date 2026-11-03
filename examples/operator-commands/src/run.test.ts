import {
  createMemoryReviewQueue,
  createMemoryRuleSubscriptionStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import { createMemoryRulePackArchive } from "@tasb/core";
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
    expect(help).toContain("/appeal");
    expect(help).toContain("/evals");
    expect(help).toContain("/packs");
    expect(help).toContain("/quota");
    expect(help).toContain("/delete");
    expect(help).toContain("/decline");
    expect(help).toContain("/approve");
    const approved = await runPrivateCommand({
      text: "/approve -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(approved).toBe("已批准 -100 77");
    const declined = await runPrivateCommand({
      text: "/decline -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(declined).toBe("已拒绝 -100 77");
    const deleted = await runPrivateCommand({
      text: "/delete -100 88",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(deleted).toBe("已删除 -100 88");
    expect(help).toContain("/member");
    const standing = await runPrivateCommand({
      text: "/member -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(standing).toBe("参数无效");
    expect(help).toContain("/mute");
    const muted = await runPrivateCommand({
      text: "/mute -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(muted).toBe("已禁言 -100 77 3600 秒");
    expect(help).toContain("/ban");
    const banned = await runPrivateCommand({
      text: "/ban -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(banned).toBe("已封禁 -100 77");
    expect(help).toContain("/unban");
    const unbanned = await runPrivateCommand({
      text: "/unban -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unbanned).toBe("已解除封禁 -100 77");
    expect(help).toContain("/unmute");
    const unmuted = await runPrivateCommand({
      text: "/unmute -100 77",
      actorId: "42",
      adminActorIds: ["42"],
    });
    expect(unmuted).toBe("已解除禁言 -100 77");
    const quota = await runPrivateCommand({
      text: "/quota -100",
      actorId: "42",
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["keyword", "join"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(quota).toBe(
      "quota -100 2/1 calendar_month basic until 2026-12-01T00:00:00.000Z\nkeyword,join",
    );
    expect(quota).not.toContain(phrase);
    const rules = await runPrivateCommand({
      text: "/rules -100",
      actorId: "42",
      adminActorIds: ["42"],
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
            basicDetectorIds: ["join"],
            resetsAt: "2026-12-01T00:00:00.000Z",
          };
        },
      },
    });
    expect(
      rules?.startsWith("rules -100 until 2026-12-01T00:00:00.000Z\n"),
    ).toBe(true);
    expect(rules).toContain(
      "spam_keywords enabled file threshold 1 actions delete paused",
    );
    expect(rules).not.toContain(phrase);
    const chats = await runPrivateCommand({
      text: "/chats",
      actorId: "42",
      adminActorIds: ["42"],
      chats: {
        async noteBot() {
          return "ok" as const;
        },
        async noteMember() {
          return "ok" as const;
        },
        async chatsFor() {
          return ["-100"];
        },
        async list() {
          return ["-100"];
        },
      },
      quota: {
        async read() {
          return {
            enabled: true,
            used: 2,
            limit: 1,
            period: "calendar_month",
            degraded: true,
          };
        },
      },
    });
    expect(chats).toBe("chats\n-100 2/1");
    expect(chats).not.toContain(phrase);
    expect(help).toContain("/chats");
    expect(help).toContain("/rule");
    expect(help).not.toContain(phrase);
    const english = await runPrivateCommand({
      text: "/help",
      actorId: "42",
      adminActorIds: ["42"],
      locale: "en",
    });
    expect(english?.startsWith("Commands:")).toBe(true);
    expect(english).not.toContain(phrase);

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
    const review = createMemoryReviewQueue();
    const appeal = await runPrivateCommand({
      text: "/appeal -100 evt_1 false",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
      review,
    });
    expect(appeal).toBe("appeal -100 evt_1 误判");
    expect(
      JSON.stringify(await review.list({ tenantId: "local" })),
    ).not.toContain(phrase);
    const evals = await runPrivateCommand({
      text: "/evals -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
      review,
    });
    expect(evals).toContain('"label":"ham"');
    expect(evals).not.toContain(phrase);
    expect(evals).not.toContain('"text"');
    const forgotten = await runPrivateCommand({
      text: "/forget -100",
      actorId: "42",
      adminActorIds: ["42"],
      storage,
    });
    const packs = createMemoryRuleSubscriptionStore();
    const subscribed = await runPrivateCommand({
      text: "/packs -100 community",
      actorId: "42",
      adminActorIds: ["42"],
      rulePacks: packs,
    });
    expect(subscribed).toBe("packs -100 community");
    expect(await packs.get("local", "-100")).toBe("community");
    const archive = createMemoryRulePackArchive();
    const packSource = {
      async load() {
        return {
          version: 1,
          aggregate: "max",
          rules: [
            {
              id: "community_keywords",
              enabled: true,
              detectorIds: ["keyword"],
              threshold: 2,
              actions: ["delete"],
            },
          ],
        };
      },
    };
    const packed = await runPrivateCommand({
      text: "/rules -100",
      actorId: "42",
      adminActorIds: ["42"],
      rulePacks: packs,
      rulePackSource: packSource,
      rulePackArchive: archive,
    });
    expect(packed?.startsWith("rules -100 community\n")).toBe(true);
    expect(packed).toContain("community_keywords enabled file");
    expect(packed).not.toContain("spam_keywords");
    const cleared = await runPrivateCommand({
      text: "/packs -100 off",
      actorId: "42",
      adminActorIds: ["42"],
      rulePacks: packs,
    });
    expect(cleared).toBe("packs -100 none");
    expect(forgotten).toBe("已删除 1 条");
    expect(await review.list({ tenantId: "local" })).toHaveLength(1);
    expect(
      await storage.listAudits({
        tenantId: "local",
        chatId: "-100",
        limit: 10,
      }),
    ).toEqual([]);
  });
});
