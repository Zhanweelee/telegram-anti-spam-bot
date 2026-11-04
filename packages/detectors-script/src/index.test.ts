import { type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { createScriptDetector, type ScriptLock } from "./index.js";

const arabic = "اشتر الآن مجانا اليوم";
const cyrillic = "Бесплатно получите подарок";
const chinese = "今天站会没有广告";

function eventFor(
  text: string,
  kind: "message" | "chat_member" = "message",
): Event {
  return parseEvent({
    id: "evt_script",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind,
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    ...(kind === "message"
      ? {
          message: {
            id: "msg_1",
            text,
            textSha256: "c".repeat(64),
          },
        }
      : {}),
  });
}

async function hitFor(
  script: ScriptLock,
  text: string,
  kind?: "message" | "chat_member",
) {
  return createScriptDetector(script).detect({
    event: eventFor(text, kind),
    logger: { info() {}, warn() {}, error() {} },
    signal: { aborted: false },
  });
}

describe("script detector", () => {
  it("scores a message whose letters are mostly that script", async () => {
    const hit = await hitFor("arabic", arabic);
    expect(hit).toEqual({
      detectorId: "script_arabic",
      score: 1,
      reasons: ["script_arabic"],
      evidence: [{ kind: "feature", summary: "script:arabic" }],
    });
    expect(JSON.stringify(hit)).not.toContain(arabic);

    const russian = await hitFor("cyrillic", cyrillic);
    expect(russian).toEqual({
      detectorId: "script_cyrillic",
      score: 1,
      reasons: ["script_cyrillic"],
      evidence: [{ kind: "feature", summary: "script:cyrillic" }],
    });
    expect(JSON.stringify(russian)).not.toContain(cyrillic);
  });

  it("leaves the other script, a tie, a short run, and digits", async () => {
    expect(await hitFor("arabic", cyrillic)).toBeNull();
    expect(await hitFor("cyrillic", arabic)).toBeNull();
    expect(await hitFor("arabic", chinese)).toBeNull();
    expect(await hitFor("arabic", "hello مرحبا")).toBeNull();
    expect(await hitFor("cyrillic", "你好世界аеор")).toBeNull();
    expect(await hitFor("arabic", "نعم")).toBeNull();
    expect(await hitFor("arabic", "١٢٣٤٥٦٧٨")).toBeNull();
    expect(await hitFor("arabic", "مَرْحَبًا")).toEqual({
      detectorId: "script_arabic",
      score: 1,
      reasons: ["script_arabic"],
      evidence: [{ kind: "feature", summary: "script:arabic" }],
    });
    expect(await hitFor("arabic", "\uFE8D\uFE8D\uFE8D\uFE8D")).toEqual({
      detectorId: "script_arabic",
      score: 1,
      reasons: ["script_arabic"],
      evidence: [{ kind: "feature", summary: "script:arabic" }],
    });
    expect(await hitFor("arabic", arabic, "chat_member")).toBeNull();
  });
});
