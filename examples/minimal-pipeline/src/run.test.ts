import { describe, expect, it } from "vitest";
import { screen } from "./run.js";

describe("minimal pipeline", () => {
  it("deletes a keyword hit and allows ordinary text", async () => {
    const spam = await screen("限时免费领取");
    expect(spam.result.decision.action).toBe("delete");
    expect(spam.result.actionResults[0]?.status).toBe("executed");
    expect(spam.deleted).toBe(1);
    expect(JSON.stringify(spam.audits)).not.toContain("限时免费领取");

    const ham = await screen("今晚八点见");
    expect(ham.result.decision.action).toBe("allow");
    expect(ham.result.actionResults).toHaveLength(0);
    expect(ham.deleted).toBe(0);
  });

  it("plans a delete without executing it when dry-run is on", async () => {
    const result = await screen("加微信", { dryRun: true });
    expect(result.result.decision.action).toBe("delete");
    expect(result.result.actionResults[0]?.status).toBe("skipped");
    expect(result.deleted).toBe(0);
    expect(result.audits).toHaveLength(0);
  });
});
