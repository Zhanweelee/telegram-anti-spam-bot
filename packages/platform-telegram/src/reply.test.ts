import { describe, expect, it } from "vitest";
import { createTelegramReply } from "./reply.js";

describe("createTelegramReply", () => {
  it("posts sendMessage without putting the token in the error", async () => {
    const token = "test-token";
    let url = "";
    let body = "";
    const reply = createTelegramReply({
      token,
      fetchImpl: async (input, init) => {
        url = String(input);
        body = String(init?.body ?? "");
        return new Response("no", { status: 400 });
      },
    });
    await expect(
      reply.send({ tenantId: "local", chatId: "42", text: "命令：" }),
    ).rejects.toThrow("reply_failed");
    expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(body).toContain('"chat_id":42');
    expect(body).toContain("命令：");
    expect("reply_failed").not.toContain(token);
  });

  it("refuses to call Telegram when the token is missing", async () => {
    let called = false;
    const reply = createTelegramReply({
      token: "  ",
      fetchImpl: async () => {
        called = true;
        return new Response("ok");
      },
    });
    await expect(
      reply.send({ tenantId: "local", chatId: "42", text: "hi" }),
    ).rejects.toThrow("reply_unavailable");
    expect(called).toBe(false);
  });
});
