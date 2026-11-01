import { describe, expect, it } from "vitest";
import { locales, messageKeys, translate } from "./messages.js";

describe("translate", () => {
  it("has a non-empty string for every key in zh and en", () => {
    for (const locale of locales) {
      for (const key of messageKeys) {
        const value = translate(locale, key);
        expect(value.length, `${locale} ${key}`).toBeGreaterThan(0);
        expect(value, `${locale} ${key}`).not.toBe(key);
      }
    }
  });

  it("returns the key when the catalog has no entry", () => {
    expect(translate("zh", "command.missing")).toBe("command.missing");
    expect(translate("en", "command.missing")).toBe("command.missing");
    expect(translate("fr", "command.missing")).toBe("command.missing");
  });

  it("uses Chinese when the locale is unknown", () => {
    expect(translate("", "command.denied")).toBe("没有权限");
    expect(translate("fr", "command.denied")).toBe("没有权限");
    expect(translate("en", "command.denied")).toBe("No permission");
  });

  it("fills placeholders and keeps a missing one", () => {
    expect(translate("zh", "command.forget.deleted", { count: 0 })).toBe(
      "已删除 0 条",
    );
    expect(translate("en", "command.forget.deleted", { count: 2 })).toBe(
      "Deleted 2",
    );
    expect(translate("en", "command.forget.deleted")).toBe("Deleted {count}");
    expect(translate("en", "command.forget.deleted", { other: 1 })).toBe(
      "Deleted {count}",
    );
  });
});
