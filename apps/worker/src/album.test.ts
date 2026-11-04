import { describe, expect, it } from "vitest";
import { createAlbumWatch } from "./album.js";

const phrase = "请免费领取礼品";

describe("createAlbumWatch", () => {
  it("stores ten numeric ids and ignores the rest of that album", () => {
    const watch = createAlbumWatch();
    const key = {
      tenantId: "local",
      chatId: "-100",
      albumId: "12532140322504850",
    };
    for (let index = 1; index <= 10; index += 1) {
      watch.note({ ...key, messageId: String(index) });
    }
    const full = watch.note({ ...key, messageId: "11" });
    expect(full.map((slot) => slot.messageId)).toEqual(
      Array.from({ length: 10 }, (_, index) => String(index + 1)),
    );
    const again = watch.note({ ...key, messageId: "1", paid: true });
    expect(again).toHaveLength(10);
    expect(again[0]).toEqual({ messageId: "1" });
  });

  it("stops tracking new albums after 256 and keeps the first", () => {
    const watch = createAlbumWatch();
    for (let index = 1; index <= 256; index += 1) {
      watch.note({
        tenantId: "local",
        chatId: "-100",
        albumId: String(index),
        messageId: "1",
      });
    }
    expect(
      watch.note({
        tenantId: "local",
        chatId: "-100",
        albumId: "257",
        messageId: "1",
      }),
    ).toEqual([]);
    watch.condemn({ tenantId: "local", chatId: "-100", albumId: "257" });
    expect(
      watch.condemned({ tenantId: "local", chatId: "-100", albumId: "257" }),
    ).toBe(false);
    const first = watch.note({
      tenantId: "local",
      chatId: "-100",
      albumId: "1",
      messageId: "2",
    });
    expect(first.map((slot) => slot.messageId)).toEqual(["1", "2"]);
  });

  it("rejects ids that could carry a caption", () => {
    const watch = createAlbumWatch();
    expect(
      watch.note({
        tenantId: "local",
        chatId: "-100",
        albumId: phrase,
        messageId: "1",
      }),
    ).toEqual([]);
    expect(
      watch.note({
        tenantId: "local",
        chatId: "-100",
        albumId: "12532140322504850",
        messageId: phrase,
      }),
    ).toEqual([]);
    expect(
      watch.note({
        tenantId: "local",
        chatId: "-100",
        albumId: "12532140322504850",
        messageId: "0",
      }),
    ).toEqual([]);
    const kept = watch.note({
      tenantId: "local",
      chatId: "-100",
      albumId: "12532140322504850",
      messageId: "9".repeat(20),
      audienceId: "7",
    });
    expect(kept).toEqual([{ messageId: "9".repeat(20), audienceId: "7" }]);
    expect(JSON.stringify(kept)).not.toContain(phrase);
  });

  it("condemns one album without marking another chat", () => {
    const watch = createAlbumWatch();
    const albumId = "12532140322504850";
    watch.note({
      tenantId: "local",
      chatId: "-100",
      albumId,
      messageId: "11",
    });
    watch.note({
      tenantId: "other",
      chatId: "-100",
      albumId,
      messageId: "12",
    });
    watch.condemn({ tenantId: "local", chatId: "-100", albumId });
    watch.markRemoved({
      tenantId: "local",
      chatId: "-100",
      albumId,
      messageId: "11",
    });
    expect(
      watch.condemned({ tenantId: "local", chatId: "-100", albumId }),
    ).toBe(true);
    expect(
      watch.condemned({ tenantId: "other", chatId: "-100", albumId }),
    ).toBe(false);
    expect(
      watch.note({
        tenantId: "local",
        chatId: "-100",
        albumId,
        messageId: "11",
      }),
    ).toEqual([{ messageId: "11", removed: true }]);
    expect(
      watch.note({
        tenantId: "other",
        chatId: "-100",
        albumId,
        messageId: "12",
      }),
    ).toEqual([{ messageId: "12" }]);
  });
});
