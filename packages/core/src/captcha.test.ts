import { describe, expect, it } from "vitest";
import {
  addSeconds,
  beginChallenge,
  type CaptchaStore,
  expireChallenges,
  isExpired,
  parseCaptchaChallenge,
  resolveChallenge,
} from "./captcha.js";
import { bindCaptchaStoreContract } from "./captcha-store.contract.js";
import { createFixedClock } from "./clock.js";
import { parseEvent } from "./event.js";
import { createMemoryLogger } from "./logger.js";
import type { BanTarget, MuteTarget, Storage } from "./ports.js";
import { parseAuditRecord } from "./ports.js";

bindCaptchaStoreContract(createReferenceStore);

function createReferenceStore(): CaptchaStore {
  const values = new Map<string, ReturnType<typeof parseCaptchaChallenge>>();
  return {
    async get(tenantId, chatId, actorId) {
      return values.get(key(tenantId, chatId, actorId)) ?? null;
    },
    async put(challenge) {
      const parsed = parseCaptchaChallenge(challenge);
      values.set(key(parsed.tenantId, parsed.chatId, parsed.actorId), parsed);
    },
    async delete(tenantId, chatId, actorId) {
      values.delete(key(tenantId, chatId, actorId));
    },
    async deleteMany(challenges) {
      for (const challenge of challenges) {
        const parsed = parseCaptchaChallenge(challenge);
        values.delete(key(parsed.tenantId, parsed.chatId, parsed.actorId));
      }
    },
    async take(tenantId, chatId, actorId, nonce) {
      const current = values.get(key(tenantId, chatId, actorId));
      if (current === undefined || current.nonce !== nonce) {
        return null;
      }
      values.delete(key(tenantId, chatId, actorId));
      return current;
    },
    async listExpired(nowIso) {
      return [...values.values()].filter((challenge) =>
        isExpired(challenge.expiresAt, nowIso),
      );
    },
  };
}

function key(tenantId: string, chatId: string, actorId: string): string {
  return `${tenantId}\n${chatId}\n${actorId}`;
}

const secret = "请免费领取礼品";

describe("captcha flow", () => {
  it("restricts a join until the button matches", async () => {
    const kit = harness();
    const event = joinEvent();
    await beginChallenge({
      event,
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    expect(kit.restricted).toEqual([
      {
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        durationSeconds: 300,
      },
    ]);
    const passed = await resolveChallenge({
      event: answerEvent("ab".repeat(8)),
      ports: kit.ports,
    });
    expect(passed).toBe("passed");
    expect(kit.released).toEqual([
      { tenantId: "local", chatId: "-100", actorId: "77" },
    ]);
    expect(kit.records.map((record) => record.reasons)).toEqual([
      ["captcha_passed"],
    ]);
    expect(JSON.stringify(kit.records)).not.toContain(secret);
    expect(JSON.stringify(kit.records)).not.toContain('"text"');
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
  });

  it("lets only the first overlapping answer release the member", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    const read = kit.store.get.bind(kit.store);
    let nested = false;
    kit.store.get = async (tenantId, chatId, actorId) => {
      const challenge = await read(tenantId, chatId, actorId);
      if (!nested && challenge !== null) {
        nested = true;
        expect(
          await resolveChallenge({
            event: answerEvent("ab".repeat(8)),
            ports: kit.ports,
          }),
        ).toBe("passed");
      }
      return challenge;
    };
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8)),
        ports: kit.ports,
      }),
    ).toBe("ignored");
    expect(kit.released).toHaveLength(1);
    expect(kit.records).toHaveLength(1);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
  });

  it("puts the challenge back when release fails", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.ports.release = () => Promise.reject(new Error("release_failed"));
    await expect(
      resolveChallenge({
        event: answerEvent("ab".repeat(8)),
        ports: kit.ports,
      }),
    ).rejects.toThrow("release_failed");
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
    });
  });

  it("keeps a newer challenge when release fails", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    const newer = {
      tenantId: "local",
      chatId: "-100",
      actorId: "77",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:10:00.000Z",
    };
    kit.ports.release = async () => {
      await kit.store.put(newer);
      throw new Error("release_failed");
    };
    await expect(
      resolveChallenge({
        event: answerEvent("ab".repeat(8)),
        ports: kit.ports,
      }),
    ).rejects.toThrow("release_failed");
    expect(await kit.store.get("local", "-100", "77")).toEqual(newer);
    expect(kit.records).toEqual([]);
  });

  it("audits a timeout without releasing the member", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    const result = await resolveChallenge({
      event: answerEvent("ab".repeat(8)),
      ports: kit.ports,
    });
    expect(result).toBe("expired");
    expect(kit.released).toEqual([]);
    expect(kit.records[0]?.reasons).toEqual(["captcha_expired"]);
    expect(JSON.stringify(kit.records)).not.toContain(secret);
  });

  it("expires due challenges from the clock", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    expect(await expireChallenges(kit.ports)).toBe(1);
    expect(await expireChallenges(kit.ports)).toBe(0);
    expect(kit.records).toHaveLength(1);
    expect(kit.released).toEqual([]);
  });

  it("retries an expiry when the bulk delete fails", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    const deleteMany = kit.store.deleteMany.bind(kit.store);
    let fail = true;
    kit.store.deleteMany = (challenges) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error(secret));
      }
      return deleteMany(challenges);
    };
    await expect(expireChallenges(kit.ports)).rejects.toThrow(secret);
    expect(kit.records).toHaveLength(1);
    expect(await kit.store.get("local", "-100", "77")).not.toBeNull();
    expect(JSON.stringify(kit.logger.entries)).not.toContain(secret);
    expect(await expireChallenges(kit.ports)).toBe(1);
    expect(kit.records).toHaveLength(1);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
  });

  it("ignores a wrong button and does not log the nonce", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    const result = await resolveChallenge({
      event: answerEvent("cd".repeat(8)),
      ports: kit.ports,
    });
    expect(result).toBe("ignored");
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("cd".repeat(8));
  });

  it("ignores a challenge that was never started", async () => {
    const kit = harness();
    const missing = parseEvent({
      id: "evt_none",
      tenantId: "local",
      chatId: "-100",
      kind: "message",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "77", isAdmin: false },
      message: {
        id: "1",
        text: "hello",
        textSha256: "ab".repeat(32),
      },
    });
    expect(await resolveChallenge({ event: missing, ports: kit.ports })).toBe(
      "ignored",
    );
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8)),
        ports: kit.ports,
      }),
    ).toBe("ignored");
    expect(isExpired("not-a-date", "also-bad")).toBe(true);
    expect(() => addSeconds("not-a-date", 1)).toThrow("clock");
  });

  it("rolls back the challenge when restriction fails", async () => {
    const kit = harness();
    kit.failRestrict = true;
    await expect(
      beginChallenge({
        event: joinEvent(),
        ttlSeconds: 300,
        nonce: "ab".repeat(8),
        ports: kit.ports,
      }),
    ).rejects.toThrow("restrict_failed");
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
    expect(kit.restricted).toEqual([]);
  });
});

function joinEvent() {
  return parseEvent({
    id: "evt_join",
    tenantId: "local",
    chatId: "-100",
    kind: "chat_member",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "77", isAdmin: false },
    membership: "join",
  });
}

function answerEvent(nonce: string) {
  return parseEvent({
    id: "evt_answer",
    tenantId: "local",
    chatId: "-100",
    kind: "challenge",
    occurredAt: "2026-11-01T00:01:00.000Z",
    actor: { id: "77", isAdmin: false },
    challenge: { nonce },
  });
}

function harness() {
  const store = createReferenceStore();
  const records: ReturnType<typeof parseAuditRecord>[] = [];
  const storage: Storage = {
    async appendAudit(record) {
      records.push(parseAuditRecord(record));
    },
    async claimAudit(record) {
      const parsed = parseAuditRecord(record);
      const exists = records.some(
        (item) =>
          item.tenantId === parsed.tenantId &&
          item.chatId === parsed.chatId &&
          item.eventId === parsed.eventId,
      );
      if (exists) {
        return false;
      }
      records.push(parsed);
      return true;
    },
    async putAuditsIfAbsent(input) {
      for (const record of input) {
        const parsed = parseAuditRecord(record);
        const exists = records.some(
          (item) =>
            item.tenantId === parsed.tenantId &&
            item.chatId === parsed.chatId &&
            item.eventId === parsed.eventId,
        );
        if (!exists) {
          records.push(parsed);
        }
      }
    },
    async listAudits() {
      return records;
    },
    async getAudit() {
      return null;
    },
    async exportAudits() {
      return records;
    },
    async countAudits() {
      return records.length;
    },
    async deleteAudits() {
      return 0;
    },
    async getRuleSet() {
      return null;
    },
    async putRuleSet() {},
  };
  const restricted: MuteTarget[] = [];
  const released: BanTarget[] = [];
  const clock = { iso: "2026-11-01T00:00:00.000Z" };
  const state = {
    failRestrict: false,
    restricted,
    released,
    records,
    store,
    logger: createMemoryLogger(),
    clock,
    ports: {
      store,
      storage,
      clock: { nowIso: () => clock.iso },
      logger: createMemoryLogger(),
      async restrict(target: MuteTarget) {
        if (state.failRestrict) {
          throw new Error("restrict_failed");
        }
        restricted.push(target);
      },
      async release(target: BanTarget) {
        released.push(target);
      },
    },
  };
  state.ports.logger = state.logger;
  state.ports.clock = createFixedClock(clock.iso);
  state.ports.clock = { nowIso: () => state.clock.iso };
  return state;
}
