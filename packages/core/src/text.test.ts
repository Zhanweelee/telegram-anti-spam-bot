import { describe, expect, it } from "vitest";
import {
  androidUrlSpan,
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
  foldHostScanKeepingGaps,
  foldHostScanKeepingStops,
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
    expect(foldHostScan("http://bit.ly\tevil.com")).toBe(
      "http://bit.lyevil.com",
    );
    expect(foldHostScan("http://bit.ly%0Aevil.com")).toBe(
      "http://bit.lyevil.com",
    );
  });

  it("keeps a gap that ends an Android link", () => {
    expect(foldHostScanKeepingGaps("http://bit.ly\tevil.com")).toBe(
      "http://bit.ly\tevil.com",
    );
    expect(foldHostScanKeepingGaps("http://bit.ly%0Aevil.com")).toBe(
      "http://bit.ly%0Aevil.com",
    );
    expect(foldHostScanKeepingGaps("bit\u200b.ly")).toBe("bit\u200b.ly");
    expect(foldHostScanKeepingGaps("b%69t.ly")).toBe("bit.ly");
    expect(foldHostScanKeepingGaps("bit. ly")).toBe("bit. ly");
  });

  it("keeps a percent encoding that ends an Android link", () => {
    expect(foldHostScanKeepingStops("http://bit.ly%2Eevil.com")).toBe(
      "http://bit.ly%2Eevil.com",
    );
    expect(foldHostScanKeepingStops("http://bit.ly%65vil.com")).toBe(
      "http://bit.ly%65vil.com",
    );
    expect(foldHostScanKeepingStops("http://bit.ly[.]evil.com")).toBe(
      "http://bit.ly[.]evil.com",
    );
    expect(foldHostScanKeepingStops("http://bit.ly\tevil.com")).toBe(
      "http://bit.ly\tevil.com",
    );
    expect(foldHostScanKeepingStops("b\u0456t.ly")).toBe("bit.ly");
    expect(foldHostScanKeepingStops("example.com\u0410http://bit.ly")).toBe(
      "example.com\u0410http://bit.ly",
    );
    expect(foldHostScanKeepingStops("example.com\uFF21http://bit.ly")).toBe(
      "example.com\uFF21http://bit.ly",
    );
    expect(foldHostScan("example.com\u0410http://bit.ly")).toBe(
      "example.comAhttp://bit.ly",
    );
    expect(foldHostScanKeepingStops("b\u0410it.ly")).toBe("bAit.ly");
    expect(foldHostScan("b%69t.ly")).toBe("bit.ly");
    expect(foldHostScan("bit[.]ly")).toBe("bit.ly");
    expect(foldHostScan("example.com%2Ehttp://bit.ly")).not.toContain(
      ".http://",
    );
    expect(foldHostScan("example.com%2E\nhttp://bit.ly")).toContain(".http://");
    expect(foldHostScan("bit%2Ely")).toBe("bit.ly");
    expect(foldHostScan("example.com%2Bhttp://bit.ly")).not.toContain(
      "+http://",
    );
    expect(foldHostScan("example.com%2B\nhttp://bit.ly")).toContain("+http://");
    expect(foldHostScan("t.me/%2BCODE")).toBe("t.me/+CODE");
    expect(foldHostScan("%2Bbit.ly")).toBe("!bit.arpa");
    expect(foldHostScan("example.com%2Bwww.bit.ly")).toBe(
      "example.com!www.bit.arpa",
    );
    expect(foldHostScan("%2B203.0.113.10")).toBe("!0.arpa");
    expect(foldHostScan("%2Bexample.com/bit.ly")).toBe("!example.arpa/bit.ly");
    expect(foldHostScan("example.com%2B\nbit.ly")).toBe("example.com+bit.ly");
    expect(foldHostScan("t.me%2F%2BCODE")).toBe("t.me/+CODE");
    expect(foldEncodedSeparators("%2Bbit.ly")).toBe("+bit.ly");
    expect(foldHostScan("example.com%2Dhttp://bit.ly")).not.toContain(
      "-http://",
    );
    expect(foldHostScan("example.com%252Dhttp://bit.ly")).not.toContain(
      "-http://",
    );
    expect(foldHostScan("example.com%2D\nhttp://bit.ly")).toContain("-http://");
    expect(foldHostScan("example.com%252D\nhttp://bit.ly")).toContain(
      "-http://",
    );
    expect(foldHostScan("bit%2Dly")).toBe("bit-ly");
    expect(foldHostScan("%2Dbit.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%252Dbit.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%2D203.0.113.10")).toBe("!0.arpa");
    expect(foldHostScan("example.com%2D\nbit.ly")).toBe("example.com-bit.ly");
    expect(foldHostScan("example.com%2D/bit.ly")).toBe("example.com-/bit.ly");
    expect(foldEncodedAlphabet("%2Dbit.ly")).toBe("-bit.ly");
    expect(foldEncodedAlphabet("example.com%2Dhttp://bit.ly")).toContain(
      "-http://",
    );
    expect(foldHostScan("%68ttp://bit.ly")).not.toContain("http://");
    expect(foldHostScan("ht%74p://bit.ly")).not.toContain("http://");
    expect(foldHostScan("ht%74\np://bit.ly")).not.toContain("http://");
    expect(foldHostScan("http://b%69t.ly")).toBe("http://bit.ly");
    expect(foldHostScan("b%69t.ly")).toBe("bit.ly");
    expect(foldHostScan("http://bit.ly")).toBe("http://bit.ly");
    expect(foldEncodedAlphabet("%68ttp://bit.ly")).toContain("http://");
    expect(foldHostScan("%2Fhttp://bit.ly")).toBe("!xhttp://bit.ly");
    expect(foldHostScan("http:%2F%2Fbit.ly")).toBe("!xbit.ly");
    expect(foldHostScan("http%3A%2F%2Fbit.ly")).toBe("!xbit.ly");
    expect(foldHostScan("http%253A%2F%2Fbit.ly")).toBe("!xbit.ly");
    expect(foldHostScan("t.me%2F+CODE")).toBe("t.me/+CODE");
    expect(foldHostScan("https://bit.ly%2Fname")).toBe("https://bit.ly/name");
    expect(foldEncodedSeparators("%2Fhttp://bit.ly")).toBe("/http://bit.ly");
    expect(foldHostScan("%2Fbit.ly")).toBe("!bit.arpa");
    expect(foldHostScan("see%2Fbit.ly")).toBe("see!bit.arpa");
    expect(foldHostScan("%2F203.0.113.10")).toBe("!0.arpa");
    expect(foldHostScan("%2Fexample.com/bit.ly")).toBe("!example.arpa/bit.ly");
    expect(foldHostScan("example.com%2F bit.ly")).toBe("example.com/ bit.ly");
    expect(foldHostScan("t.me%2F+CODE")).toBe("t.me/+CODE");
    expect(foldHostScan("%252Fbit.ly")).toBe("%252Fbit.ly");
    expect(foldEncodedSeparators("%2Fbit.ly")).toBe("/bit.ly");
    expect(foldHostScan("%2Bb%69t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%2Bbit%2Ely")).toBe("!");
    expect(foldHostScan("%2Bb%69t%2Ely")).toBe("!");
    expect(foldHostScan("%2Bb%2569t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%2B203%2E0%2E113%2E10")).toBe("!");
    expect(foldHostScan("%2Bbit%252Ely")).toBe("+bit%252Ely");
    expect(foldHostScan("example.com%2B\nb%69t.ly")).toBe(
      "example.com!bit.arpa",
    );
    expect(foldHostScan("%2Bb%69t.ly/http://t.co")).toBe(
      "!bit.arpa/http://t.co",
    );
    expect(foldHostScan("%2Bbit%2Ely/http://t.co")).toBe("!/http://t.co");
    expect(foldHostScan("%2Fb%69t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%2Fbit%2Ely")).toBe("!");
    expect(foldHostScan("%2F\nb%69t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%2Db%69t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%252Db%69t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("%2Dbit%2Ely")).toBe("!");
    expect(foldHostScan("%2D\nb%69t.ly")).toBe("!bit.arpa");
    expect(foldHostScan("b%69t.ly")).toBe("bit.ly");
    expect(foldHostScan("bit%2Ely")).toBe("bit.ly");
    expect(foldEncodedSeparators("%2Bbit%2Ely")).toBe("+bit.ly");
    expect(foldEncodedAlphabet("%2Bb%69t.ly")).toBe("%2Bbit.ly");
    expect(foldHostScan("%0Abit.ly")).toBe("%0Abit.ly");
    expect(foldHostScan("%09bit.ly")).toBe("%09bit.ly");
    expect(foldHostScan("%0Dbit.ly")).toBe("%0Dbit.ly");
    expect(foldHostScan("%C2%A0bit.ly")).toBe("%C2%A0bit.ly");
    expect(foldHostScan("%E2%80%8Bbit.ly")).toBe("%E2%80%8Bbit.ly");
    expect(foldHostScan("%250Abit.ly")).toBe("%250Abit.ly");
    expect(foldHostScan("%0A203.0.113.10")).toBe("%0A203.0.113.10");
    expect(foldHostScan("%09http://bit.ly")).toBe("%09http://bit.ly");
    expect(foldHostScan("http%0A://bit.ly")).toBe("http%0A://bit.ly");
    expect(foldHostScan("ht%0Atp://bit.ly")).toBe("ht%0Atp://bit.ly");
    expect(foldHostScan("http:%0A//bit.ly")).toBe("http:%0A//bit.ly");
    expect(foldHostScan("bit%E2%80%8B.ly")).toBe("bit.ly");
    expect(foldHostScan("b%0Ait.ly")).toBe("bit.ly");
    expect(foldHostScan("\nbit.ly")).toBe("bit.ly");
    expect(foldEncodedGaps("%0Abit.ly")).toBe("bit.ly");
    expect(foldEncodedGaps("IN%0AVITE")).toBe("INVITE");
    expect(foldHostScan("%C2%B7bit.ly")).toBe("%C2%B7bit.ly");
    expect(foldHostScan("%c2%b7bit.ly")).toBe("%c2%b7bit.ly");
    expect(foldHostScan("%E2%80%A2bit.ly")).toBe("%E2%80%A2bit.ly");
    expect(foldHostScan("%E2%80%A7bit.ly")).toBe("%E2%80%A7bit.ly");
    expect(foldHostScan("%E2%88%99bit.ly")).toBe("%E2%88%99bit.ly");
    expect(foldHostScan("%E2%8B%85bit.ly")).toBe("%E2%8B%85bit.ly");
    expect(foldHostScan("%E3%83%BBbit.ly")).toBe("%E3%83%BBbit.ly");
    expect(foldHostScan("%EF%BC%8Ebit.ly")).toBe("%EF%BC%8Ebit.ly");
    expect(foldHostScan("%EF%B9%92bit.ly")).toBe("%EF%B9%92bit.ly");
    expect(foldHostScan("%EF%BD%A1bit.ly")).toBe("%EF%BD%A1bit.ly");
    expect(foldHostScan("%C2%B7www.bit.ly")).toBe("%C2%B7www.bit.ly");
    expect(foldHostScan("%C2%B7.bit.ly")).toBe("%C2%B7.bit.ly");
    expect(foldHostScan("see%C2%B7bit.ly")).toBe("see%C2%B7bit.ly");
    expect(foldHostScan("example.com%C2%B7bit.ly")).toBe(
      "example.com%C2%B7bit.ly",
    );
    expect(foldHostScan("%C2%B7http://bit.ly")).toBe("%C2%B7http://bit.ly");
    expect(foldHostScan("%C2%B7HTTP://bit.ly")).toBe("%C2%B7HTTP://bit.ly");
    expect(foldHostScan("%C2%B7https://t.co")).toBe("%C2%B7https://t.co");
    expect(foldHostScan("%C2%B7203.0.113.10")).toBe("%C2%B7203.0.113.10");
    expect(foldHostScan("%C2%B7bit.ly/http://t.co")).toBe(
      "%C2%B7bit.ly/http://t.co",
    );
    expect(foldHostScan("bit%C2%B7ly")).toBe("bit.ly");
    expect(foldHostScan("bit%c2%b7ly")).toBe("bit.ly");
    expect(foldHostScan("bit.ly%C2%B7evil.com")).toBe("bit.ly%C2%B7evil.com");
    expect(foldHostScan("%25C2%25B7bit.ly")).toBe("%25C2%25B7bit.ly");
    expect(foldHostScan("\u00B7bit.ly")).toBe(".bit.ly");
    expect(foldHostScan("bit\u00B7ly")).toBe("bit.ly");
    expect(foldEncodedMiddleDot("%C2%B7bit.ly")).toBe("\u00B7bit.ly");
    expect(foldEncodedMiddleDot("bit%C2%B7ly")).toBe("bit\u00B7ly");
    expect(foldHostScan("%2Ebit.ly")).toBe("2Ebit.ly");
    expect(foldHostScan("%2ebit.ly")).toBe("2ebit.ly");
    expect(foldHostScan("%2Ewww.bit.ly")).toBe("2Ewww.bit.ly");
    expect(foldHostScan("%2E.bit.ly")).toBe("2E.bit.ly");
    expect(foldHostScan("see%2Ebit.ly")).toBe("see2Ebit.ly");
    expect(foldHostScan("example.com%2Ebit.ly")).toBe("example.com2Ebit.ly");
    expect(foldHostScan("www%2Ebit.ly")).toBe("www2Ebit.ly");
    expect(foldHostScan("http://%2Ebit.ly")).toBe("http://2Ebit.ly");
    expect(foldHostScan("HTTP://%2Ebit.ly")).toBe("HTTP://2Ebit.ly");
    expect(foldHostScan("%2E203.0.113.10")).toBe("2E203.0.113.10");
    expect(foldHostScan("%2E.203.0.113.10")).toBe("2E.203.0.113.10");
    expect(foldHostScan("%2Ebit.ly/http://t.co")).toBe("2Ebit.ly/http://t.co");
    expect(foldHostScan("%2E203.0.113.10/http://t.co")).toBe(
      "2E203.0.113.10/http://t.co",
    );
    expect(foldHostScan("bit%2Ely")).toBe("bit.ly");
    expect(foldHostScan("t%2Eme/+CODE")).toBe("t.me/+CODE");
    expect(foldHostScan("%252Ebit.ly")).toBe("%252Ebit.ly");
    expect(foldHostScan("%2E\nbit.ly")).toBe(".bit.ly");
    expect(foldHostScan("%2E bit.ly")).toBe(". bit.ly");
    expect(foldHostScan("http://bit.ly%2Eevil.com")).toBe(
      "http://bit.ly2Eevil.com",
    );
    expect(foldHostScan("https://example.com/%2Ebit.ly")).toBe(
      "https://example.com/.bit.ly",
    );
    expect(foldEncodedSeparators("%2Ebit.ly")).toBe(".bit.ly");
    expect(foldHostScan("%5B.%5Dbit.ly")).toBe("5Dbit.ly");
    expect(foldHostScan("%5b.%5dbit.ly")).toBe("5dbit.ly");
    expect(foldHostScan("%28.%29bit.ly")).toBe("29bit.ly");
    expect(foldHostScan("%7B.%7Dbit.ly")).toBe("7Dbit.ly");
    expect(foldHostScan("%5B%2E%5Dbit.ly")).toBe("5Dbit.ly");
    expect(foldHostScan("%5B\u3002%5Dbit.ly")).toBe("5Dbit.ly");
    expect(foldHostScan("see%5B.%5Dbit.ly")).toBe("see5Dbit.ly");
    expect(foldHostScan("www%5B.%5Dbit.ly")).toBe("www5Dbit.ly");
    expect(foldHostScan("%5B.%5Dwww.bit.ly")).toBe("5Dwww.bit.ly");
    expect(foldHostScan("%5B.%5D.bit.ly")).toBe("5D.bit.ly");
    expect(foldHostScan("%28%2E%29www.bit.ly")).toBe("29www.bit.ly");
    expect(foldHostScan("%7B.%7D.bit.ly")).toBe("7D.bit.ly");
    expect(foldHostScan("%5B.%5Dhttp://bit.ly")).toBe("5Dhttp://bit.ly");
    expect(foldHostScan("%5B.%5DHTTP://bit.ly")).toBe("5DHTTP://bit.ly");
    expect(foldHostScan("http://%5B.%5Dbit.ly")).toBe("http://5Dbit.ly");
    expect(foldHostScan("http://%5B.%5Dwww.bit.ly")).toBe(
      "http://5Dwww.bit.ly",
    );
    expect(foldHostScan("%5B.%5D203.0.113.10")).toBe("5D203.0.113.10");
    expect(foldHostScan("%5B.%5Dbit.ly/http://t.co")).toBe(
      "5Dbit.ly/http://t.co",
    );
    expect(foldHostScan("%5B.%5D203.0.113.10/http://t.co")).toBe(
      "5D203.0.113.10/http://t.co",
    );
    expect(foldHostScan("[.%5Dbit.ly")).toBe("5Dbit.ly");
    expect(foldHostScan("bit%5B.%5Dly")).toBe("bit.ly");
    expect(foldHostScan("bit[.]ly")).toBe("bit.ly");
    expect(foldHostScan("[.]bit.ly")).toBe(".bit.ly");
    expect(foldHostScan("%5B.]bit.ly")).toBe(".bit.ly");
    expect(foldHostScan("%5B.%5D\nbit.ly")).toBe(".bit.ly");
    expect(foldHostScan("%5B.%5D bit.ly")).toBe(". bit.ly");
    expect(foldHostScan("http://bit.ly%5B.%5Devil.com")).toBe(
      "http://bit.ly5Devil.com",
    );
    expect(foldHostScan("https://example.com/%5B.%5Dbit.ly")).toBe(
      "https://example.com/.bit.ly",
    );
    expect(foldHostScan("%255B.%255Dbit.ly")).toBe("%255B.%255Dbit.ly");
    expect(foldBracketDots("%5B.%5Dbit.ly")).toBe(".bit.ly");
    expect(foldHostScan("example.com\u70B9bit.ly")).toBe("example.comxbit.ly");
    expect(foldHostScan("example.com\u70B9\u51FBbit.ly")).toBe(
      "example.comxbit.ly",
    );
    expect(foldHostScan("bit.ly\u70B9evil.com")).toBe("bit.lyxevil.com");
    expect(foldHostScan("www.bit.ly\u70B9evil.com")).toBe(
      "www.bit.lyxevil.com",
    );
    expect(foldHostScan("example.com\uAC00bit.ly")).toBe("example.comxbit.ly");
    expect(foldHostScan("example.com\u3042bit.ly")).toBe("example.comxbit.ly");
    expect(foldHostScan("example.com\u05D0bit.ly")).toBe("example.comxbit.ly");
    expect(foldHostScan("example.com\u263Abit.ly")).toBe("example.comxbit.ly");
    expect(foldHostScan("x\u70B9bit.ly")).toBe("xxbit.ly");
    expect(foldHostScan("b\u70B9it.ly")).toBe("bxit.ly");
    expect(foldHostScan("203.0.113.10\u70B9bit.ly")).toBe(
      "203.0.113.10xbit.ly",
    );
    expect(foldHostScan("bit.ly\u70B9free")).toBe("bit.ly\u70B9free");
    expect(foldHostScanKeepingStops("bit.ly\u70B9free")).toBe(
      "bit.ly\u70B9free",
    );
    expect(foldHostScan("bit.ly\u70B9free.notarealtld")).toBe(
      "bit.ly\u70B9free.notarealtld",
    );
    expect(foldHostScan("bit.ly\u70B9203.0.113.10")).toBe(
      "bit.ly\u70B9203.0.113.10",
    );
    expect(foldHostScanKeepingStops("www.bit.ly\u70B9203.0.113.10")).toBe(
      "www.bit.ly\u70B9203.0.113.10",
    );
    expect(foldHostScan("203.0.113.10\u70B9203.0.113.11")).toBe(
      "203.0.113.10\u70B9203.0.113.11",
    );
    expect(foldHostScan("example.com\u70B9203.0.113.10")).toBe(
      "example.com\u70B9203.0.113.10",
    );
    expect(foldHostScan("bit.ly\u70B9free.com")).toBe("bit.lyxfree.com");
    expect(foldHostScan("bit.ly\u70B9free.\u4E2D\u56FD")).toBe(
      "bit.lyxfree.\u4E2D\u56FD",
    );
    expect(foldHostScan("http://bit.ly\u70B9free")).toBe(
      "http://bit.ly\u70B9free",
    );
    expect(foldHostScan("\u70B9bit.ly")).toBe("\u70B9bit.ly");
    expect(foldHostScan("\u70B9\u51FBbit.ly")).toBe("\u70B9\u51FBbit.ly");
    expect(foldHostScan("example.com\u70B9http://bit.ly")).toBe(
      "example.com\u70B9http://bit.ly",
    );
    expect(foldHostScan("example.com\u70B9HTTP://bit.ly")).toBe(
      "example.com\u70B9HTTP://bit.ly",
    );
    expect(foldHostScan("example.com\u70B9https://t.co")).toBe(
      "example.com\u70B9https://t.co",
    );
    expect(foldHostScan("example.com\u3002bit.ly")).toBe("example.com.bit.ly");
    expect(foldHostScanKeepingStops("example.com\u3002bit.ly")).toBe(
      "example.com.bit.ly",
    );
    expect(foldHostScan("bit.ly\u3002evil.com")).toBe("bit.ly.evil.com");
    expect(foldHostScanKeepingStops("bit.ly\u3002evil.com")).toBe(
      "bit.ly.evil.com",
    );
    expect(foldHostScan("www.bit.ly\u3002evil.com")).toBe(
      "www.bit.ly.evil.com",
    );
    expect(foldHostScan("bit.ly\u3002\u3002evil.com")).toBe("bit.ly.evil.com");
    expect(foldHostScan("203.0.113.10\u3002evil.com")).toBe(
      "203.0.113.10.evil.com",
    );
    expect(foldHostScan("203.0.113.10\u3002bit.ly")).toBe(
      "203.0.113.10.bit.ly",
    );
    expect(foldHostScan("bit.ly\u3002/z")).toBe("bit.ly\u3002/z");
    expect(foldHostScan("www.bit.ly\u3002/z")).toBe("www.bit.ly\u3002/z");
    expect(foldHostScan("bit\u3002ly")).toBe("bit\u3002ly");
    expect(foldHostScan("\u4e0d\u662f\u514d\u8d39\u3002\u9886\u53d6")).toBe(
      "\u4e0d\u662f\u514d\u8d39\u3002\u9886\u53d6",
    );
    expect(foldHostScan("http://bit\u3002ly")).toBe("http://bit\u3002ly");
    expect(foldHostScan("http://bit.ly\u3002/z")).toBe("http://bit.ly\u3002/z");
    expect(foldHostScan("example.com\u3002http://bit.ly")).toBe(
      "example.com\u3002http://bit.ly",
    );
    expect(foldHostScan("%E3%80%82bit.ly")).toBe("%E3%80%82bit.ly");
    expect(foldHostScanKeepingStops("bit.ly\u00B7evil.com")).toBe(
      "bit.ly.evil.com",
    );
    expect(foldHostScan("bit.ly\u00B7\u00B7evil.com")).toBe("bit.ly.evil.com");
    expect(foldHostScanKeepingStops("bit.ly\u00B7\u00B7evil.com")).toBe(
      "bit.ly.evil.com",
    );
    expect(foldHostScanKeepingStops("bit.ly\uFF0Eevil.com")).toBe(
      "bit.ly.evil.com",
    );
    expect(foldHostScanKeepingStops("203.0.113.10\u00B7evil.com")).toBe(
      "203.0.113.10.evil.com",
    );
    expect(foldHostScanKeepingStops("bit.ly\u00B7/z")).toBe("bit.ly\u00B7/z");
    expect(foldHostScanKeepingStops("bit\u00B7ly")).toBe("bit\u00B7ly");
    expect(foldHostScanKeepingStops("bit.ly\u00B7evil\u00B7com")).toBe(
      "bit.ly\u00B7evil\u00B7com",
    );
    expect(foldHostScanKeepingStops("example.com.\u00B7http://bit.ly")).toBe(
      "example.com.\u00B7http://bit.ly",
    );
    expect(foldHostScanKeepingStops("bit\uFF0Ely\uFF0Ecom/http://t.co/z")).toBe(
      "bit\uFF0Ely\uFF0Ecom/http://t.co/z",
    );
    expect(foldHostScan("example.com\uE000bit.ly")).toBe(
      "example.com\uE000bit.ly",
    );
    expect(foldHostScan("example.com\u{10140}bit.ly")).toBe(
      "example.combit.ly",
    );
    expect(foldHostScanKeepingStops("example.com\u{10140}bit.ly")).toBe(
      "example.com\u{10140}bit.ly",
    );
    expect(foldHostScan("example.com\u70B9/bit.ly")).toBe(
      "example.com\u70B9/bit.ly",
    );
    expect(foldHostScan("bit.ly\u70B9/z")).toBe("bit.ly\u70B9/z");
    expect(foldHostScan("example.com\u70B9.bit.ly")).toBe(
      "example.com\u70B9.bit.ly",
    );
    expect(foldHostScan("example.com\u70B9www.bit.ly")).toBe(
      "example.comxwww.bit.ly",
    );
    expect(foldHostScan("bi\uFE0Ft.ly")).toBe("bit.ly");
    expect(foldHostScan("b\u0442it.ly")).toBe("bit.ly");
    expect(foldHostScan("bit\u00B7ly")).toBe("bit.ly");
    expect(foldHostScanKeepingStops("example.com\u70B9bit.ly")).toBe(
      "example.comxbit.ly",
    );
    expect(foldHostScanKeepingStops("example.com\u70B9http://bit.ly")).toBe(
      "example.com\u70B9http://bit.ly",
    );
    expect(foldHostInterrupters("example.com\u70B9bit.ly")).toBe(
      "example.com\u70B9bit.ly",
    );
    expect(foldHostScan("b\u2139t.ly")).toBe("bit.ly");
    expect(foldHostScan("http://b\u2139t.ly")).toBe("http://bit.ly");
    expect(foldHostScan("http://b\u24D8t.ly")).toBe("http://bit.ly");
    expect(foldHostScan("http://b\u2160t.ly")).toBe("http://bit.ly");
    expect(foldHostScan("b\u1D35t.ly")).toBe("bit.ly");
    expect(foldHostScan("bi\u1D40.ly")).toBe("bit.ly");
    expect(foldHostScan("http://t.\u1D9Co")).toBe("http://t.co");
    expect(foldHostScan("\u2139bit.ly")).toBe("ibit.ly");
    expect(foldHostScan("b\u017Fit.ly")).toBe("bsit.ly");
    expect(foldHostScan("b\u212Ait.ly")).toBe("bkit.ly");
    expect(foldHostScan("bit.ly\u2139evil.com")).toBe("bit.lyievil.com");
    expect(foldHostScan("bit.ly\u2139/z")).toBe("bit.ly\u2139/z");
    expect(foldHostScan("bit.ly\u00AA/z")).toBe("bit.ly\u00AA/z");
    expect(foldHostScan("bit.ly\u00AAx/z")).toBe("bit.ly\u00AAx/z");
    expect(foldHostScan("www.bit.ly\u00AA/z")).toBe("www.bit.ly\u00AA/z");
    expect(foldHostScan("203.0.113.10\u00AA/z")).toBe("203.0.113.10\u00AA/z");
    expect(foldHostScan("\u00AA203.0.113.10/z")).toBe("\u00AA203.0.113.10/z");
    expect(foldHostScan("a\u00AA203.0.113.10/z")).toBe("a\u00AA203.0.113.10/z");
    expect(foldHostScan("\u0410203.0.113.10/z")).toBe("\u0410203.0.113.10/z");
    expect(foldHostScan("a\uFF41203.0.113.10/z")).toBe("a\uFF41203.0.113.10/z");
    expect(foldHostScan("http://\u00AA203.0.113.10/z")).toBe(
      "http://a203.0.113.10/z",
    );
    expect(foldHostScan("http://example.com/\u0410203.0.113.10/z")).toBe(
      "http://example.com/A203.0.113.10/z",
    );
    expect(foldHostScan("\u00AA203.0.113.10.evil.com/z")).toBe(
      "a203.0.113.10.evil.com/z",
    );
    expect(foldCyrillicLookalikes("\u0410203.0.113.10/z")).toBe(
      "A203.0.113.10/z",
    );
    expect(foldHostScanKeepingStops("\u00AA203.0.113.10/z")).toBe(
      "\u00AA203.0.113.10/z",
    );
    expect(foldHostScanKeepingStops("a\u0430203.0.113.10/z")).toBe(
      "a\u0430203.0.113.10/z",
    );
    expect(foldHostScan("bit.ly\u00AA?z")).toBe("bit.ly\u00AA?z");
    expect(foldHostScan("http://bit.ly\u00AA/z")).toBe("http://bit.lya/z");
    expect(foldHostScan("bit.ly\u00AAevil.com")).toBe("bit.lyaevil.com");
    expect(foldHostScan("bit.ly\u00AAhttp://t.co")).toBe(
      "bit.ly\u00AAhttp://t.co",
    );
    expect(foldHostScanKeepingStops("bit.ly\u0430/z")).toBe("bit.ly\u0430/z");
    expect(foldHostScanKeepingStops("bit.ly\u0430x/z")).toBe("bit.ly\u0430x/z");
    expect(foldHostScanKeepingStops("bit.ly\uFF41/z")).toBe("bit.ly\uFF41/z");
    expect(foldHostScanKeepingStops("b\u0430it.ly")).toBe("bait.ly");
    expect(foldHostScanKeepingStops("http://bit.ly\u0430/z")).toBe(
      "http://bit.lya/z",
    );
    expect(foldHostInterrupters("bit.ly\u00AA/z")).toBe("bit.ly\u00AA/z");
    expect(foldHostInterrupters("b\u00AAit.ly")).toBe("bit.ly");
    expect(foldHostScan("example.com\u2139bit.ly")).toBe("example.comibit.ly");
    expect(foldHostScan("example.com\u2139http://bit.ly")).toBe(
      "example.com\u2139http://bit.ly",
    );
    expect(foldHostScan("example.com\u2139http://bit.ly")).not.toContain(
      "ihttp://",
    );
    expect(foldHostScan("example.com\u24D8https://t.co")).toBe(
      "example.com\u24D8https://t.co",
    );
    expect(foldHostScanKeepingStops("b\u2139t.ly")).toBe("bit.ly");
    expect(foldHostScanKeepingStops("\u2139bit.ly")).toBe("ibit.ly");
    expect(foldHostScanKeepingStops("example.com\u2139http://bit.ly")).toBe(
      "example.com\u2139http://bit.ly",
    );
    expect(foldHostScanKeepingStops("b\u017Fit.ly")).toBe("bsit.ly");
    expect(foldHostInterrupters("b\u2139t.ly")).toBe("b\u2139t.ly");
    expect(foldFullwidthLatin("b\u2139t.ly")).toBe("b\u2139t.ly");
    expect(foldCyrillicLookalikes("b\u0442it.ly")).toBe("b\u0442it.ly");
    expect(foldHostScan("bi\u034Ft.ly")).toBe("bit.ly");
    expect(foldHostScan("b\u034Fit.ly")).toBe("bit.ly");
    expect(foldHostScan("bit\u034F.ly")).toBe("bit.ly");
    expect(foldHostScan("bi\u034F\u034Ft.ly")).toBe("bit.ly");
    expect(foldHostScan("t\u034F.co")).toBe("t.co");
    expect(foldHostScan("http://bi\u034Ft.ly")).toBe("http://bit.ly");
    expect(foldHostScan("http://bit\u034F.ly")).toBe("http://bit.ly");
    expect(foldHostScanKeepingStops("bi\u034Ft.ly")).toBe("bit.ly");
    expect(foldHostScanKeepingStops("bit\u034F.ly")).toBe("bit.ly");
    expect(foldHostScan("bit.\u034Fly")).toBe("bit.\u034Fly");
    expect(foldHostScan("example.com\u034Fhttp://bit.ly")).toBe(
      "example.comhttp://bit.ly",
    );
    expect(foldHostScan("\u034Fbit.ly")).toBe("\u034Fbit.ly");
    expect(foldHostInterrupters("bi\u034Ft.ly")).toBe("bi\u034Ft.ly");
    expect(foldMatchText("bi\u034Ft")).toBe("bi\u034Ft");
  });

  it("keeps a supplementary letter Android leaves out of a label", () => {
    const greek = "\u{10140}";
    const latin = "\u{10780}";
    const cyrillic = "\u{1E030}";
    expect(foldHostScanKeepingStops(`http://bit.ly${greek}evil.com`)).toBe(
      `http://bit.ly${greek}evil.com`,
    );
    expect(foldHostScanKeepingStops(`http://bit.ly${latin}evil.com`)).toBe(
      `http://bit.ly${latin}evil.com`,
    );
    expect(foldHostScanKeepingStops(`http://bit.ly${cyrillic}evil.com`)).toBe(
      `http://bit.ly${cyrillic}evil.com`,
    );
    expect(foldHostScan(`b${greek}it.ly`)).toBe("bit.ly");
    expect(foldHostScan("b\u03B1it.ly")).toBe("bit.ly");
    expect(foldHostScanKeepingStops("b\u03B1it.ly")).toBe("bit.ly");
    expect(foldHostScanKeepingStops("example.com\u03B1/http://bit.ly")).toBe(
      "example.com\u03B1/http://bit.ly",
    );
    expect(foldHostScanKeepingStops("example.com\u03B1http://bit.ly")).toBe(
      "example.com\u03B1http://bit.ly",
    );
    expect(foldHostScanKeepingStops("example.com\u03B1https://t.me")).toBe(
      "example.com\u03B1https://t.me",
    );
    expect(foldHostScanKeepingStops("http://bit.ly\u00A0evil.com")).toBe(
      "http://bit.ly\u00A0evil.com",
    );
  });

  it("keeps a dot lookalike that already follows an ascii dot", () => {
    const fullwidth = "\uFF0E";
    const middle = "\u00B7";
    expect(foldHostScan(`http://example.com.${fullwidth}http://bit.ly`)).toBe(
      `http://example.com.${fullwidth}http://bit.ly`,
    );
    expect(
      foldHostScanKeepingStops(`http://example.com.${middle}http://bit.ly`),
    ).toBe(`http://example.com.${middle}http://bit.ly`);
    expect(foldHostScan(`bit${fullwidth}ly`)).toBe("bit.ly");
    expect(foldHostScan(`bit${middle}ly`)).toBe("bit.ly");
    expect(foldDotLookalikes(`bit.${fullwidth}ly`)).toBe("bit..ly");
    expect(foldHostScan(`http://example.com@${fullwidth}http://bit.ly`)).toBe(
      `http://example.com@${fullwidth}http://bit.ly`,
    );
    expect(foldHostScan(`http://user@bit${fullwidth}ly`)).toBe(
      "http://user@bit.ly",
    );
    expect(foldHostScan(`http://example.com${fullwidth}@http://bit.ly`)).toBe(
      `http://example.com${fullwidth}@http://bit.ly`,
    );
    expect(foldHostScan(`bit${fullwidth}ly${fullwidth}com`)).toBe("bit.ly.com");
    expect(
      foldHostScanKeepingStops(
        `bit${fullwidth}ly${fullwidth}com/http://t.co/z`,
      ),
    ).toBe(`bit${fullwidth}ly${fullwidth}com/http://t.co/z`);
    expect(foldHostScan(`bit${fullwidth}ly${fullwidth}com/http://t.co/z`)).toBe(
      "bit.ly.com/http://t.co/z",
    );
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
    expect(foldHostInterrupters("b\u055Ait.ly")).toBe("b\u055Ait.ly");
    expect(foldHostInterrupters("b\u0384it.ly")).toBe("b\u0384it.ly");
    expect(foldHostInterrupters("b\u0482it.ly")).toBe("b\u0482it.ly");
    expect(foldHostScan("b\u055Ait.ly")).toBe("bxit.ly");
    expect(foldHostScan("http://bit.\u055Aly")).toBe("http://bit.\u055Aly");
    expect(foldHostScan("example.com\u055Ahttp://bit.ly")).toBe(
      "example.com\u055Ahttp://bit.ly",
    );
    expect(foldHostScan("b\u0561it.ly")).toBe("bit.ly");
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

describe("androidUrlSpan", () => {
  it("stops before a character that does not continue the path", () => {
    expect(androidUrlSpan("http://bit.ly\u2215@example.com/path")).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan("http://bit.ly\u2044@example.com/path")).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan("http://bit.ly%2F@example.com/path")).toBeNull();
    expect(androidUrlSpan("http://bit.ly%E2%88%95@example.com/path")).toBe(
      "http://bit.ly/@example.com/path",
    );
    expect(androidUrlSpan("http://203.0.113.9\u2215@example.com")).toBe(
      "http://203.0.113.9",
    );
    expect(androidUrlSpan("http://bit.ly，广告")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u200Bfoo")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u1680foo")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u205Ffoo")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\uFEFFfoo")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u00A0foo")).toBe("http://bit.ly");
    expect(androidUrlSpan("https://example.com/docs")).toBeNull();
    expect(androidUrlSpan("http://bit.ly@example.com/ok")).toBeNull();
  });

  it("stops before an @ that cannot finish user info", () => {
    expect(androidUrlSpan("http://bit.ly@.evil.com/x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly@\u4f8b.com/x")).toBeNull();
    expect(androidUrlSpan("http://example.com@\u4f8bhttp://bit.ly/z")).toBe(
      "http://example.com@\u4f8bhttp",
    );
    expect(androidUrlSpan("http://bit.ly@!")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly@:999999/x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://203.0.113.133@.evil.com/x")).toBe(
      "http://203.0.113.133",
    );
    expect(androidUrlSpan("http://bit.ly:pass@.evil.com")).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan("http://bit.ly@example.com/ok")).toBeNull();
    expect(androidUrlSpan("http://bit.ly@/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly@?x=1")).toBeNull();
    expect(androidUrlSpan("http://bit.ly@:80/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly@")).toBeNull();
    expect(androidUrlSpan("http://bit.ly@_evil")).toBeNull();
    expect(androidUrlSpan("http://user:pass@bit.ly/p")).toBeNull();
  });

  it("leaves a division slash inside the host", () => {
    expect(androidUrlSpan("http://\u2215bit.ly/z")).toBeNull();
    expect(androidUrlSpan("https://\u2044bit.ly/z")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u2215/z")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u2215?z")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u2215")).toBeNull();
    expect(androidUrlSpan("http://\u2215203.0.113.10/z")).toBeNull();
    expect(androidUrlSpan("http://203.0.113.9\u2215/z")).toBeNull();
    expect(androidUrlSpan("http://bit.ly\u2215http://evil.com/z")).toBe(
      "http://bit.ly\u2215http",
    );
    expect(androidUrlSpan("http://bit.ly\u2215@example.com/path")).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan("http://bit.ly\u2215#evil.com/z")).toBe(
      "http://bit.ly",
    );
  });

  it("turns a division slash inside the span into a slash", () => {
    expect(androidUrlSpan("http://example.com/a\u2215b")).toBe(
      "http://example.com/a/b",
    );
    expect(androidUrlSpan("http://example.com/a%E2%88%95b")).toBe(
      "http://example.com/a/b",
    );
    expect(androidUrlSpan("http://example.com/a%e2%88%95b")).toBeNull();
  });

  it("stops before a hyphen that does not finish a label", () => {
    expect(androidUrlSpan("http://bit.ly-/offer")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly--/x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly-.com/x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://203.0.113.9-/x")).toBe("http://203.0.113.9");
    expect(androidUrlSpan("http://bit.ly-foo/offer")).toBeNull();
    expect(androidUrlSpan("http://203.0.113.9-1/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly-@example.com/p")).toBeNull();
    expect(androidUrlSpan("http://bit.ly:x-@example.com/p")).toBeNull();
    expect(androidUrlSpan("http://user:pass-word@bit.ly/p")).toBeNull();
    expect(androidUrlSpan("http://example.com-@bit.ly/p")).toBeNull();
    expect(androidUrlSpan("http://bit.ly:80/x")).toBeNull();
  });

  it("stops before a dot that does not start another label", () => {
    expect(androidUrlSpan("http://bit.ly../x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly.../x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly..")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly..evil.com/x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://203.0.113.9../x")).toBe("http://203.0.113.9");
    expect(androidUrlSpan("http://user:pass@bit.ly../x")).toBe(
      "http://user:pass@bit.ly",
    );
    expect(androidUrlSpan("http://bit.ly.evil.com/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly./x")).toBe("http://bit.ly");
  });

  it("stops before a port longer than five digits", () => {
    expect(androidUrlSpan("http://bit.ly:999999/x")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://bit.ly:999999")).toBe("http://bit.ly");
    expect(androidUrlSpan("http://203.0.113.9:999999/x")).toBe(
      "http://203.0.113.9",
    );
    expect(androidUrlSpan("http://bit.ly:80/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly:65535/x")).toBeNull();
    expect(androidUrlSpan("http://bit.ly:80a/x")).toBe("http://bit.ly:80");
  });

  it("stops before a label longer than 63 characters", () => {
    const exact = "a".repeat(63);
    const over = "a".repeat(64);
    const fitted = "a".repeat(62);
    expect(androidUrlSpan(`http://bit.ly.${over}/x`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly.${over}`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://203.0.113.9.${over}/x`)).toBe(
      "http://203.0.113.9",
    );
    expect(androidUrlSpan(`http://user:pass@bit.ly.${over}/x`)).toBe(
      "http://user:pass@bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly.${exact}/x`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly.${fitted}-foo/x`)).toBe(
      `http://bit.ly.${fitted}`,
    );
  });

  it("stops before an underscore that does not finish a label", () => {
    const blocked = "a".repeat(62);
    const full = "a".repeat(63);
    const fitted = "a".repeat(61);
    const split = "a".repeat(50);
    const hyphen = "a".repeat(60);
    expect(androidUrlSpan(`http://bit.ly.${blocked}_b/x`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly.${blocked}_/x`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly.${full}_/x`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly.${split}_${"b".repeat(20)}/x`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://203.0.113.129.${blocked}_b/x`)).toBe(
      "http://203.0.113.129",
    );
    expect(androidUrlSpan(`http://user:pass@bit.ly.${blocked}_b/x`)).toBe(
      "http://user:pass@bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly.${fitted}_b/x`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly_${split}/x`)).toBeNull();
    expect(androidUrlSpan("http://bit.ly_/x")).toBe("http://bit");
    expect(androidUrlSpan("http://203.0.113.9_/x")).toBe("http://203.0.113");
    expect(androidUrlSpan(`http://bit.ly.${hyphen}-${"c".repeat(10)}/x`)).toBe(
      `http://bit.ly.${hyphen}`,
    );
  });

  it("keeps a label character when the schemed URL continues", () => {
    const mark = "\u4e00";
    expect(androidUrlSpan(`http://bit.ly${mark}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${mark}?z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${mark}`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${mark}.evil.com/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly.${mark}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${mark}:80/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${mark}:80`)).toBeNull();
    expect(androidUrlSpan(`http://t.co${mark}/z`)).toBeNull();
    expect(androidUrlSpan(`http://203.0.113.10${mark}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${mark}@evil.com/z`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly${mark}@`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly${mark}#z`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly${mark} evil.com`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly${mark}. evil.com`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://203.0.113.10${mark}@evil.com`)).toBe(
      "http://203.0.113.10",
    );
    expect(androidUrlSpan(`http://bit.ly${mark}:80@evil.com`)).toBe(
      `http://bit.ly${mark}:80`,
    );
  });

  it("keeps a supplementary label character in the schemed host", () => {
    const ext = "\u{20000}";
    expect(androidUrlSpan(`http://bit.ly${ext}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${ext}?z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${ext}`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${ext}.evil.com/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly.${ext}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly-${ext}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${ext}:80/z`)).toBeNull();
    expect(androidUrlSpan(`http://t.co${ext}/z`)).toBeNull();
    expect(androidUrlSpan(`http://203.0.113.10${ext}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${ext}@evil.com/z`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly${ext}#z`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly${ext} evil.com`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly\u{10140}/z`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly${ext}:80@evil.com`)).toBe(
      `http://bit.ly${ext}:80`,
    );
    const kept = ext.repeat(61);
    const opened = ext.repeat(62);
    expect(androidUrlSpan(`http://bit.ly${kept}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly${opened}/z`)).toBe("http://bit.ly");
    expect(androidUrlSpan(`http://bit.ly.${ext.repeat(63)}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly.${ext.repeat(64)}/z`)).toBe(
      "http://bit.ly",
    );
    expect(androidUrlSpan(`http://bit.ly-${ext.repeat(31)}/z`)).toBeNull();
    expect(androidUrlSpan(`http://bit.ly-${ext.repeat(61)}/z`)).toBe(
      "http://bit.ly",
    );
    expect(
      androidUrlSpan(`http://bit.ly.${"a".repeat(62)}${ext}/z`),
    ).toBeNull();
  });
});
