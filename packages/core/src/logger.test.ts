import { describe, expect, it } from "vitest";
import { createSystemClock } from "./clock.js";
import { moreSevere } from "./decision.js";
import { createMemoryLogger, sanitizeFields, wrapLogger } from "./logger.js";

describe("logger and clock", () => {
  it("drops raw fields", () => {
    expect(sanitizeFields(undefined)).toEqual({});
    expect(
      sanitizeFields({
        text: "secret",
        action: "delete",
        score: 1,
        dryRun: false,
      }),
    ).toEqual({
      action: "delete",
      score: 1,
      dryRun: false,
    });
    const logger = createMemoryLogger();
    logger.info("ok", { text: "secret", chatId: "c1" });
    expect(logger.entries[0]?.fields).toEqual({ chatId: "c1" });
    const seen: unknown[] = [];
    const wrapped = wrapLogger({
      info(message, fields) {
        seen.push([message, fields]);
      },
      warn() {},
      error() {},
    });
    wrapped.warn("w", { body: "nope", ok: true });
    wrapped.error("e");
    expect(seen).toEqual([]);
  });

  it("wraps every level and formats system time", () => {
    const seen: string[] = [];
    const wrapped = wrapLogger({
      info(message) {
        seen.push(message);
      },
      warn(message) {
        seen.push(message);
      },
      error(message) {
        seen.push(message);
      },
    });
    wrapped.info("i");
    wrapped.warn("w");
    wrapped.error("e");
    expect(seen).toEqual(["i", "w", "e"]);
    expect(createSystemClock().nowIso()).toMatch(/Z$/);
    expect(moreSevere("ban", "delete")).toBe("ban");
    expect(moreSevere("log", "mute")).toBe("mute");
  });
});
