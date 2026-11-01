import { RawContentError } from "./errors.js";

const FORBIDDEN_KEYS = new Set([
  "text",
  "body",
  "caption",
  "raw",
  "messageText",
  "content",
]);

export function assertNoRawContent(value: unknown, rawText?: string): void {
  walk(value, rawText);
}

function walk(value: unknown, rawText: string | undefined): void {
  if (typeof value === "string") {
    if (rawText && rawText.length > 0 && value === rawText) {
      throw new RawContentError();
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, rawText);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new RawContentError();
      }
      walk(child, rawText);
    }
  }
}

export function redactExactText(
  value: string,
  rawText: string | undefined,
): string {
  if (rawText && rawText.length > 0 && value === rawText) {
    return "redacted";
  }
  return value;
}
