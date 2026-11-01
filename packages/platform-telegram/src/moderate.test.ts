import { describe, expect, it } from "vitest";
import {
  captchaPrompt,
  createTelegramModerator,
  sendCaptchaButton,
} from "./moderate.js";

describe("telegram captcha transport", () => {
  it("restricts until a unix date and does not leak the token", async () => {
    const token = "bot-token";
    let url = "";
    let body = "";
    const moderator = createTelegramModerator({
      token,
      nowSeconds: () => 1_700_000_000,
      fetchImpl: async (input, init) => {
        url = String(input);
        body = String(init?.body ?? "");
        return new Response("no", { status: 400 });
      },
    });
    await expect(
      moderator.restrictActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 300,
      }),
    ).rejects.toThrow("restrict_failed");
    expect(url).toBe(`https://api.telegram.org/bot${token}/restrictChatMember`);
    expect(body).toContain('"until_date":1700000300');
    expect(body).toContain('"can_send_messages":false');
    expect("restrict_failed").not.toContain(token);
  });

  it("does not call Telegram when the token is missing", async () => {
    let called = false;
    const moderator = createTelegramModerator({
      token: " ",
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    await expect(
      moderator.restrictActor({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 300,
      }),
    ).rejects.toThrow("restrict_unavailable");
    expect(called).toBe(false);
    await expect(
      moderator.deleteMessage({
        tenantId: "local",
        chatId: "-100",
        messageId: "1",
      }),
    ).resolves.toBeUndefined();
  });

  it("sends one button and releases with speaking permissions", async () => {
    const token = "bot-token";
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    };
    await sendCaptchaButton({
      token,
      chatId: "-100",
      nonce: "0123456789abcdef",
      fetchImpl,
    });
    expect(bodies[0]).toContain(captchaPrompt);
    expect(bodies[0]).toContain("c:0123456789abcdef");
    expect(bodies[0]).toContain("我不是机器人");
    const moderator = createTelegramModerator({ token, fetchImpl });
    await moderator.releaseActor({
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
    });
    expect(bodies[1]).toContain('"can_send_messages":true');
    expect(bodies[1]).not.toContain("until_date");
  });
});
