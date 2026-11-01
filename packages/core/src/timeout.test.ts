import { describe, expect, it } from "vitest";
import { withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  it("resolves and rejects", async () => {
    await expect(withTimeout(Promise.resolve(7), 20)).resolves.toBe(7);
    await expect(
      withTimeout(Promise.reject(new Error("nope")), 20),
    ).rejects.toThrow("nope");
    await expect(withTimeout(Promise.reject("bad"), 20)).rejects.toThrow(
      "detector_failed",
    );
    await expect(withTimeout(new Promise(() => {}), 15)).rejects.toThrow(
      "detector_timeout",
    );
  });
});
