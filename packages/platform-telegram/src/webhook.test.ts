import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLogger, type Event } from "@tasb/core";
import { describe, expect, it } from "vitest";
import { secretsMatch } from "./secret.js";
import {
  handleTelegramWebhook,
  MAX_WEBHOOK_BODY_BYTES,
  TELEGRAM_SECRET_HEADER,
} from "./webhook.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const SECRET = "dev-secret";

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function request(body: string, header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) {
    headers.set(TELEGRAM_SECRET_HEADER, header);
  }
  return new Request("https://bot.example/telegram/webhook", {
    method: "POST",
    headers,
    body,
  });
}

async function post(
  body: string,
  options?: {
    readonly header?: string;
    readonly secret?: string;
    readonly onEvent?: (event: Event) => Promise<void>;
  },
) {
  const events: Event[] = [];
  const logger = createMemoryLogger();
  let calls = 0;
  const response = await handleTelegramWebhook(request(body, options?.header), {
    secretToken: options && "secret" in options ? options.secret : SECRET,
    tenantId: "local",
    logger,
    onEvent: async (event) => {
      calls += 1;
      events.push(event);
      await options?.onEvent?.(event);
    },
  });
  return { response, events, calls, logger };
}

describe("secretsMatch", () => {
  it("matches equal secrets and rejects everything else", async () => {
    expect(await secretsMatch("abc", "abc")).toBe(true);
    expect(await secretsMatch("abcdef", "abc")).toBe(false);
    expect(await secretsMatch("", "abc")).toBe(false);
    expect(await secretsMatch("a".repeat(257), "a".repeat(257))).toBe(false);
  });
});

describe("handleTelegramWebhook", () => {
  it("returns 401 and skips the pipeline when the secret is unset", async () => {
    const { response, calls, logger } = await post(fixture("message.json"), {
      header: SECRET,
      secret: "",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(calls).toBe(0);
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
  });

  it("returns 401 when the header is missing or wrong", async () => {
    const missing = await post(fixture("message.json"));
    expect(missing.response.status).toBe(401);
    expect(missing.calls).toBe(0);

    const wrong = await post(fixture("message.json"), { header: "nope" });
    expect(wrong.response.status).toBe(401);
    expect(wrong.calls).toBe(0);
    expect(JSON.stringify(wrong.logger.entries)).not.toContain("hello");
    expect(JSON.stringify(wrong.logger.entries)).not.toContain(SECRET);
  });

  it("returns 400 for invalid JSON and does not echo the body", async () => {
    const phrase = "请免费领取礼品";
    const { response, calls, logger } = await post(`{"text":"${phrase}"`, {
      header: SECRET,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_json",
    });
    expect(calls).toBe(0);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
  });

  it("returns 400 when update_id is missing", async () => {
    const { response, calls } = await post("{}", { header: SECRET });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: "invalid_update",
    });
    expect(calls).toBe(0);
  });

  it("returns 200 ignored for unsupported updates", async () => {
    const { response, calls } = await post(
      JSON.stringify({ update_id: 9, callback_query: { id: "1" } }),
      { header: SECRET },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
    expect(calls).toBe(0);
  });

  it("normalizes a join and hides display names from the response", async () => {
    const { response, events, calls } = await post(
      fixture("chat-member.json"),
      {
        header: SECRET,
      },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain("Newbie");
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(events[0]?.kind).toBe("chat_member");
    expect(events[0]?.message).toBeUndefined();
    expect(events[0]?.actor).toEqual({ id: "77", isAdmin: false });
  });

  it("normalizes a valid fixture and hides the text from the response", async () => {
    const { response, events, calls } = await post(
      fixture("message-admin.json"),
      {
        header: SECRET,
      },
    );
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain("公告");
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(events[0]?.actor.isAdmin).toBe(true);
    expect(events[0]?.message?.id).toBe("12");
  });

  it("still returns 200 when screening throws, without logging the error text", async () => {
    const phrase = "请免费领取礼品";
    const { response, logger } = await post(fixture("message.json"), {
      header: SECRET,
      onEvent: async () => {
        throw new Error(phrase);
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const logged = JSON.stringify(logger.entries);
    expect(logged).toContain("webhook_screen_failed");
    expect(logged).not.toContain(phrase);
    expect(logged).not.toContain("hello");
  });

  it("rejects oversized bodies before the pipeline", async () => {
    const { response, calls } = await post(
      "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
      { header: SECRET },
    );
    expect(response.status).toBe(413);
    expect(calls).toBe(0);
  });
});
