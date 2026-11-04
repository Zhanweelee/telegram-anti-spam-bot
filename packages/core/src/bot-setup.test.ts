import { describe, expect, it } from "vitest";
import { botSetupNotice } from "./bot-setup.js";
import { parseEvent } from "./event.js";

function membership(
  extra: Record<string, unknown>,
  ids?: { readonly chatId?: string; readonly actorId?: string },
) {
  return parseEvent({
    id: "evt_bot",
    tenantId: "local",
    chatId: ids?.chatId ?? "-100586",
    kind: "bot_membership",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: ids?.actorId ?? "7", isAdmin: false },
    ...extra,
  });
}

describe("botSetupNotice", () => {
  it("stays quiet unless the bot is in the chat and cannot moderate", () => {
    const message = parseEvent({
      id: "evt_msg",
      tenantId: "local",
      chatId: "-100586",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "7", isAdmin: false },
      message: {
        id: "1",
        text: "今天站会",
        textSha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    });
    expect(botSetupNotice(message)).toBeNull();
    expect(botSetupNotice(membership({}))).toBeNull();
    expect(botSetupNotice(membership({ bot: "admin" }))).toBeNull();
    expect(
      botSetupNotice(
        membership({ bot: "admin", botDelete: "on", botRestrict: "on" }),
      ),
    ).toBeNull();
    expect(botSetupNotice(membership({ bot: "gone" }))).toBeNull();
    expect(
      botSetupNotice(
        membership({ bot: "gone", botSeat: "in" }, { chatId: "room" }),
      ),
    ).toBeNull();
    expect(
      botSetupNotice(
        membership({ bot: "gone", botSeat: "in" }, { actorId: "owner" }),
      ),
    ).toBeNull();
  });

  it("tells the actor which right is missing", () => {
    expect(
      botSetupNotice(
        membership({ bot: "admin", botDelete: "off", botRestrict: "on" }),
      ),
    ).toEqual({
      tenantId: "local",
      chatId: "7",
      text: "机器人在 -100586 还不能删除。私聊 /cani -100586。",
    });
    expect(
      botSetupNotice(
        membership({ bot: "admin", botDelete: "on", botRestrict: "off" }),
        "en",
      ),
    ).toEqual({
      tenantId: "local",
      chatId: "7",
      text: "The bot in -100586 cannot restrict members. Private /cani -100586.",
    });
    expect(
      botSetupNotice(
        membership({ bot: "admin", botDelete: "off", botRestrict: "off" }),
      ),
    ).toEqual({
      tenantId: "local",
      chatId: "7",
      text: "机器人在 -100586 还不能删除，还不能限制。私聊 /cani -100586。",
    });
    expect(
      botSetupNotice(membership({ bot: "gone", botSeat: "in" }), "fr"),
    ).toEqual({
      tenantId: "local",
      chatId: "7",
      text: "机器人在 -100586，还不是管理员。私聊 /cani -100586。",
    });
    expect(
      botSetupNotice(membership({ bot: "gone", botSeat: "in" }), "en")?.text,
    ).toBe("The bot is in -100586 and is not an admin. Private /cani -100586.");
    expect(() =>
      parseEvent({
        id: "evt_bot",
        tenantId: "local",
        chatId: "-100586",
        kind: "bot_membership",
        occurredAt: "2026-11-01T00:00:00.000Z",
        actor: { id: "7", isAdmin: false },
        bot: "admin",
        botDelete: "off",
      }),
    ).toThrow();
  });
});
