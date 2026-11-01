import { z } from "zod";
import { decisionActionSchema } from "./decision.js";
import { evidenceSchema } from "./evidence.js";
import type { RuleSet } from "./rule.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

export const auditRecordSchema = z.strictObject({
  tenantId: z.string().min(1),
  chatId: z.string().min(1),
  eventId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  textSha256: sha256Schema.optional(),
  action: decisionActionSchema,
  score: z.number().min(0),
  reasons: z.array(z.string()),
  evidence: z.array(evidenceSchema),
  ruleIds: z.array(z.string()),
  createdAt: isoSchema,
});

export type AuditRecord = z.output<typeof auditRecordSchema>;

export const auditQuerySchema = z.strictObject({
  tenantId: z.string().min(1),
  chatId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100),
});

export type AuditQuery = z.output<typeof auditQuerySchema>;

export interface Storage {
  appendAudit(record: AuditRecord): Promise<void>;
  listAudits(query: AuditQuery): Promise<readonly AuditRecord[]>;
  getRuleSet(tenantId: string, chatId: string): Promise<RuleSet | null>;
  putRuleSet(tenantId: string, chatId: string, rules: RuleSet): Promise<void>;
}

export interface DeleteTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly messageId: string;
}

export interface ModerationPort {
  deleteMessage(target: DeleteTarget): Promise<void>;
}

export function parseAuditRecord(input: unknown): AuditRecord {
  return auditRecordSchema.parse(input);
}

export function parseAuditQuery(input: unknown): AuditQuery {
  return auditQuerySchema.parse(input);
}
