import {
  type AuditRecord,
  type AuditScope,
  auditRecordSchema,
  parseAuditQuery,
  parseAuditRecord,
  parseAuditScope,
  parseRuleSet,
  type RuleSet,
  ruleSetSchema,
  type Storage,
} from "@tasb/core";

/**
 * Narrow SQL surface. D1 satisfies it through a wrapper in the worker.
 * This module does not import Workers types.
 */
export interface SqlPrepared {
  bind(...values: readonly (string | number | null)[]): SqlPrepared;
  all(): Promise<{ readonly results?: readonly Record<string, unknown>[] }>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(sql: string): SqlPrepared;
}

export const storageMigrationStatements = [
  `CREATE TABLE IF NOT EXISTS audits (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  message_id TEXT,
  text_sha256 TEXT,
  action TEXT NOT NULL,
  score REAL NOT NULL,
  reasons TEXT NOT NULL,
  evidence TEXT NOT NULL,
  rule_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, chat_id, event_id)
)`,
  `CREATE TABLE IF NOT EXISTS rule_sets (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  document TEXT NOT NULL,
  PRIMARY KEY (tenant_id, chat_id)
)`,
] as const;

const insertAuditSql = `INSERT INTO audits (
  tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const listAuditsSql = `SELECT tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
FROM audits
WHERE tenant_id = ?
ORDER BY rowid ASC
LIMIT ?`;

const listAuditsInChatSql = `SELECT tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
FROM audits
WHERE tenant_id = ? AND chat_id = ?
ORDER BY rowid ASC
LIMIT ?`;

const deleteAuditsSql = "DELETE FROM audits WHERE tenant_id = ?";

const deleteAuditsInChatSql =
  "DELETE FROM audits WHERE tenant_id = ? AND chat_id = ?";

const exportPageSize = 100;

const exportAuditsSql = `SELECT rowid AS audit_rowid, tenant_id, chat_id, event_id,
  message_id, text_sha256, action, score, reasons, evidence, rule_ids, created_at
FROM audits
WHERE tenant_id = ? AND rowid > ?
ORDER BY rowid ASC
LIMIT ${exportPageSize}`;

const exportAuditsInChatSql = `SELECT rowid AS audit_rowid, tenant_id, chat_id, event_id,
  message_id, text_sha256, action, score, reasons, evidence, rule_ids, created_at
FROM audits
WHERE tenant_id = ? AND chat_id = ? AND rowid > ?
ORDER BY rowid ASC
LIMIT ${exportPageSize}`;

const readRuleSql = `SELECT document FROM rule_sets
WHERE tenant_id = ? AND chat_id = ?`;

const upsertRuleSql = `INSERT INTO rule_sets (tenant_id, chat_id, document)
VALUES (?, ?, ?)
ON CONFLICT(tenant_id, chat_id) DO UPDATE SET document = excluded.document`;

const migrations = new WeakMap<SqlDatabase, Promise<void>>();

export async function applyStorageMigrations(db: SqlDatabase): Promise<void> {
  for (const statement of storageMigrationStatements) {
    await db.prepare(statement).run();
  }
}

export function createD1Storage(db: SqlDatabase): Storage {
  return {
    async appendAudit(record) {
      await migrationsFor(db);
      const parsed = parseAuditRecord(record);
      await db
        .prepare(insertAuditSql)
        .bind(...auditValues(parsed))
        .run();
    },
    async listAudits(query) {
      await migrationsFor(db);
      const parsed = parseAuditQuery(query);
      const rows =
        parsed.chatId === undefined
          ? await db
              .prepare(listAuditsSql)
              .bind(parsed.tenantId, parsed.limit)
              .all()
          : await db
              .prepare(listAuditsInChatSql)
              .bind(parsed.tenantId, parsed.chatId, parsed.limit)
              .all();
      const audits: AuditRecord[] = [];
      for (const row of rows.results ?? []) {
        const audit = readAudit(row);
        if (audit) {
          audits.push(audit);
        }
      }
      return audits;
    },
    async exportAudits(scope) {
      await migrationsFor(db);
      return exportMatching(db, scope);
    },
    async deleteAudits(scope) {
      await migrationsFor(db);
      const parsed = parseAuditScope(scope);
      if (parsed.chatId === undefined) {
        await db.prepare(deleteAuditsSql).bind(parsed.tenantId).run();
        return;
      }
      await db
        .prepare(deleteAuditsInChatSql)
        .bind(parsed.tenantId, parsed.chatId)
        .run();
    },
    async getRuleSet(tenantId, chatId) {
      await migrationsFor(db);
      const rows = await db.prepare(readRuleSql).bind(tenantId, chatId).all();
      const document = rows.results?.[0]?.document;
      return readRuleSet(document);
    },
    async putRuleSet(tenantId, chatId, rules) {
      await migrationsFor(db);
      const parsed = parseRuleSet(rules);
      await db
        .prepare(upsertRuleSql)
        .bind(tenantId, chatId, JSON.stringify(parsed))
        .run();
    },
  };
}

function migrationsFor(db: SqlDatabase): Promise<void> {
  const existing = migrations.get(db);
  if (existing) {
    return existing;
  }
  const pending = applyStorageMigrations(db).catch((error: unknown) => {
    migrations.delete(db);
    throw error;
  });
  migrations.set(db, pending);
  return pending;
}

async function exportMatching(
  db: SqlDatabase,
  scope: AuditScope,
): Promise<AuditRecord[]> {
  const parsed = parseAuditScope(scope);
  const audits: AuditRecord[] = [];
  let after = 0;
  for (;;) {
    const rows =
      parsed.chatId === undefined
        ? await db.prepare(exportAuditsSql).bind(parsed.tenantId, after).all()
        : await db
            .prepare(exportAuditsInChatSql)
            .bind(parsed.tenantId, parsed.chatId, after)
            .all();
    const page = rows.results ?? [];
    if (page.length === 0) {
      return audits;
    }
    let next = after;
    for (const row of page) {
      const rowId = readRowId(row.audit_rowid);
      if (rowId !== null && rowId > next) {
        next = rowId;
      }
      const audit = readAudit(row);
      if (audit) {
        audits.push(audit);
      }
    }
    if (next === after || page.length < exportPageSize) {
      return audits;
    }
    after = next;
  }
}

function readRowId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  return null;
}

function auditValues(record: AuditRecord): readonly (string | number | null)[] {
  return [
    record.tenantId,
    record.chatId,
    record.eventId,
    record.messageId ?? null,
    record.textSha256 ?? null,
    record.action,
    record.score,
    JSON.stringify(record.reasons),
    JSON.stringify(record.evidence),
    JSON.stringify(record.ruleIds),
    record.createdAt,
  ];
}

function readAudit(row: Record<string, unknown>): AuditRecord | null {
  const reasons = readJson(row.reasons);
  const evidence = readJson(row.evidence);
  const ruleIds = readJson(row.rule_ids);
  if (
    reasons === undefined ||
    evidence === undefined ||
    ruleIds === undefined
  ) {
    return null;
  }
  const parsed = auditRecordSchema.safeParse({
    tenantId: row.tenant_id,
    chatId: row.chat_id,
    eventId: row.event_id,
    ...(typeof row.message_id === "string"
      ? { messageId: row.message_id }
      : {}),
    ...(typeof row.text_sha256 === "string"
      ? { textSha256: row.text_sha256 }
      : {}),
    action: row.action,
    score: row.score,
    reasons,
    evidence,
    ruleIds,
    createdAt: row.created_at,
  });
  return parsed.success ? parsed.data : null;
}

function readRuleSet(document: unknown): RuleSet | null {
  if (typeof document !== "string") {
    return null;
  }
  const parsedJson = readJson(document);
  if (parsedJson === undefined) {
    return null;
  }
  const parsed = ruleSetSchema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}

function readJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
