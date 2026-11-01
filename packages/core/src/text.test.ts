import { describe, expect, it } from "vitest";
import { foldMatchText } from "./text.js";

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
});
