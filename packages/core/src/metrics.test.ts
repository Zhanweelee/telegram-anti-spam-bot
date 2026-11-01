import { describe, expect, it } from "vitest";
import type { LogEntry } from "./logger.js";
import { aggregateMetrics } from "./metrics.js";

const phrase = "请免费领取礼品";
const nickname = "Ada Lovelace";

function entry(message: string, fields: LogEntry["fields"]): LogEntry {
  return { level: "info", message, fields };
}

describe("aggregateMetrics", () => {
  it("counts intercepts, actions, detector errors, and storage failures", () => {
    const report = aggregateMetrics([
      entry("pipeline_completed", {
        tenantId: "tenant_a",
        chatId: "-100",
        action: "delete",
        dryRun: false,
      }),
      entry("pipeline_completed", {
        tenantId: "tenant_a",
        chatId: "-200",
        action: "allow",
        dryRun: false,
      }),
      entry("pipeline_exempt", {
        tenantId: "tenant_b",
        chatId: "-100",
        reason: "admin",
      }),
      entry("pipeline_completed", {
        tenantId: "tenant_a",
        chatId: "-100",
        action: "delete",
        dryRun: true,
      }),
      entry("pipeline_completed", {
        tenantId: "tenant_a",
        chatId: "-100",
        action: "log",
        dryRun: false,
      }),
      entry("detector_error", {
        tenantId: "tenant_a",
        chatId: "-100",
        detectorId: "keyword",
        code: "detector_failed",
      }),
      entry("llm_failed", {
        tenantId: "tenant_a",
        chatId: "-100",
        detectorId: "llm",
      }),
      entry("rate_window_skipped", {
        tenantId: "tenant_a",
        chatId: "-100",
        detectorId: "flood",
      }),
      entry("audit_failed", {
        tenantId: "tenant_a",
        chatId: "-100",
        code: "storage_failed",
      }),
      entry("audit_failed", {
        tenantId: "tenant_a",
        chatId: "-100",
        code: "raw_content_rejected",
      }),
      entry("policy_store_failed", {
        tenantId: "tenant_b",
        chatId: "-100",
      }),
    ]);
    expect(report.totals).toEqual({
      screened: 4,
      exempt: 1,
      intercepted: 1,
      interceptRate: 0.25,
      dryRun: 1,
      actions: { allow: 1, log: 1, delete: 1 },
      detectorErrors: 2,
      storageFailures: 2,
    });
    expect(report.chats.map((chat) => chat.chatId)).toEqual([
      "-100",
      "-200",
      "-100",
    ]);
    expect(report.chats[0]).toMatchObject({
      tenantId: "tenant_a",
      intercepted: 1,
      detectorErrors: 2,
      storageFailures: 1,
    });
    expect(report.chats[2]).toMatchObject({
      tenantId: "tenant_b",
      exempt: 1,
      storageFailures: 1,
    });
  });

  it("drops message text and nicknames from labels", () => {
    const report = aggregateMetrics([
      entry("pipeline_completed", {
        tenantId: "local",
        chatId: nickname,
        action: phrase,
        dryRun: false,
        text: phrase,
        firstName: nickname,
        username: nickname,
      }),
      entry("pipeline_completed", {
        tenantId: "local",
        chatId: "-100",
        action: "ban",
        dryRun: false,
        name: nickname,
      }),
      entry("blocklist_failed", {
        chatId: "-100",
        detectorId: "blocklist",
        body: phrase,
      }),
      entry("reputation_failed", {
        tenantId: "local",
        chatId: "-100",
        detectorId: "link",
      }),
      entry("rate_window_failed", {
        tenantId: "local",
        chatId: "-100",
        detectorId: "flood",
      }),
    ]);
    expect(report.totals.screened).toBe(1);
    expect(report.totals.intercepted).toBe(1);
    expect(report.totals.interceptRate).toBe(1);
    expect(report.totals.actions).toEqual({ ban: 1 });
    expect(report.totals.detectorErrors).toBe(3);
    expect(report.chats).toHaveLength(1);
    const json = JSON.stringify(report);
    expect(json).not.toContain(phrase);
    expect(json).not.toContain(nickname);
    expect(json).not.toContain("firstName");
    expect(json).not.toContain("username");
  });

  it("returns zeros for an empty log", () => {
    expect(aggregateMetrics([])).toEqual({
      totals: {
        screened: 0,
        exempt: 0,
        intercepted: 0,
        interceptRate: 0,
        dryRun: 0,
        actions: {},
        detectorErrors: 0,
        storageFailures: 0,
      },
      chats: [],
    });
  });
});
