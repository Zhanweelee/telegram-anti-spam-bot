import { type Detector, defineDetector } from "@tasb/core";
import { z } from "zod";

export const scriptLocks = ["arabic", "cyrillic"] as const;
export type ScriptLock = (typeof scriptLocks)[number];

const MIN_SCRIPT_LETTERS = 4;
const letter = /\p{L}/u;
const patterns = {
  arabic: /\p{Script=Arabic}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
} as const satisfies Record<ScriptLock, RegExp>;

export function createScriptDetector(script: ScriptLock): Detector {
  const id = `script_${script}`;
  const pattern = patterns[script];
  return defineDetector({
    id,
    version: "0.1.0",
    capabilities: ["message"],
    configSchema: z.strictObject({}),
    config: {},
    async detect(ctx) {
      const text =
        ctx.event.kind === "message" ? ctx.event.message?.text : undefined;
      if (text === undefined || !mostlyScript(text, pattern)) {
        return null;
      }
      return {
        detectorId: id,
        score: 1,
        reasons: [id],
        evidence: [{ kind: "feature", summary: `script:${script}` }],
      };
    },
  });
}

function mostlyScript(text: string, pattern: RegExp): boolean {
  let target = 0;
  let other = 0;
  for (const char of text) {
    if (!letter.test(char)) {
      continue;
    }
    if (pattern.test(char)) {
      target += 1;
    } else {
      other += 1;
    }
  }
  return target >= MIN_SCRIPT_LETTERS && target > other;
}
