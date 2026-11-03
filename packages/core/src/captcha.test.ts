import { describe, expect, it } from "vitest";
import {
  addSeconds,
  beginChallenge,
  type CaptchaStore,
  cancelChallenge,
  captchaChallengeSchema,
  expireChallenges,
  isExpired,
  parseCaptchaChallenge,
  resolveChallenge,
  supersedeChallenge,
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
    async takeMany(challenges) {
      const taken: ReturnType<typeof parseCaptchaChallenge>[] = [];
      for (const challenge of challenges) {
        const parsed = parseCaptchaChallenge(challenge);
        const current = values.get(
          key(parsed.tenantId, parsed.chatId, parsed.actorId),
        );
        if (current === undefined || current.nonce !== parsed.nonce) {
          continue;
        }
        values.delete(key(parsed.tenantId, parsed.chatId, parsed.actorId));
        taken.push(current);
      }
      return taken;
    },
    async attachPrompt(tenantId, chatId, actorId, nonce, messageId) {
      const current = values.get(key(tenantId, chatId, actorId));
      if (current === undefined || current.nonce !== nonce) {
        return false;
      }
      const parsed = captchaChallengeSchema.safeParse({
        ...current,
        messageId,
      });
      if (!parsed.success || parsed.data.messageId === undefined) {
        return false;
      }
      values.set(key(tenantId, chatId, actorId), parsed.data);
      return true;
    },
    async findByNonce(tenantId, chatId, nonce) {
      for (const challenge of values.values()) {
        if (
          challenge.tenantId === tenantId &&
          challenge.chatId === chatId &&
          challenge.nonce === nonce
        ) {
          return challenge;
        }
      }
      return null;
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

  it("deletes the previous prompt when a new join replaces the challenge", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "cd".repeat(8),
      ports,
    });
    expect(removed).toEqual(["42"]);
    const saved = await kit.store.get("local", "-100", "77");
    expect(saved).toMatchObject({ nonce: "cd".repeat(8) });
    expect(saved?.messageId).toBeUndefined();
    expect(kit.restricted).toHaveLength(2);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("keeps the new challenge when the old prompt cannot be deleted", async () => {
    const kit = harness();
    const ports = {
      ...kit.ports,
      async removePrompt() {
        throw new Error(secret);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "cd".repeat(8),
      ports,
    });
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "cd".repeat(8),
    });
    expect(kit.restricted).toHaveLength(2);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(secret);
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_delete_failed",
      ),
    ).toBe(true);
  });

  it("deletes the prompt and the challenge when the member leaves", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await cancelChallenge({
        event: leaveEvent(),
        ports,
      }),
    ).toBe(true);
    expect(removed).toEqual(["42"]);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(kit.logger.entries).toEqual([
      {
        level: "info",
        message: "captcha_left",
        fields: { eventId: "evt_leave", chatId: "-100" },
      },
    ]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ab".repeat(8));
  });

  it("keeps the challenge when the leave cannot delete the prompt", async () => {
    const kit = harness();
    const ports = {
      ...kit.ports,
      async removePrompt() {
        throw new Error(secret);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await cancelChallenge({
        event: leaveEvent(),
        ports,
      }),
    ).toBe(false);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(kit.logger.entries.map((entry) => entry.message)).toEqual([
      "captcha_prompt_delete_failed",
    ]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(secret);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("keeps a stored prompt when leave has no delete port", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await cancelChallenge({
        event: leaveEvent(),
        ports: kit.ports,
      }),
    ).toBe(false);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      messageId: "42",
    });
    expect(kit.logger.entries).toEqual([]);
  });

  it("drops a prompt-less challenge when the member leaves", async () => {
    const kit = harness();
    let calls = 0;
    const ports = {
      ...kit.ports,
      async removePrompt() {
        calls += 1;
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    expect(
      await cancelChallenge({
        event: leaveEvent(),
        ports,
      }),
    ).toBe(true);
    expect(calls).toBe(0);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
  });

  it("leaves the row in place when the member is still in the chat", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await cancelChallenge({
        event: joinEvent(),
        ports,
      }),
    ).toBe(false);
    expect(
      await cancelChallenge({
        event: leaveEvent("evt_other", "88"),
        ports,
      }),
    ).toBe(false);
    expect(removed).toEqual([]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(kit.logger.entries).toEqual([]);
  });

  it("deletes the prompt when a heavier join replaces captcha", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await supersedeChallenge({
        event: joinEvent("evt_ban"),
        ports,
      }),
    ).toBe(true);
    expect(removed).toEqual(["42"]);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
    expect(kit.released).toEqual([]);
    expect(kit.restricted).toHaveLength(1);
    expect(kit.records).toEqual([]);
    expect(kit.logger.entries).toEqual([
      {
        level: "info",
        message: "captcha_superseded",
        fields: { eventId: "evt_ban", chatId: "-100" },
      },
    ]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ab".repeat(8));
  });

  it("keeps the challenge when a heavier join cannot delete the prompt", async () => {
    const kit = harness();
    const ports = {
      ...kit.ports,
      async removePrompt() {
        throw new Error(secret);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await supersedeChallenge({
        event: joinEvent("evt_ban"),
        ports,
      }),
    ).toBe(false);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(kit.logger.entries.map((entry) => entry.message)).toEqual([
      "captcha_prompt_delete_failed",
    ]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(secret);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
  });

  it("leaves the challenge when the event is not a join", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await supersedeChallenge({
        event: leaveEvent(),
        ports,
      }),
    ).toBe(false);
    expect(removed).toEqual([]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      messageId: "42",
    });
    expect(kit.logger.entries).toEqual([]);
  });

  it("deletes the old prompt when the replacement restrict fails", async () => {
    const kit = harness();
    const removed: string[] = [];
    let calls = 0;
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
      async restrict(target: MuteTarget) {
        calls += 1;
        if (calls > 1) {
          throw new Error("restrict_failed");
        }
        kit.restricted.push(target);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    await expect(
      beginChallenge({
        event: joinEvent(),
        ttlSeconds: 300,
        nonce: "cd".repeat(8),
        ports,
      }),
    ).rejects.toThrow("restrict_failed");
    expect(removed).toEqual(["42"]);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
  });

  it("deletes the clicked button and the stored button after a pass", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8), "43"),
        ports,
      }),
    ).toBe("passed");
    expect(removed).toEqual(["42", "43"]);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
    expect(kit.released).toHaveLength(1);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("43");
    expect(JSON.stringify(kit.records)).not.toContain("43");
  });

  it("deletes a stale button when the nonce does not match", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await resolveChallenge({
        event: answerEvent("cd".repeat(8), "43"),
        ports,
      }),
    ).toBe("ignored");
    expect(removed).toEqual(["43"]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("43");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("cd".repeat(8));
  });

  it("deletes the clicker's other button when that nonce is still theirs", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    kit.clock.iso = "2026-11-01T00:06:00.000Z";
    kit.store.take = async () => null;
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8), "43"),
        ports,
      }),
    ).toBe("ignored");
    expect(removed).toEqual(["43"]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(JSON.stringify(kit.logger.entries)).not.toContain("43");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ab".repeat(8));
  });

  it("keeps a live button owned by someone else", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    await kit.store.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "88",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
      messageId: "43",
    });
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8), "42", "88"),
        ports,
      }),
    ).toBe("ignored");
    expect(removed).toEqual([]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(await kit.store.get("local", "-100", "88")).toMatchObject({
      nonce: "cd".repeat(8),
      messageId: "43",
    });
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ab".repeat(8));
  });

  it("expires the clicker without deleting someone else's live button", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    await kit.store.put({
      tenantId: "local",
      chatId: "-100",
      actorId: "88",
      nonce: "cd".repeat(8),
      expiresAt: "2026-11-01T00:00:30.000Z",
      messageId: "43",
    });
    kit.clock.iso = "2026-11-01T00:01:00.000Z";
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8), "42", "88"),
        ports,
      }),
    ).toBe("expired");
    expect(removed).toEqual(["43"]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(await kit.store.get("local", "-100", "88")).toBeNull();
    expect(kit.released).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ab".repeat(8));
  });

  it("keeps the button when the clicker has no challenge", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8), "42", "88"),
        ports,
      }),
    ).toBe("ignored");
    expect(removed).toEqual([]);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "ab".repeat(8),
      messageId: "42",
    });
    expect(kit.released).toEqual([]);
    expect(kit.records).toEqual([]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("42");
    expect(JSON.stringify(kit.logger.entries)).not.toContain("ab".repeat(8));
  });

  it("passes when the clicked button cannot be deleted", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8), "43"),
        ports: kit.ports,
      }),
    ).toBe("passed");
    expect(kit.released).toHaveLength(1);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
    expect(kit.records[0]?.reasons).toEqual(["captcha_passed"]);
  });

  it("deletes the prompt after a pass and after an expiry", async () => {
    const kit = harness();
    const removed: string[] = [];
    const ports = {
      ...kit.ports,
      async removePrompt(target: { messageId: string }) {
        removed.push(target.messageId);
      },
    };
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports,
    });
    expect(
      await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42"),
    ).toBe(true);
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8)),
        ports,
      }),
    ).toBe("passed");
    expect(removed).toEqual(["42"]);
    expect(JSON.stringify(kit.records)).not.toContain("42");

    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "cd".repeat(8),
      ports,
    });
    expect(
      await kit.store.attachPrompt("local", "-100", "77", "cd".repeat(8), "43"),
    ).toBe(true);
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    expect(await expireChallenges(ports)).toBe(1);
    expect(removed).toEqual(["42", "43"]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain("43");
  });

  it("keeps a pass when deleting the prompt fails", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 300,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    await kit.store.attachPrompt("local", "-100", "77", "ab".repeat(8), "42");
    const result = await resolveChallenge({
      event: answerEvent("ab".repeat(8)),
      ports: {
        ...kit.ports,
        async removePrompt() {
          throw new Error(secret);
        },
      },
    });
    expect(result).toBe("passed");
    expect(kit.records[0]?.reasons).toEqual(["captcha_passed"]);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(secret);
    expect(
      kit.logger.entries.some(
        (entry) => entry.message === "captcha_prompt_delete_failed",
      ),
    ).toBe(true);
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

  it("retries an expiry when the take fails", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    const takeMany = kit.store.takeMany.bind(kit.store);
    let fail = true;
    kit.store.takeMany = (challenges) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error(secret));
      }
      return takeMany(challenges);
    };
    await expect(expireChallenges(kit.ports)).rejects.toThrow(secret);
    expect(kit.records).toHaveLength(0);
    expect(await kit.store.get("local", "-100", "77")).not.toBeNull();
    expect(JSON.stringify(kit.logger.entries)).not.toContain(secret);
    expect(await expireChallenges(kit.ports)).toBe(1);
    expect(kit.records).toHaveLength(1);
    expect(await kit.store.get("local", "-100", "77")).toBeNull();
  });

  it("leaves a newer challenge when an older nonce expires", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    const listExpired = kit.store.listExpired.bind(kit.store);
    kit.store.listExpired = async (nowIso) => {
      const due = await listExpired(nowIso);
      await kit.store.put({
        tenantId: "local",
        chatId: "-100",
        actorId: "77",
        nonce: "cd".repeat(8),
        expiresAt: "2026-11-01T00:10:00.000Z",
      });
      return due;
    };
    expect(await expireChallenges(kit.ports)).toBe(0);
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "cd".repeat(8),
    });
    expect(kit.records).toEqual([]);
    expect(kit.released).toEqual([]);
  });

  it("leaves a newer challenge when a late button sees the old nonce", async () => {
    const kit = harness();
    await beginChallenge({
      event: joinEvent(),
      ttlSeconds: 60,
      nonce: "ab".repeat(8),
      ports: kit.ports,
    });
    kit.clock.iso = "2026-11-01T00:02:00.000Z";
    const read = kit.store.get.bind(kit.store);
    let nested = false;
    kit.store.get = async (tenantId, chatId, actorId) => {
      const challenge = await read(tenantId, chatId, actorId);
      if (!nested && challenge !== null) {
        nested = true;
        await kit.store.put({
          tenantId: "local",
          chatId: "-100",
          actorId: "77",
          nonce: "cd".repeat(8),
          expiresAt: "2026-11-01T00:10:00.000Z",
        });
      }
      return challenge;
    };
    expect(
      await resolveChallenge({
        event: answerEvent("ab".repeat(8)),
        ports: kit.ports,
      }),
    ).toBe("ignored");
    expect(await kit.store.get("local", "-100", "77")).toMatchObject({
      nonce: "cd".repeat(8),
    });
    expect(kit.records).toEqual([]);
    expect(kit.released).toEqual([]);
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

function joinEvent(id = "evt_join") {
  return parseEvent({
    id,
    tenantId: "local",
    chatId: "-100",
    kind: "chat_member",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "77", isAdmin: false },
    membership: "join",
  });
}

function leaveEvent(id = "evt_leave", actorId = "77") {
  return parseEvent({
    id,
    tenantId: "local",
    chatId: "-100",
    kind: "chat_member",
    occurredAt: "2026-11-01T00:00:10.000Z",
    actor: { id: actorId, isAdmin: false },
    membership: "leave",
  });
}

function answerEvent(nonce: string, messageId?: string, actorId = "77") {
  return parseEvent({
    id: "evt_answer",
    tenantId: "local",
    chatId: "-100",
    kind: "challenge",
    occurredAt: "2026-11-01T00:01:00.000Z",
    actor: { id: actorId, isAdmin: false },
    challenge: messageId ? { nonce, messageId } : { nonce },
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
