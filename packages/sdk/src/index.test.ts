import { describe, expect, it } from "vitest";
import { createMessageEvent, sha256Hex } from "./index.js";

describe("sdk", () => {
  it("hashes and builds a valid message event", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const event = createMessageEvent({
      text: "hello",
      isAdmin: true,
      tenantId: "t",
      chatId: "c",
    });
    expect(event.actor.isAdmin).toBe(true);
    expect(event.message?.textSha256).toBe(sha256Hex("hello"));
  });
});
