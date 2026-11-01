import { describe, expect, it } from "vitest";
import { receiveUpdate } from "./receive.js";

const body = JSON.stringify({
  update_id: 1,
  message: {
    message_id: 8,
    date: 1761955200,
    chat: { id: -100 },
    from: { id: 3 },
    text: "hello",
  },
});

describe("receiveUpdate", () => {
  it("drops unauthorized requests before producing an event", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "wrong",
      body,
    });
    expect(result.status).toBe(401);
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain("hello");
  });

  it("returns an internal event for a valid secret", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.events[0]).toMatchObject({
      id: "tg_1",
      kind: "message",
      chatId: "-100",
      actor: { id: "3", isAdmin: false },
      message: { id: "8", text: "hello" },
    });
  });
});
