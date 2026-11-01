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

  it("turns a chat_member update into a join event without a message", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 2,
        chat_member: {
          chat: { id: -100 },
          from: { id: 1, first_name: "Admin" },
          date: 1761955200,
          new_chat_member: {
            user: { id: 77, first_name: "Newbie" },
            status: "member",
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_2",
      kind: "chat_member",
      actor: { id: "77", isAdmin: false },
    });
    expect(result.events[0]?.message).toBeUndefined();
    expect(result.events[0]?.profile?.text).toBe("Newbie");
    expect(JSON.stringify(result.events[0]?.actor)).not.toContain("Newbie");
  });

  it("keeps a join request bio and drops the invite link", async () => {
    const bio = "https://bit.ly/bio83";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 3,
        chat_join_request: {
          chat: { id: -100, title: "https://cutt.ly/grp83" },
          from: { id: 83, first_name: "https://tinyurl.com/name83" },
          date: 1761955200,
          bio,
          invite_link: { invite_link: "https://t.me/+JOIN83" },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_3",
      kind: "join_request",
      actor: { id: "83", isAdmin: false },
      profile: { text: bio },
    });
    expect(result.events[0]?.message).toBeUndefined();
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name83");
    expect(dumped).not.toContain("JOIN83");
    expect(dumped).not.toContain("grp83");
  });

  it("keeps a join service message name and drops the sender name", async () => {
    const visible = "https://bit.ly/name85";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 4,
        message: {
          message_id: 40,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp85" },
          from: { id: 87, first_name: "https://tinyurl.com/from85" },
          new_chat_members: [
            { id: 87001, first_name: visible, language_code: "zh" },
          ],
          left_chat_member: { id: 87004, first_name: "https://bit.ly/left85" },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_4",
      kind: "message",
      message: { id: "40", text: visible },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("from85");
    expect(dumped).not.toContain("left85");
    expect(dumped).not.toContain("grp85");
    expect(dumped).not.toContain("87001");
    expect(dumped).not.toContain("87004");
  });

  it("keeps a video chat invite name and drops the sender name", async () => {
    const visible = "https://bit.ly/name86";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 5,
        message: {
          message_id: 50,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp86" },
          from: { id: 88, first_name: "https://tinyurl.com/from86" },
          video_chat_participants_invited: {
            users: [{ id: 88001, first_name: visible, language_code: "zh" }],
          },
          video_chat_ended: { duration: 86 },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_5",
      kind: "message",
      message: { id: "50", text: visible },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("from86");
    expect(dumped).not.toContain("grp86");
    expect(dumped).not.toContain("88001");
    expect(dumped).not.toContain("duration");
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
