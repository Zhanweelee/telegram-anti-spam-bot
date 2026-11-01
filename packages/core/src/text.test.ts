import { describe, expect, it } from "vitest";
import { foldEncodedGaps, foldMatchText } from "./text.js";

describe("foldMatchText", () => {
  it("drops format characters and keeps spaces and words", () => {
    const folded = foldMatchText("免\u200b费\u200d领\ufeff取\u202e");
    expect(folded).toBe("免费领取");
    expect(folded).not.toContain("\u200b");
    expect(foldMatchText("免 费领取")).toBe("免 费领取");
    expect(foldMatchText("加\u00ad微\u180e信")).toBe("加微信");
  });

  it("drops unicode spaces and line breaks while keeping a normal space", () => {
    expect(foldMatchText("免\u00a0费\u3000领取")).toBe("免费领取");
    expect(foldMatchText("免\n费\t领取")).toBe("免费领取");
    expect(foldMatchText("加\u2000微\u202f信")).toBe("加微信");
    expect(foldMatchText("免 费领取")).toBe("免 费领取");
  });

  it("drops variation selectors and keeps a normal space", () => {
    expect(foldMatchText("免\uFE0F费\uFE00领取")).toBe("免费领取");
    expect(foldMatchText("加\u180B微信")).toBe("加微信");
    expect(foldMatchText("加\u{E0100}微信")).toBe("加微信");
    expect(foldMatchText("免 费领取")).toBe("免 费领取");
  });
});

describe("foldEncodedGaps", () => {
  it("drops percent-encoded gaps and keeps an ordinary space", () => {
    expect(foldEncodedGaps("IN%E2%80%8BVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%e2%80%8bVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%EF%B8%8FVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%C2%A0VITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%0AVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%E1%A0%8BVITE")).toBe("INVITE");
    expect(foldEncodedGaps("a%F3%A0%84%80b")).toBe("ab");
    expect(foldEncodedGaps("IN%20VITE")).toBe("IN%20VITE");
    expect(foldEncodedGaps("bit%2Ely")).toBe("bit%2Ely");
    expect(foldEncodedGaps("%00%7F")).toBe("%00%7F");
    expect(foldEncodedGaps("%25E2%2580%258B")).toBe("");
    expect(foldEncodedGaps("IN%25E2%2580%258BVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%25e2%2580%258bVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%25EF%25B8%258FVITE")).toBe("INVITE");
    expect(foldEncodedGaps("IN%250AVITE")).toBe("INVITE");
    expect(foldEncodedGaps("%252E")).toBe("%252E");
    expect(foldEncodedGaps("%2520")).toBe("%2520");
    expect(foldEncodedGaps("%252F")).toBe("%252F");
    expect(foldEncodedGaps("%2525E2%252580%25258B")).toBe(
      "%2525E2%252580%25258B",
    );
    expect(foldEncodedGaps("IN%E2%80")).toBe("IN%E2%80");
    expect(foldEncodedGaps("%C0%80")).toBe("%C0%80");
    expect(foldEncodedGaps("%ED%A0%80")).toBe("%ED%A0%80");
    expect(foldEncodedGaps("%F0%80%80%80")).toBe("%F0%80%80%80");
    expect(foldEncodedGaps("%F4%90%80%80")).toBe("%F4%90%80%80");
    expect(foldEncodedGaps("%")).toBe("%");
    expect(foldEncodedGaps("%ZZ")).toBe("%ZZ");
    expect(foldEncodedGaps("免费领取")).toBe("免费领取");
    expect(foldMatchText("免%E2%80%8B费领取")).toBe("免%E2%80%8B费领取");
    expect(foldEncodedGaps("IN%E2%80%8BVITE")).not.toContain("\u200b");
  });
});
