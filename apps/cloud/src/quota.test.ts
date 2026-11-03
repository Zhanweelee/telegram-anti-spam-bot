import { quotaSnapshotSchema, type RuleSet } from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  createMemoryQuotaStore,
  defaultBasicDetectorIds,
  defaultQuotaLimit,
  degradeRules,
  quotaPolicyFromEnv,
} from "./quota.js";

const rules: RuleSet = {
  version: 1,
  aggregate: "max",
  rules: [
    {
      id: "spam_keywords",
      enabled: true,
      detectorIds: ["keyword"],
      threshold: 1,
      actions: ["delete"],
    },
    {
      id: "llm_hint",
      enabled: true,
      detectorIds: ["llm"],
      threshold: 1,
      actions: ["delete"],
    },
  ],
};

describe("quotaPolicyFromEnv", () => {
  it("stays off for self-host and on for cloud", () => {
    expect(quotaPolicyFromEnv({}).enabled).toBe(false);
    expect(quotaPolicyFromEnv({ DEPLOYMENT_MODE: "self-host" }).enabled).toBe(
      false,
    );
    const cloud = quotaPolicyFromEnv({ DEPLOYMENT_MODE: "cloud" });
    expect(cloud.enabled).toBe(true);
    expect(cloud.limit).toBe(defaultQuotaLimit);
    expect(cloud.period).toBe("calendar_month");
    expect(cloud.basicDetectorIds).toEqual([...defaultBasicDetectorIds]);
    expect(cloud.basicDetectorIds).not.toContain("llm");
  });

  it("accepts explicit overrides and ignores invalid values", () => {
    const custom = quotaPolicyFromEnv({
      DEPLOYMENT_MODE: "cloud",
      QUOTA_ENABLED: "false",
      QUOTA_LIMIT: "50",
      QUOTA_PERIOD: "rolling_30d",
      QUOTA_BASIC: "keyword,Nope,keyword",
    });
    expect(custom.enabled).toBe(false);
    expect(custom.limit).toBe(50);
    expect(custom.period).toBe("rolling_30d");
    expect(custom.basicDetectorIds).toEqual(["keyword"]);
    const fallback = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "0",
      QUOTA_PERIOD: "weekly",
      QUOTA_BASIC: "Nope",
    });
    expect(fallback.enabled).toBe(true);
    expect(fallback.limit).toBe(defaultQuotaLimit);
    expect(fallback.period).toBe("calendar_month");
    expect(fallback.basicDetectorIds).toEqual([...defaultBasicDetectorIds]);
  });
});

describe("degradeRules", () => {
  it("keeps rules whose detectors are all basic", () => {
    const next = degradeRules(rules, ["keyword"]);
    expect(next.rules.map((rule) => rule.id)).toEqual(["spam_keywords"]);
  });
});

describe("createMemoryQuotaStore", () => {
  const policy = quotaPolicyFromEnv({
    QUOTA_ENABLED: "true",
    QUOTA_LIMIT: "1",
  });

  it("degrades on the next check and resets with the UTC month", async () => {
    const store = createMemoryQuotaStore();
    const january = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-01-31T23:00:00.000Z",
      policy,
    };
    const first = await store.consume(january);
    expect(first).toMatchObject({ used: 1, degraded: false });
    expect(first?.resetsAt).toBe("2026-02-01T00:00:00.000Z");
    expect(quotaSnapshotSchema.safeParse(first).success).toBe(true);
    const second = await store.consume(january);
    expect(second).toMatchObject({ used: 2, degraded: true });
    const other = await store.consume({ ...january, chatId: "-200" });
    expect(other).toMatchObject({ used: 1, degraded: false });
    const february = await store.consume({
      ...january,
      atIso: "2026-02-01T00:00:00.000Z",
    });
    expect(february).toMatchObject({ used: 1, degraded: false });
    expect(february?.resetsAt).toBe("2026-03-01T00:00:00.000Z");
    expect(await store.read(january)).toMatchObject({
      used: 0,
      degraded: false,
    });
    expect(
      await store.read({
        ...january,
        atIso: "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({ used: 1, degraded: false });
    const unread = await store.read({
      tenantId: "local",
      chatId: "-300",
      atIso: "2026-12-15T12:00:00.000Z",
      policy,
    });
    expect(unread).toMatchObject({
      used: 0,
      resetsAt: "2027-01-01T00:00:00.000Z",
    });
  });

  it("counts one event id once until it leaves the recent window", async () => {
    const store = createMemoryQuotaStore();
    const wide = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "100",
    });
    const usage = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-01-15T00:00:00.000Z",
      policy: wide,
      eventId: "tg_0",
    };
    expect(await store.consume(usage)).toMatchObject({ used: 1 });
    expect(await store.consume(usage)).toMatchObject({
      used: 1,
      degraded: false,
    });
    expect(await store.consume({ ...usage, eventId: "tg_1" })).toMatchObject({
      used: 2,
    });
    expect(
      await store.read({
        tenantId: "local",
        chatId: "-100",
        atIso: usage.atIso,
        policy: wide,
      }),
    ).toMatchObject({ used: 2 });
    const huge = "x".repeat(129);
    expect(await store.consume({ ...usage, eventId: huge })).toMatchObject({
      used: 3,
    });
    expect(await store.consume({ ...usage, eventId: huge })).toMatchObject({
      used: 4,
    });
    for (let index = 1; index <= 64; index += 1) {
      await store.consume({ ...usage, eventId: `tg_${index}` });
    }
    expect(await store.consume(usage)).toMatchObject({ used: 68 });
    expect(
      await store.consume({
        ...usage,
        atIso: "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({ used: 1, degraded: false });
  });

  it("resets a rolling window after 30 days", async () => {
    const rolling = quotaPolicyFromEnv({
      QUOTA_ENABLED: "true",
      QUOTA_LIMIT: "1",
      QUOTA_PERIOD: "rolling_30d",
    });
    const store = createMemoryQuotaStore();
    const start = {
      tenantId: "local",
      chatId: "-100",
      atIso: "2026-01-01T00:00:00.000Z",
      policy: rolling,
    };
    const opened = await store.consume(start);
    expect(opened).toMatchObject({ degraded: false });
    expect(opened?.resetsAt).toBe("2026-01-31T00:00:00.000Z");
    const fresh = await store.read({ ...start, chatId: "-300" });
    expect(fresh).toMatchObject({ used: 0 });
    expect(fresh && "resetsAt" in fresh).toBe(false);
    expect(
      await store.consume({
        ...start,
        atIso: "2026-01-30T23:59:59.000Z",
      }),
    ).toMatchObject({ used: 2, degraded: true });
    expect(
      await store.consume({
        ...start,
        atIso: "2026-01-31T00:00:00.000Z",
      }),
    ).toMatchObject({ used: 1, degraded: false });
  });

  it("does not count when disabled and fails open when full or undated", async () => {
    const store = createMemoryQuotaStore({ maxChats: 1 });
    const off = quotaPolicyFromEnv({ QUOTA_ENABLED: "false" });
    expect(
      await store.consume({
        tenantId: "local",
        chatId: "-100",
        atIso: "2026-01-01T00:00:00.000Z",
        policy: off,
      }),
    ).toMatchObject({ enabled: false, used: 0 });
    expect(
      await store.read({
        tenantId: "local",
        chatId: "-100",
        atIso: "2026-01-01T00:00:00.000Z",
        policy: off,
      }),
    ).not.toHaveProperty("resetsAt");
    expect(
      await store.consume({
        tenantId: "local",
        chatId: "-100",
        atIso: "not-a-date",
        policy,
      }),
    ).toBeNull();
    expect(
      await store.consume({
        tenantId: "local",
        chatId: "-100",
        atIso: "2026-01-01T00:00:00.000Z",
        policy,
      }),
    ).toMatchObject({ used: 1 });
    expect(
      await store.consume({
        tenantId: "local",
        chatId: "-200",
        atIso: "2026-01-01T00:00:00.000Z",
        policy,
      }),
    ).toBeNull();
  });
});
