import { describe, expect, it } from "vitest";
import { admitExample } from "./run.js";

describe("plugin manifest example", () => {
  it("requires a signature unless unsigned plugins are explicitly allowed", async () => {
    expect(await admitExample({ allowUnsigned: false, sign: false })).toEqual({
      ok: false,
      reason: "unsigned",
    });
    expect((await admitExample({ allowUnsigned: true, sign: false })).ok).toBe(
      true,
    );
    expect((await admitExample({ allowUnsigned: false, sign: true })).ok).toBe(
      true,
    );
  });
});
