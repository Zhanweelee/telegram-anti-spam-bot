import { describe, expect, it } from "vitest";
import {
  foldBracketDots,
  foldCyrillicLookalikes,
  foldDotLookalikes,
  foldEncodedAlphabet,
  foldEncodedGaps,
  foldEncodedMiddleDot,
  foldEncodedSeparators,
  foldFullwidthLatin,
  foldHostInterrupters,
  foldHostScan,
  foldInterpuncts,
  foldMatchText,
} from "./text.js";

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

describe("foldInterpuncts", () => {
  it("drops dot lookalikes and keeps spaces, periods, and ascii dots", () => {
    expect(foldInterpuncts("免\u00B7费\u30FB领\uFF0E取")).toBe("免费领取");
    expect(foldInterpuncts("加\u2022微\u22C5信")).toBe("加微信");
    expect(foldInterpuncts("免 费领取")).toBe("免 费领取");
    expect(foldInterpuncts("不是免费。领取")).toBe("不是免费。领取");
    expect(foldInterpuncts("bit.ly")).toBe("bit.ly");
    expect(foldInterpuncts("t.me/\uFF0BCODE")).toBe("t.me/\uFF0BCODE");
  });
});

describe("foldDotLookalikes", () => {
  it("turns dot lookalikes into ascii dots", () => {
    expect(foldDotLookalikes("bit\u00B7ly")).toBe("bit.ly");
    expect(foldDotLookalikes("https://t\u30FBme/+CODE")).toBe(
      "https://t.me/+CODE",
    );
    expect(foldDotLookalikes("bit\uFF0Ely")).toBe("bit.ly");
    expect(foldDotLookalikes("example.com")).toBe("example.com");
    expect(foldDotLookalikes("不是免费。领取")).toBe("不是免费。领取");
    expect(foldDotLookalikes("免 费领取")).toBe("免 费领取");
  });
});

describe("foldHostScan", () => {
  it("uses the body host fold on a plain label", () => {
    expect(foldHostScan("bit\u200b.ly")).toBe("bit.ly");
    expect(foldHostScan("b%69t.ly")).toBe("bit.ly");
    expect(foldHostScan("t.me%2F+SIDE72")).toBe("t.me/+SIDE72");
    expect(foldHostScan("bit. ly")).toBe("bit. ly");
    expect(foldHostScan("bit%255B.%255Dly")).toBe("bit%255B.%255Dly");
  });
});

describe("foldBracketDots", () => {
  it("turns a bracketed dot into an ascii dot", () => {
    expect(foldBracketDots("bit[.]ly")).toBe("bit.ly");
    expect(foldBracketDots("t(.)me")).toBe("t.me");
    expect(foldBracketDots("t{.}me")).toBe("t.me");
    expect(foldBracketDots("bit\uFF3B.\uFF3Dly")).toBe("bit.ly");
    expect(foldBracketDots("bit[\u3002]ly")).toBe("bit.ly");
    expect(foldBracketDots("bit[ . ]ly")).toBe("bit[ . ]ly");
    expect(foldBracketDots("bit%5B.%5Dly")).toBe("bit.ly");
    expect(foldBracketDots("bit%5b.%5dly")).toBe("bit.ly");
    expect(foldBracketDots("t%28.%29me")).toBe("t.me");
    expect(foldBracketDots("t%7B%2E%7Dme")).toBe("t.me");
    expect(foldBracketDots("bit%255B.%255Dly")).toBe("bit%255B.%255Dly");
    expect(foldBracketDots("bit%5B%252E%5Dly")).toBe("bit%5B%252E%5Dly");
    expect(foldBracketDots("不是免费。领取")).toBe("不是免费。领取");
    expect(foldBracketDots("免 费领取")).toBe("免 费领取");
  });
});

describe("foldFullwidthLatin", () => {
  it("folds fullwidth letters and keeps digits and other characters", () => {
    expect(foldFullwidthLatin("\uFF42\uFF49\uFF54.\uFF4C\uFF59")).toBe(
      "bit.ly",
    );
    expect(foldFullwidthLatin("\uFF34.\uFF4D\uFF45")).toBe("T.me");
    expect(foldFullwidthLatin("\uFF12\uFF10\uFF13.0.113.9")).toBe(
      "\uFF12\uFF10\uFF13.0.113.9",
    );
    expect(foldFullwidthLatin("免费领取")).toBe("免费领取");
    expect(foldFullwidthLatin("免\uFF21费领取")).toBe("免A费领取");
    expect(foldFullwidthLatin("t.me/\uFF0BCODE")).toBe("t.me/\uFF0BCODE");
    expect(foldFullwidthLatin("不是免费。领取")).toBe("不是免费。领取");
  });
});

describe("foldCyrillicLookalikes", () => {
  it("folds cyrillic lookalikes and keeps the rest", () => {
    expect(foldCyrillicLookalikes("bit.l\u0443")).toBe("bit.ly");
    expect(foldCyrillicLookalikes("t.m\u0415")).toBe("t.mE");
    expect(
      foldCyrillicLookalikes("\u0430\u0435\u043E\u0440\u0441\u0443\u0445"),
    ).toBe("aeopcyx");
    expect(
      foldCyrillicLookalikes("\u0410\u0415\u041E\u0420\u0421\u0423\u0425"),
    ).toBe("AEOPCYX");
    expect(foldCyrillicLookalikes("привет")).toBe("пpивeт");
    expect(foldCyrillicLookalikes("ивт")).toBe("ивт");
    expect(foldCyrillicLookalikes("b\u0456t.ly")).toBe("bit.ly");
    expect(foldCyrillicLookalikes("b\u0406t.ly")).toBe("bIt.ly");
    expect(foldCyrillicLookalikes("\u0442.me")).toBe("\u0442.me");
    expect(foldCyrillicLookalikes("免费领取")).toBe("免费领取");
    expect(foldCyrillicLookalikes("t.me/\uFF0BCODE")).toBe("t.me/\uFF0BCODE");
  });
});

describe("foldHostInterrupters", () => {
  it("drops letters that split a label and keeps mapped latin", () => {
    expect(foldHostInterrupters("b\u0442it.ly")).toBe("bit.ly");
    expect(foldHostInterrupters("b\u03BFit.ly")).toBe("bit.ly");
    expect(foldHostInterrupters("b\u00E9it.ly")).toBe("bit.ly");
    expect(foldHostInterrupters("b\u0561it.ly")).toBe("bit.ly");
    expect(foldHostInterrupters("\u0561.me")).toBe(".me");
    expect(foldHostInterrupters("\u0442.me")).toBe(".me");
    expect(foldHostInterrupters("bit.ly")).toBe("bit.ly");
    expect(foldHostInterrupters("点击bit.ly")).toBe("点击bit.ly");
    expect(foldHostInterrupters("안녕bit.ly")).toBe("안녕bit.ly");
    expect(foldHostInterrupters("あbit.ly")).toBe("あbit.ly");
    expect(foldHostInterrupters("免费领取")).toBe("免费领取");
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
    expect(foldEncodedGaps("bit%C2%B7ly")).toBe("bit%C2%B7ly");
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

describe("foldEncodedMiddleDot", () => {
  it("turns one encoded middle dot into U+00B7", () => {
    expect(foldEncodedMiddleDot("bit%C2%B7ly")).toBe("bit\u00B7ly");
    expect(foldEncodedMiddleDot("bit%c2%b7ly")).toBe("bit\u00B7ly");
    expect(foldEncodedMiddleDot("bit%C2%b7ly")).toBe("bit\u00B7ly");
    expect(foldEncodedMiddleDot("bit%25C2%25B7ly")).toBe("bit%25C2%25B7ly");
    expect(foldEncodedMiddleDot("bit%E3%83%BBly")).toBe("bit\u30FBly");
    expect(foldEncodedMiddleDot("bit%e3%83%bbly")).toBe("bit\u30FBly");
    expect(foldEncodedMiddleDot("bit%E2%80%A2ly")).toBe("bit\u2022ly");
    expect(foldEncodedMiddleDot("bit%E2%80%A7ly")).toBe("bit\u2027ly");
    expect(foldEncodedMiddleDot("bit%E2%88%99ly")).toBe("bit\u2219ly");
    expect(foldEncodedMiddleDot("bit%E2%8B%85ly")).toBe("bit\u22C5ly");
    expect(foldEncodedMiddleDot("bit%EF%BC%8Ely")).toBe("bit\uFF0Ely");
    expect(foldEncodedMiddleDot("bit%EF%B9%92ly")).toBe("bit\uFE52ly");
    expect(foldEncodedMiddleDot("bit%EF%BD%A1ly")).toBe("bit\uFF61ly");
    expect(foldEncodedMiddleDot("bit%25E3%2583%25BBly")).toBe(
      "bit%25E3%2583%25BBly",
    );
    expect(foldEncodedMiddleDot("example%E3%80%82com")).toBe(
      "example%E3%80%82com",
    );
    expect(foldEncodedMiddleDot("免费领取")).toBe("免费领取");
    expect(foldEncodedMiddleDot("不是免费。领取")).toBe("不是免费。领取");
  });
});

describe("foldEncodedSeparators", () => {
  it("turns one encoded dot, slash, or plus into a separator", () => {
    expect(foldEncodedSeparators("bit%2Ely")).toBe("bit.ly");
    expect(foldEncodedSeparators("bit%2ely")).toBe("bit.ly");
    expect(foldEncodedSeparators("t.me%2F+CODE")).toBe("t.me/+CODE");
    expect(foldEncodedSeparators("t.me%2f+CODE")).toBe("t.me/+CODE");
    expect(foldEncodedSeparators("bit%252Ely")).toBe("bit%252Ely");
    expect(foldEncodedSeparators("t.me%252F+CODE")).toBe("t.me%252F+CODE");
    expect(foldEncodedSeparators("t.me%2Fdurov")).toBe("t.me/durov");
    expect(foldEncodedSeparators("t.me/%2BCODE")).toBe("t.me/+CODE");
    expect(foldEncodedSeparators("t.me/%2bCODE")).toBe("t.me/+CODE");
    expect(foldEncodedSeparators("t.me/%252BCODE")).toBe("t.me/%252BCODE");
    expect(foldMatchText("免%2B费领取")).toBe("免%2B费领取");
  });
});

describe("foldEncodedAlphabet", () => {
  it("turns one encoded letter, digit, hyphen, or underscore into itself", () => {
    expect(foldEncodedAlphabet("b%69t.ly")).toBe("bit.ly");
    expect(foldEncodedAlphabet("b%69T.LY")).toBe("biT.LY");
    expect(foldEncodedAlphabet("OFF%45R")).toBe("OFFER");
    expect(foldEncodedAlphabet("off%65r")).toBe("offer");
    expect(foldEncodedAlphabet("OFF%4eR")).toBe("OFFNR");
    expect(foldEncodedAlphabet("A%5F%2DB")).toBe("A_-B");
    expect(foldEncodedAlphabet("%39")).toBe("9");
    expect(foldEncodedAlphabet("%20")).toBe("%20");
    expect(foldEncodedAlphabet("%2E")).toBe("%2E");
    expect(foldEncodedAlphabet("%00")).toBe("%00");
    expect(foldMatchText("免%45费领取")).toBe("免%45费领取");
    expect(foldEncodedAlphabet("b%2569t.ly")).toBe("bit.ly");
    expect(foldEncodedAlphabet("OFF%2545R")).toBe("OFFER");
    expect(foldEncodedAlphabet("off%2565r")).toBe("offer");
    expect(foldEncodedAlphabet("A%255F%252DB")).toBe("A_-B");
    expect(foldEncodedAlphabet("%252E")).toBe("%252E");
    expect(foldEncodedAlphabet("%2520")).toBe("%2520");
    expect(foldEncodedAlphabet("%252F")).toBe("%252F");
    expect(foldEncodedAlphabet("OFF%252545R")).toBe("OFF%252545R");
    expect(foldEncodedAlphabet("b%252569t.ly")).toBe("b%252569t.ly");
    expect(foldMatchText("免%2545费领取")).toBe("免%2545费领取");
  });
});
