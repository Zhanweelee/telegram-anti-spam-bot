import { z } from "zod";
import type { Event } from "./event.js";

/** Same upper bound as an actor id on `Event`. */
export const MAX_ACTOR_ID_LENGTH = 128;
/** Caps a single chat allowlist so one write stays small. */
export const MAX_ALLOW_ACTOR_IDS = 200;

export const prefilterPolicySchema = z.strictObject({
  exemptAdmins: z.boolean(),
  allowActorIds: z
    .array(z.string().min(1).max(MAX_ACTOR_ID_LENGTH))
    .max(MAX_ALLOW_ACTOR_IDS),
});

export type PrefilterPolicy = z.output<typeof prefilterPolicySchema>;
export type ExemptReason = "admin" | "allowlist";

export function prefilter(
  event: Event,
  policy: PrefilterPolicy,
): ExemptReason | null {
  if (policy.exemptAdmins && event.actor.isAdmin) {
    return "admin";
  }
  if (policy.allowActorIds.includes(event.actor.id)) {
    return "allowlist";
  }
  return null;
}
