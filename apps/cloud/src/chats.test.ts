import { describe, expect, it } from "vitest";
import { createMemoryChatDirectory } from "./chats.js";

describe("createMemoryChatDirectory", () => {
  it("remembers the person who made the bot an admin", async () => {
    const directory = createMemoryChatDirectory();
    expect(
      await directory.noteBot({
        tenantId: "local",
        chatId: "-100",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("ok");
    expect(await directory.chatsFor("local", "7")).toEqual(["-100"]);
    expect(await directory.list("local")).toEqual(["-100"]);
    expect(await directory.chatsFor("other", "7")).toEqual([]);
    await directory.noteMember({
      tenantId: "local",
      chatId: "-100",
      actorId: "8",
      admin: true,
    });
    expect(await directory.chatsFor("local", "8")).toEqual(["-100"]);
    await directory.noteMember({
      tenantId: "local",
      chatId: "-100",
      actorId: "8",
      admin: false,
    });
    expect(await directory.chatsFor("local", "8")).toEqual([]);
    expect(await directory.list("local")).toEqual(["-100"]);
    await directory.noteBot({
      tenantId: "local",
      chatId: "-100",
      actorId: "7",
      state: "gone",
    });
    expect(await directory.list("local")).toEqual([]);
    expect(await directory.chatsFor("local", "7")).toEqual([]);
  });

  it("stops accepting new chats when the map is full", async () => {
    const directory = createMemoryChatDirectory({ maxChats: 1 });
    expect(
      await directory.noteBot({
        tenantId: "local",
        chatId: "-100",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("ok");
    expect(
      await directory.noteBot({
        tenantId: "local",
        chatId: "-200",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("full");
    expect(await directory.list("local")).toEqual(["-100"]);
    expect(
      await directory.noteBot({
        tenantId: "local\nextra",
        chatId: "-100",
        actorId: "7",
        state: "admin",
      }),
    ).toBe("ok");
    expect(await directory.list("local")).toEqual(["-100"]);
  });
});
