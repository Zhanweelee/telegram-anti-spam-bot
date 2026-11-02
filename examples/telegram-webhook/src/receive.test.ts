import { sha256Hex } from "@tasb/platform-telegram";
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

  it("keeps an owner change name and drops the sender name", async () => {
    const visible = "https://bit.ly/name87";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 6,
        message: {
          message_id: 60,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp87" },
          from: { id: 89, first_name: "https://tinyurl.com/from87" },
          chat_owner_changed: {
            new_owner: { id: 89001, first_name: visible, language_code: "zh" },
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_6",
      kind: "message",
      message: { id: "60", text: visible },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("from87");
    expect(dumped).not.toContain("grp87");
    expect(dumped).not.toContain("89001");
  });

  it("keeps a proximity alert name and drops the distance", async () => {
    const visible = "https://bit.ly/name88";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 7,
        message: {
          message_id: 70,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp88" },
          from: { id: 90, first_name: "https://tinyurl.com/from88" },
          proximity_alert_triggered: {
            traveler: { id: 90001, first_name: visible, language_code: "zh" },
            watcher: { id: 90002, first_name: "Ada" },
            distance: 90909,
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_7",
      kind: "message",
      message: { id: "70", text: `${visible} Ada` },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("from88");
    expect(dumped).not.toContain("grp88");
    expect(dumped).not.toContain("90001");
    expect(dumped).not.toContain("90002");
    expect(dumped).not.toContain("90909");
  });

  it("keeps a hostname from a mathematical expression and drops the source", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 8,
        message: {
          message_id: 80,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp91" },
          from: { id: 91, first_name: "https://tinyurl.com/from91" },
          rich_message: {
            blocks: [
              {
                type: "mathematical_expression",
                expression: "LATEXSECRET91 https://bit.ly/name91",
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_8",
      kind: "message",
      message: { id: "80", text: "", hosts: ["bit.ly"] },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("LATEXSECRET91");
    expect(dumped).not.toContain("name91");
    expect(dumped).not.toContain("from91");
    expect(dumped).not.toContain("grp91");
  });

  it("hashes a caption-less rich photo and leaves the file id out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 9,
        message: {
          message_id: 90,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp92" },
          from: { id: 92, first_name: "https://tinyurl.com/from92" },
          rich_message: {
            blocks: [
              {
                type: "photo",
                photo: [
                  {
                    file_id: "SECRETFILE92",
                    file_unique_id: "RICHPHOTO92",
                    width: 1,
                    height: 1,
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_9",
      kind: "message",
      message: {
        id: "90",
        text: "",
        media: "photo",
        mediaSha256: await sha256Hex("photo\nRICHPHOTO92"),
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRETFILE92");
    expect(dumped).not.toContain("RICHPHOTO92");
    expect(dumped).not.toContain("from92");
    expect(dumped).not.toContain("grp92");
  });

  it("hashes a caption-less paid photo and leaves the file id out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 10,
        message: {
          message_id: 100,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp93" },
          from: { id: 93, first_name: "https://tinyurl.com/from93" },
          paid_media: {
            star_count: 93093,
            paid_media: [
              {
                type: "photo",
                photo: [
                  {
                    file_id: "SECRETFILE93",
                    file_unique_id: "PAIDPHOTO93",
                    width: 1,
                    height: 1,
                  },
                ],
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_10",
      kind: "message",
      message: {
        id: "100",
        text: "",
        media: "photo",
        mediaSha256: await sha256Hex("photo\nPAIDPHOTO93"),
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRETFILE93");
    expect(dumped).not.toContain("PAIDPHOTO93");
    expect(dumped).not.toContain("from93");
    expect(dumped).not.toContain("grp93");
    expect(dumped).not.toContain("93093");
  });

  it("keeps an ephemeral message id and the receiver id", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 11,
        message: {
          message_id: 0,
          ephemeral_message_id: 63101,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp94" },
          from: { id: 94, first_name: "https://tinyurl.com/from94" },
          receiver_user: { id: 940, first_name: "recv94" },
          text: "今天站会",
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_11",
      kind: "message",
      message: { id: "63101", text: "今天站会", audienceId: "940" },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("from94");
    expect(dumped).not.toContain("recv94");
    expect(dumped).not.toContain("grp94");
    expect(result.events[0]?.message?.id).not.toBe("0");
  });

  it("keeps a custom emoji alternative and leaves the emoji id out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 12,
        message: {
          message_id: 120,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp95" },
          from: { id: 95, first_name: "https://tinyurl.com/from95" },
          rich_message: {
            blocks: [
              {
                type: "paragraph",
                text: {
                  type: "custom_emoji",
                  custom_emoji_id: "SECRETEMOJI95",
                  alternative_text: "https://bit.ly/name95",
                },
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_12",
      kind: "message",
      message: {
        id: "120",
        text: "https://bit.ly/name95",
        hosts: ["bit.ly"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRETEMOJI95");
    expect(dumped).not.toContain("from95");
    expect(dumped).not.toContain("grp95");
  });

  it("keeps a hostname from a code block language and leaves the label out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 13,
        message: {
          message_id: 130,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp96" },
          from: { id: 96, first_name: "https://tinyurl.com/from96" },
          rich_message: {
            blocks: [
              {
                type: "pre",
                language: "https://bit.ly/name96",
                text: "今天站会",
              },
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_13",
      kind: "message",
      message: { id: "130", text: "今天站会", hosts: ["bit.ly"] },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name96");
    expect(dumped).not.toContain("from96");
    expect(dumped).not.toContain("grp96");
  });

  it("keeps a hostname from a code entity language and leaves the label out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 14,
        message: {
          message_id: 140,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp97" },
          from: { id: 97, first_name: "https://tinyurl.com/from97" },
          text: "今天站会",
          entities: [
            {
              type: "pre",
              offset: 0,
              length: 4,
              language: "https://bit.ly/name97",
            },
          ],
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_14",
      kind: "message",
      message: { id: "140", text: "今天站会", hosts: ["bit.ly"] },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name97");
    expect(dumped).not.toContain("from97");
    expect(dumped).not.toContain("grp97");
  });

  it("keeps a proxy server hostname and leaves the secret out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 15,
        message: {
          message_id: 150,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp98" },
          from: { id: 98, first_name: "https://tinyurl.com/from98" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "代理",
                  url: "https://t.me/proxy?server=203.0.113.9&port=4444&secret=SECRET98",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_15",
      kind: "message",
      message: {
        id: "150",
        text: "今天站会",
        hosts: ["t.me", "203.0.113.9"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRET98");
    expect(dumped).not.toContain("4444");
    expect(dumped).not.toContain("from98");
    expect(dumped).not.toContain("grp98");
  });

  it("keeps a hostname from a telegram share link and leaves the path out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 16,
        message: {
          message_id: 160,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp99" },
          from: { id: 99, first_name: "https://tinyurl.com/from99" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "分享",
                  url: "https://t.me/share/url?url=https%3A%2F%2Fbit.ly%2Fname99&text=hello",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_16",
      kind: "message",
      message: {
        id: "160",
        text: "今天站会",
        hosts: ["t.me", "bit.ly"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name99");
    expect(dumped).not.toContain("from99");
    expect(dumped).not.toContain("grp99");
  });

  it("keeps a hostname from a telegram msg link and leaves the path out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 17,
        message: {
          message_id: 170,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp100" },
          from: { id: 100, first_name: "https://tinyurl.com/from100" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "私聊",
                  url: "tg://msg?text=https%3A%2F%2F203.0.113.9%2Fpath100&to=durov",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_17",
      kind: "message",
      message: {
        id: "170",
        text: "今天站会",
        hosts: ["203.0.113.9"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("path100");
    expect(dumped).not.toContain("durov");
    expect(dumped).not.toContain("from100");
    expect(dumped).not.toContain("grp100");
  });

  it("keeps a hostname from a giveaway chat title and leaves the name out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 18,
        message: {
          message_id: 180,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp101" },
          from: { id: 101, first_name: "https://tinyurl.com/from101" },
          text: "今天站会",
          giveaway: {
            chats: [
              {
                id: -100101,
                type: "channel",
                title: "https://bit.ly/name101",
                username: "news101",
              },
            ],
            winners_selection_date: 1762000000,
            winner_count: 1,
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_18",
      kind: "message",
      message: {
        id: "180",
        text: "今天站会",
        hosts: ["bit.ly"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name101");
    expect(dumped).not.toContain("news101");
    expect(dumped).not.toContain("from101");
    expect(dumped).not.toContain("grp101");
  });

  it("keeps a hostname from the other telegram share links and leaves the path out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 19,
        message: {
          message_id: 190,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp102" },
          from: { id: 102, first_name: "https://tinyurl.com/from102" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "分享",
                  url: "https://t.me/share?url=https%3A%2F%2Fbit.ly%2Fname102&text=hello",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_19",
      kind: "message",
      message: {
        id: "190",
        text: "今天站会",
        hosts: ["t.me", "bit.ly"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name102");
    expect(dumped).not.toContain("from102");
    expect(dumped).not.toContain("grp102");
  });

  it("keeps a hostname from a telegram web proxy link and leaves the secret out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 20,
        message: {
          message_id: 200,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp103" },
          from: { id: 103, first_name: "https://tinyurl.com/from103" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "网页代理",
                  url: "https://t.me/webproxy?server=203.0.113.9&secret=SECRET103",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_20",
      kind: "message",
      message: {
        id: "200",
        text: "今天站会",
        hosts: ["t.me", "203.0.113.9"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRET103");
    expect(dumped).not.toContain("from103");
    expect(dumped).not.toContain("grp103");
  });

  it("keeps a hostname from the host alias on a telegram proxy link and leaves the secret out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 21,
        message: {
          message_id: 210,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp104" },
          from: { id: 104, first_name: "https://tinyurl.com/from104" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "代理",
                  url: "https://t.me/proxy?host=203.0.113.9&port=443&secret=SECRET104",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_21",
      kind: "message",
      message: {
        id: "210",
        text: "今天站会",
        hosts: ["t.me", "203.0.113.9"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRET104");
    expect(dumped).not.toContain("from104");
    expect(dumped).not.toContain("grp104");
  });

  it("keeps a hostname when a web proxy server is empty and leaves the secret out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 22,
        message: {
          message_id: 220,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp105" },
          from: { id: 105, first_name: "https://tinyurl.com/from105" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "网页代理",
                  url: "https://t.me/webproxy?server=&host=203.0.113.9&secret=SECRET105",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_22",
      kind: "message",
      message: {
        id: "220",
        text: "今天站会",
        hosts: ["t.me", "203.0.113.9"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("SECRET105");
    expect(dumped).not.toContain("from105");
    expect(dumped).not.toContain("grp105");
  });

  it("keeps a hostname from a username draft and leaves the path out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 23,
        message: {
          message_id: 230,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp106" },
          from: { id: 106, first_name: "https://tinyurl.com/from106" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "主页",
                  url: "https://t.me/durov?text=https%3A%2F%2F203.0.113.9%2Fpath106",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_23",
      kind: "message",
      message: {
        id: "230",
        text: "今天站会",
        hosts: ["t.me", "203.0.113.9"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("path106");
    expect(dumped).not.toContain("from106");
    expect(dumped).not.toContain("grp106");
  });

  it("keeps a hostname from a phone draft and leaves the number out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 24,
        message: {
          message_id: 240,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp107" },
          from: { id: 107, first_name: "https://tinyurl.com/from107" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "电话",
                  url: "https://t.me/+79990001107?text=https%3A%2F%2Fbit.ly%2Fname107",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_24",
      kind: "message",
      message: {
        id: "240",
        text: "今天站会",
        hosts: ["t.me", "bit.ly"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("name107");
    expect(dumped).not.toContain("79990001107");
    expect(dumped).not.toContain("from107");
    expect(dumped).not.toContain("grp107");
  });

  it("keeps a hostname from a t.me subdomain draft and leaves the path out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 25,
        message: {
          message_id: 250,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp108" },
          from: { id: 108, first_name: "https://tinyurl.com/from108" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "主页",
                  url: "https://durov.t.me/?text=https%3A%2F%2F203.0.113.8%2Fpath108",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_25",
      kind: "message",
      message: {
        id: "250",
        text: "今天站会",
        hosts: ["durov.t.me", "203.0.113.8"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("path108");
    expect(dumped).not.toContain("from108");
    expect(dumped).not.toContain("grp108");
  });

  it("keeps a hostname from a capitalized telegram query and leaves the secret out", async () => {
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 26,
        message: {
          message_id: 260,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp109" },
          from: { id: 109, first_name: "https://tinyurl.com/from109" },
          text: "今天站会",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "代理",
                  url: "https://t.me/proxy?SERVER=203.0.113.109&secret=sek109",
                },
              ],
            ],
          },
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_26",
      kind: "message",
      message: {
        id: "260",
        text: "今天站会",
        hosts: ["t.me", "203.0.113.109"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain("sek109");
    expect(dumped).not.toContain("from109");
    expect(dumped).not.toContain("grp109");
  });

  it("keeps a hostname from an android folder invite and leaves the code out", async () => {
    const code = "FOLDER108";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 78012,
        message: {
          message_id: 78012,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp108" },
          from: { id: 108, first_name: "https://tinyurl.com/from108" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://telegram.dog/folder/${code}`,
            },
          ],
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_78012",
      kind: "message",
      message: {
        id: "78012",
        text: "点这里",
        hosts: ["telegram.dog"],
        invites: ["telegram.dog"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("from108");
    expect(dumped).not.toContain("grp108");
  });

  it("keeps a hostname from an android prefix invite and leaves the code out", async () => {
    const code = "PREFIX109";
    const result = await receiveUpdate({
      secret: "dev-secret",
      header: "dev-secret",
      body: JSON.stringify({
        update_id: 78017,
        message: {
          message_id: 78017,
          date: 1761955200,
          chat: { id: -100, title: "https://cutt.ly/grp109" },
          from: { id: 109, first_name: "https://tinyurl.com/from109" },
          text: "点这里",
          entities: [
            {
              type: "text_link",
              offset: 0,
              length: 3,
              url: `https://addlist.t.me/${code}/`,
            },
          ],
        },
      }),
    });
    expect(result.status).toBe(200);
    expect(result.events[0]).toMatchObject({
      id: "tg_78017",
      kind: "message",
      message: {
        id: "78017",
        text: "点这里",
        hosts: ["addlist.t.me"],
        invites: ["addlist.t.me"],
      },
    });
    const dumped = JSON.stringify(result.events[0]);
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("from109");
    expect(dumped).not.toContain("grp109");
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
