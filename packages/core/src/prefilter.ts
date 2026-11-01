import { z } from "zod";
import type { Event } from "./event.js";

export const prefilterPolicySchema = z.strictObject({
  exemptAdmins: z.boolean(),
  allowActorIds: z.array(z.string().min(1)),
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
