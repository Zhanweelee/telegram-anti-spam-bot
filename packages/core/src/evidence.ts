import { z } from "zod";

export const evidenceKinds = ["keyword", "feature", "hash"] as const;

export const evidenceSchema = z.strictObject({
  kind: z.enum(evidenceKinds),
  summary: z.string().min(1).max(120),
});

export type Evidence = z.output<typeof evidenceSchema>;
