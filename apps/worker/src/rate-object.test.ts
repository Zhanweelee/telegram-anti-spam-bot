import { createMemoryRateWindow, type RateWindow } from "@tasb/detector-rate";
import { describe, expect, it } from "vitest";
import {
  createDurableRateWindow,
  type RateWindowNamespace,
  RateWindowObject,
  rateWindowFromEnv,
} from "./rate-object.js";

const phrase = "请免费领取礼品";

function shardId(name: string): DurableObjectId {
  return {
    name,
    toString() {
      return name;
    },
    equals() {
      return false;
    },
  };
}

function sharedNamespace(): RateWindowNamespace {
  const windows = new Map<string, RateWindow>();
  return {
    idFromName(name) {
      return shardId(name);
    },
    get(id) {
      const existing = windows.get(id.name ?? "");
      const window = existing ?? createMemoryRateWindow();
      if (!existing) {
        windows.set(id.name ?? "", window);
      }
      return {
        observe: (input: Parameters<RateWindow["observe"]>[0]) =>
          window.observe(input),
      };
    },
  };
}

describe("durable rate window", () => {
  it("shares a chat count across two callers and keeps another chat apart", async () => {
    const namespace = sharedNamespace();
    const first = createDurableRateWindow(namespace);
    const second = createDurableRateWindow(namespace);
    const key = "f\nlocal\n-100\n5";
    expect(await first.observe({ key, nowMs: 1_000, windowMs: 10_000 })).toBe(
      1,
    );
    expect(await second.observe({ key, nowMs: 1_100, windowMs: 10_000 })).toBe(
      2,
    );
    expect(
      await first.observe({
        key: "f\nlocal\n-200\n5",
        nowMs: 1_200,
        windowMs: 10_000,
      }),
    ).toBe(1);
    expect(
      await second.observe({
        key: "r\nlocal\n-100\nab",
        nowMs: 1_300,
        windowMs: 10_000,
      }),
    ).toBe(1);
  });

  it("returns null from a full window and hides a stub error", async () => {
    const full: RateWindowNamespace = {
      idFromName(name) {
        return shardId(name);
      },
      get() {
        return {
          async observe() {
            return null;
          },
        };
      },
    };
    expect(
      await createDurableRateWindow(full).observe({
        key: "f\nlocal\n-100\n5",
        nowMs: 1_000,
        windowMs: 10_000,
      }),
    ).toBeNull();

    const broken: RateWindowNamespace = {
      idFromName(name) {
        return shardId(name);
      },
      get() {
        return {
          async observe() {
            throw new Error(phrase);
          },
        };
      },
    };
    await expect(
      createDurableRateWindow(broken).observe({
        key: "f\nlocal\n-100\n5",
        nowMs: 1_000,
        windowMs: 10_000,
      }),
    ).rejects.toThrow("rate_window_unavailable");
    try {
      await createDurableRateWindow(broken).observe({
        key: "f\nlocal\n-100\n5",
        nowMs: 1_000,
        windowMs: 10_000,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").not.toContain(phrase);
    }
  });

  it("counts one event id once across two callers", async () => {
    const namespace = sharedNamespace();
    const first = createDurableRateWindow(namespace);
    const second = createDurableRateWindow(namespace);
    const key = "f\nlocal\n-100\n5";
    expect(
      await first.observe({
        key,
        nowMs: 1_000,
        windowMs: 10_000,
        eventId: "tg_9",
      }),
    ).toBe(1);
    expect(
      await second.observe({
        key,
        nowMs: 1_100,
        windowMs: 10_000,
        eventId: "tg_9",
      }),
    ).toBe(1);
    expect(
      await second.observe({
        key,
        nowMs: 1_200,
        windowMs: 10_000,
        eventId: "tg_10",
      }),
    ).toBe(2);
  });

  it("counts inside one object without a binding", async () => {
    const object = new RateWindowObject({} as DurableObjectState, {});
    const key = "f\nlocal\n-100\n5";
    expect(await object.observe({ key, nowMs: 1_000, windowMs: 10_000 })).toBe(
      1,
    );
    expect(await object.observe({ key, nowMs: 1_100, windowMs: 10_000 })).toBe(
      2,
    );
  });

  it("does not call the object for an unusable observation", async () => {
    let calls = 0;
    const namespace: RateWindowNamespace = {
      idFromName(name) {
        return shardId(name);
      },
      get() {
        calls += 1;
        return {
          async observe() {
            return 1;
          },
        };
      },
    };
    const window = createDurableRateWindow(namespace);
    expect(
      await window.observe({ key: "", nowMs: 1, windowMs: 10 }),
    ).toBeNull();
    expect(
      await window.observe({
        key: "f\nlocal\n-100\n5",
        nowMs: Number.NaN,
        windowMs: 10,
      }),
    ).toBeNull();
    expect(
      await window.observe({
        key: "f\nlocal\n-100\n5",
        nowMs: 1,
        windowMs: 0,
      }),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it("stays on the memory window unless RATE_WINDOW is bound", () => {
    expect(rateWindowFromEnv({})).toBeUndefined();
    const bound = rateWindowFromEnv({ RATE_WINDOW: sharedNamespace() });
    expect(bound).toBeDefined();
  });
});
