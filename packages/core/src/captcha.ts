import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Event } from "./event.js";
import type { Logger } from "./logger.js";
import {
  type AuditRecord,
  type BanTarget,
  type MuteTarget,
  parseAuditRecord,
  type Storage,
} from "./ports.js";

const isoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const nonceSchema = z.string().regex(/^[a-f0-9]{16}$/);

export const captchaChallengeSchema = z.strictObject({
  tenantId: z.string().min(1),
  chatId: z.string().min(1),
  actorId: z.string().min(1).max(128),
  nonce: nonceSchema,
  expiresAt: isoSchema,
});

export type CaptchaChallenge = z.output<typeof captchaChallengeSchema>;

export interface CaptchaStore {
  get(
    tenantId: string,
    chatId: string,
    actorId: string,
  ): Promise<CaptchaChallenge | null>;
  put(challenge: CaptchaChallenge): Promise<void>;
  delete(tenantId: string, chatId: string, actorId: string): Promise<void>;
  deleteMany(challenges: readonly CaptchaChallenge[]): Promise<void>;
  /**
   * Removes the challenge when the nonce still matches.
   * `null` means another caller already took it, or the nonce differs.
   */
  take(
    tenantId: string,
    chatId: string,
    actorId: string,
    nonce: string,
  ): Promise<CaptchaChallenge | null>;
  listExpired(nowIso: string): Promise<readonly CaptchaChallenge[]>;
}

export interface CaptchaPorts {
  readonly store: CaptchaStore;
  readonly storage: Storage;
  readonly restrict: (target: MuteTarget) => Promise<void>;
  readonly release: (target: BanTarget) => Promise<void>;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function parseCaptchaChallenge(input: unknown): CaptchaChallenge {
  return captchaChallengeSchema.parse(input);
}

export function addSeconds(iso: string, seconds: number): string {
  const start = Date.parse(iso);
  if (Number.isNaN(start)) {
    throw new Error("clock");
  }
  return new Date(start + seconds * 1000).toISOString();
}

export function isExpired(expiresAt: string, nowIso: string): boolean {
  const expiry = Date.parse(expiresAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(expiry) || Number.isNaN(now)) {
    return true;
  }
  return expiry <= now;
}

export async function beginChallenge(input: {
  readonly event: Event;
  readonly ttlSeconds: number;
  readonly nonce: string;
  readonly ports: CaptchaPorts;
}): Promise<CaptchaChallenge> {
  const nowIso = input.ports.clock.nowIso();
  const challenge = parseCaptchaChallenge({
    tenantId: input.event.tenantId,
    chatId: input.event.chatId,
    actorId: input.event.actor.id,
    nonce: input.nonce,
    expiresAt: addSeconds(nowIso, input.ttlSeconds),
  });
  await input.ports.store.put(challenge);
  try {
    await input.ports.restrict({
      tenantId: challenge.tenantId,
      chatId: challenge.chatId,
      actorId: challenge.actorId,
      durationSeconds: input.ttlSeconds,
    });
  } catch (error) {
    await input.ports.store.delete(
      challenge.tenantId,
      challenge.chatId,
      challenge.actorId,
    );
    throw error;
  }
  return challenge;
}

export async function resolveChallenge(input: {
  readonly event: Event;
  readonly ports: CaptchaPorts;
}): Promise<"passed" | "expired" | "ignored"> {
  const nonce = input.event.challenge?.nonce;
  if (!nonce) {
    return "ignored";
  }
  const challenge = await input.ports.store.get(
    input.event.tenantId,
    input.event.chatId,
    input.event.actor.id,
  );
  if (!challenge) {
    return "ignored";
  }
  const nowIso = input.ports.clock.nowIso();
  if (isExpired(challenge.expiresAt, nowIso)) {
    await expireOne(challenge, input.ports, nowIso, input.event.id);
    return "expired";
  }
  if (challenge.nonce !== nonce) {
    input.ports.logger.warn("captcha_mismatch", {
      eventId: input.event.id,
      chatId: input.event.chatId,
    });
    return "ignored";
  }
  const taken = await input.ports.store.take(
    challenge.tenantId,
    challenge.chatId,
    challenge.actorId,
    challenge.nonce,
  );
  if (!taken) {
    return "ignored";
  }
  try {
    await input.ports.release({
      tenantId: taken.tenantId,
      chatId: taken.chatId,
      actorId: taken.actorId,
    });
  } catch (error) {
    const current = await input.ports.store.get(
      taken.tenantId,
      taken.chatId,
      taken.actorId,
    );
    if (current === null) {
      await input.ports.store.put(taken);
    }
    throw error;
  }
  await writeAudit(input.ports.storage, {
    tenantId: taken.tenantId,
    chatId: taken.chatId,
    eventId: input.event.id,
    reason: "captcha_passed",
    summary: "captcha:passed",
    createdAt: nowIso,
  });
  input.ports.logger.info("captcha_passed", {
    eventId: input.event.id,
    chatId: input.event.chatId,
  });
  return "passed";
}

export async function expireChallenges(ports: CaptchaPorts): Promise<number> {
  const nowIso = ports.clock.nowIso();
  const due = await ports.store.listExpired(nowIso);
  if (due.length === 0) {
    return 0;
  }
  await ports.storage.putAuditsIfAbsent(
    due.map((challenge) =>
      expiryAudit(challenge, nowIso, expiredEventId(challenge)),
    ),
  );
  await ports.store.deleteMany(due);
  for (const challenge of due) {
    ports.logger.info("captcha_expired", {
      eventId: expiredEventId(challenge),
      chatId: challenge.chatId,
    });
  }
  return due.length;
}

async function expireOne(
  challenge: CaptchaChallenge,
  ports: CaptchaPorts,
  nowIso: string,
  eventId: string,
): Promise<void> {
  await ports.storage.putAuditsIfAbsent([
    expiryAudit(challenge, nowIso, eventId),
  ]);
  await ports.store.delete(
    challenge.tenantId,
    challenge.chatId,
    challenge.actorId,
  );
  ports.logger.info("captcha_expired", {
    eventId,
    chatId: challenge.chatId,
  });
}

function expiryAudit(
  challenge: CaptchaChallenge,
  nowIso: string,
  eventId: string,
): AuditRecord {
  return parseAuditRecord({
    tenantId: challenge.tenantId,
    chatId: challenge.chatId,
    eventId,
    action: "captcha",
    score: 1,
    reasons: ["captcha_expired"],
    evidence: [{ kind: "feature", summary: "captcha:expired" }],
    ruleIds: ["new_member"],
    createdAt: nowIso,
  });
}

function expiredEventId(challenge: CaptchaChallenge): string {
  const stamp = String(Date.parse(challenge.expiresAt));
  return `captcha_expired_${challenge.actorId}_${stamp}`.slice(0, 128);
}

async function writeAudit(
  storage: Storage,
  input: {
    readonly tenantId: string;
    readonly chatId: string;
    readonly eventId: string;
    readonly reason: string;
    readonly summary: string;
    readonly createdAt: string;
  },
): Promise<void> {
  await storage.appendAudit(
    parseAuditRecord({
      tenantId: input.tenantId,
      chatId: input.chatId,
      eventId: input.eventId,
      action: "captcha",
      score: 1,
      reasons: [input.reason],
      evidence: [{ kind: "feature", summary: input.summary }],
      ruleIds: ["new_member"],
      createdAt: input.createdAt,
    }),
  );
}
