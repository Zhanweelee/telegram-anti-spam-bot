import {
  type AuditRecord,
  type AuditScope,
  auditRecordSchema,
  type CaptchaChallenge,
  type CaptchaStore,
  captchaChallengeSchema,
  isExpired,
  MAX_REVIEW_SAMPLES,
  MAX_WARN_ACTORS,
  MAX_WARN_CHATS,
  MAX_WARN_LIMIT,
  MIN_WARN_LIMIT,
  normalizeWarnLimit,
  parseAuditQuery,
  parseAuditRecord,
  parseAuditScope,
  parseCaptchaChallenge,
  parseReviewSample,
  parseRuleSet,
  ReviewCapacityError,
  type ReviewQueue,
  type ReviewSample,
  type RuleSet,
  reviewSampleSchema,
  ruleSetSchema,
  type Storage,
  sortWarnCounts,
  WARN_LIMIT,
  WarnCapacityError,
  type WarnCount,
  type WarnStore,
  type WarnTarget,
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
  batch(statements: readonly SqlPrepared[]): Promise<readonly unknown[]>;
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
  `CREATE TABLE IF NOT EXISTS review_samples (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  label TEXT NOT NULL,
  text_sha256 TEXT,
  action TEXT NOT NULL,
  score REAL NOT NULL,
  reasons TEXT NOT NULL,
  rule_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, chat_id, event_id)
)`,
  `CREATE TABLE IF NOT EXISTS captcha_challenges (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  message_id TEXT,
  PRIMARY KEY (tenant_id, chat_id, actor_id)
)`,
  `CREATE TABLE IF NOT EXISTS warn_counts (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, chat_id, actor_id)
)`,
  `CREATE TABLE IF NOT EXISTS warn_limits (
  tenant_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  limit_count INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, chat_id)
)`,
] as const;

const insertAuditSql = `INSERT INTO audits (
  tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const insertAuditIfAbsentSql = `${insertAuditSql}
ON CONFLICT(tenant_id, chat_id, event_id) DO NOTHING`;

const listAuditsSql = `SELECT tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
FROM (
  SELECT rowid, tenant_id, chat_id, event_id, message_id, text_sha256,
    action, score, reasons, evidence, rule_ids, created_at
  FROM audits
  WHERE tenant_id = ?
  ORDER BY rowid DESC
  LIMIT ?
)
ORDER BY rowid ASC`;

const listAuditsInChatSql = `SELECT tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
FROM (
  SELECT rowid, tenant_id, chat_id, event_id, message_id, text_sha256,
    action, score, reasons, evidence, rule_ids, created_at
  FROM audits
  WHERE tenant_id = ? AND chat_id = ?
  ORDER BY rowid DESC
  LIMIT ?
)
ORDER BY rowid ASC`;

const getAuditSql = `SELECT tenant_id, chat_id, event_id, message_id, text_sha256,
  action, score, reasons, evidence, rule_ids, created_at
FROM audits
WHERE tenant_id = ? AND chat_id = ? AND event_id = ?`;

const countAuditsSql =
  "SELECT COUNT(*) AS total FROM audits WHERE tenant_id = ?";

const countAuditsInChatSql =
  "SELECT COUNT(*) AS total FROM audits WHERE tenant_id = ? AND chat_id = ?";

const deletePageSize = 1000;

const deletePageBudget = 32;

const deleteAuditsSql = `DELETE FROM audits WHERE rowid IN (
  SELECT rowid FROM audits WHERE tenant_id = ? LIMIT ${deletePageSize}
)`;

const deleteAuditsInChatSql = `DELETE FROM audits WHERE rowid IN (
  SELECT rowid FROM audits
  WHERE tenant_id = ? AND chat_id = ? LIMIT ${deletePageSize}
)`;

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

const reviewColumns = `tenant_id, chat_id, event_id, label, text_sha256,
  action, score, reasons, rule_ids, created_at`;

const findReviewSql = `SELECT event_id FROM review_samples
WHERE tenant_id = ? AND chat_id = ? AND event_id = ?`;

const countReviewSql =
  "SELECT COUNT(*) AS total FROM review_samples WHERE tenant_id = ?";

const upsertReviewSql = `INSERT INTO review_samples (
  tenant_id, chat_id, event_id, label, text_sha256,
  action, score, reasons, rule_ids, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(tenant_id, chat_id, event_id) DO UPDATE SET
  label = excluded.label,
  text_sha256 = excluded.text_sha256,
  action = excluded.action,
  score = excluded.score,
  reasons = excluded.reasons,
  rule_ids = excluded.rule_ids,
  created_at = excluded.created_at`;

const listReviewSql = `SELECT ${reviewColumns}
FROM review_samples
WHERE tenant_id = ?
ORDER BY created_at ASC, event_id ASC`;

const listReviewInChatSql = `SELECT ${reviewColumns}
FROM review_samples
WHERE tenant_id = ? AND chat_id = ?
ORDER BY created_at ASC, event_id ASC`;

const upsertCaptchaSql = `INSERT INTO captcha_challenges (
  tenant_id, chat_id, actor_id, nonce, expires_at, message_id
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(tenant_id, chat_id, actor_id) DO UPDATE SET
  nonce = excluded.nonce,
  expires_at = excluded.expires_at,
  message_id = excluded.message_id`;

const readCaptchaSql = `SELECT tenant_id, chat_id, actor_id, nonce, expires_at, message_id
FROM captcha_challenges
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?`;

const deleteCaptchaSql = `DELETE FROM captcha_challenges
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?`;

const deleteCaptchaNonceSql = `DELETE FROM captcha_challenges
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ? AND nonce = ?`;

const takeCaptchaSql = `DELETE FROM captcha_challenges
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ? AND nonce = ?
RETURNING tenant_id, chat_id, actor_id, nonce, expires_at, message_id`;

const attachCaptchaSql = `UPDATE captcha_challenges
SET message_id = ?
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ? AND nonce = ?`;

const findCaptchaNonceSql = `SELECT tenant_id, chat_id, actor_id, nonce, expires_at, message_id
FROM captcha_challenges
WHERE tenant_id = ? AND chat_id = ? AND nonce = ?
LIMIT 1`;

const listDueCaptchaSql = `SELECT tenant_id, chat_id, actor_id, nonce, expires_at, message_id
FROM captcha_challenges
WHERE expires_at <= ?
ORDER BY expires_at ASC
LIMIT 64`;

const captchaColumnsSql =
  "SELECT name FROM pragma_table_info('captcha_challenges')";

const addCaptchaMessageIdSql =
  "ALTER TABLE captcha_challenges ADD COLUMN message_id TEXT";

const readWarnSql = `SELECT count AS total FROM warn_counts
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?`;

const incrementWarnSql = `INSERT INTO warn_counts (
  tenant_id, chat_id, actor_id, count
)
SELECT ?, ?, ?, 1
WHERE EXISTS (
  SELECT 1 FROM warn_counts
  WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?
) OR (
  (SELECT COUNT(*) FROM warn_counts WHERE tenant_id = ? AND chat_id = ?) < ?
  AND (
    EXISTS (
      SELECT 1 FROM warn_counts WHERE tenant_id = ? AND chat_id = ?
    ) OR (
      SELECT COUNT(*) FROM (
        SELECT DISTINCT tenant_id, chat_id FROM warn_counts
      )
    ) < ?
  )
)
ON CONFLICT(tenant_id, chat_id, actor_id) DO UPDATE SET count = count + 1
RETURNING count AS total`;

const updateWarnSql = `UPDATE warn_counts SET count = ?
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?`;

const insertWarnSql = `INSERT INTO warn_counts (
  tenant_id, chat_id, actor_id, count
)
SELECT ?, ?, ?, ?
WHERE (
  SELECT COUNT(*) FROM warn_counts WHERE tenant_id = ? AND chat_id = ?
) < ?
AND (
  EXISTS (
    SELECT 1 FROM warn_counts WHERE tenant_id = ? AND chat_id = ?
  ) OR (
    SELECT COUNT(*) FROM (
      SELECT DISTINCT tenant_id, chat_id FROM warn_counts
    )
  ) < ?
)`;

const deleteWarnSql = `DELETE FROM warn_counts
WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?`;

const listWarnSql = `SELECT actor_id, count FROM warn_counts
WHERE tenant_id = ? AND chat_id = ? AND count > 0`;

const readWarnLimitSql = `SELECT limit_count AS total FROM warn_limits
WHERE tenant_id = ? AND chat_id = ?`;

const deleteWarnLimitSql = `DELETE FROM warn_limits
WHERE tenant_id = ? AND chat_id = ?`;

const upsertWarnLimitSql = `INSERT INTO warn_limits (
  tenant_id, chat_id, limit_count
)
SELECT ?, ?, ?
WHERE EXISTS (
  SELECT 1 FROM warn_limits WHERE tenant_id = ? AND chat_id = ?
) OR (
  SELECT COUNT(*) FROM warn_limits
) < ?
ON CONFLICT(tenant_id, chat_id) DO UPDATE SET
  limit_count = excluded.limit_count
RETURNING limit_count AS total`;

const migrations = new WeakMap<SqlDatabase, Promise<void>>();

export function createD1CaptchaStore(db: SqlDatabase): CaptchaStore {
  return {
    async get(tenantId, chatId, actorId) {
      await migrationsFor(db);
      const rows = await db
        .prepare(readCaptchaSql)
        .bind(tenantId, chatId, actorId)
        .all();
      return readCaptcha(rows.results?.[0]);
    },
    async put(challenge) {
      await migrationsFor(db);
      const parsed = parseCaptchaChallenge(challenge);
      const expiresAt = new Date(Date.parse(parsed.expiresAt)).toISOString();
      await db
        .prepare(upsertCaptchaSql)
        .bind(
          parsed.tenantId,
          parsed.chatId,
          parsed.actorId,
          parsed.nonce,
          expiresAt,
          parsed.messageId ?? null,
        )
        .run();
    },
    async delete(tenantId, chatId, actorId) {
      await migrationsFor(db);
      await db.prepare(deleteCaptchaSql).bind(tenantId, chatId, actorId).run();
    },
    async deleteMany(challenges) {
      if (challenges.length === 0) {
        return;
      }
      await migrationsFor(db);
      await db.batch(
        challenges.map((challenge) => {
          const parsed = parseCaptchaChallenge(challenge);
          return db
            .prepare(deleteCaptchaSql)
            .bind(parsed.tenantId, parsed.chatId, parsed.actorId);
        }),
      );
    },
    async take(tenantId, chatId, actorId, nonce) {
      await migrationsFor(db);
      const rows = await db
        .prepare(takeCaptchaSql)
        .bind(tenantId, chatId, actorId, nonce)
        .all();
      return readCaptcha(rows.results?.[0]);
    },
    async takeMany(challenges) {
      if (challenges.length === 0) {
        return [];
      }
      await migrationsFor(db);
      const parsed = challenges.map((challenge) =>
        parseCaptchaChallenge(challenge),
      );
      const results = await db.batch(
        parsed.map((challenge) =>
          db
            .prepare(deleteCaptchaNonceSql)
            .bind(
              challenge.tenantId,
              challenge.chatId,
              challenge.actorId,
              challenge.nonce,
            ),
        ),
      );
      const taken: CaptchaChallenge[] = [];
      for (let index = 0; index < parsed.length; index += 1) {
        const challenge = parsed[index];
        if (challenge !== undefined && readChanges(results[index]) >= 1) {
          taken.push(challenge);
        }
      }
      return taken;
    },
    async attachPrompt(tenantId, chatId, actorId, nonce, messageId) {
      await migrationsFor(db);
      const parsed =
        captchaChallengeSchema.shape.messageId.safeParse(messageId);
      if (!parsed.success || parsed.data === undefined) {
        return false;
      }
      const result = await db
        .prepare(attachCaptchaSql)
        .bind(parsed.data, tenantId, chatId, actorId, nonce)
        .run();
      return readChanges(result) >= 1;
    },
    async findByNonce(tenantId, chatId, nonce) {
      await migrationsFor(db);
      const rows = await db
        .prepare(findCaptchaNonceSql)
        .bind(tenantId, chatId, nonce)
        .all();
      return readCaptcha(rows.results?.[0]);
    },
    async listExpired(nowIso) {
      await migrationsFor(db);
      const stamp = Date.parse(nowIso);
      if (Number.isNaN(stamp)) {
        return [];
      }
      const rows = await db
        .prepare(listDueCaptchaSql)
        .bind(new Date(stamp).toISOString())
        .all();
      const due: CaptchaChallenge[] = [];
      for (const row of rows.results ?? []) {
        const challenge = readCaptcha(row);
        if (challenge && isExpired(challenge.expiresAt, nowIso)) {
          due.push(challenge);
        }
      }
      return due;
    },
  };
}

export function createD1WarnStore(db: SqlDatabase): WarnStore {
  return {
    async read(target) {
      await migrationsFor(db);
      return readWarnCount(db, target);
    },
    async increment(target) {
      await migrationsFor(db);
      const rows = await db
        .prepare(incrementWarnSql)
        .bind(
          target.tenantId,
          target.chatId,
          target.actorId,
          target.tenantId,
          target.chatId,
          target.actorId,
          target.tenantId,
          target.chatId,
          MAX_WARN_ACTORS,
          target.tenantId,
          target.chatId,
          MAX_WARN_CHATS,
        )
        .all();
      const count = readWarnTotal(rows.results?.[0]);
      if (count === undefined) {
        throw new WarnCapacityError();
      }
      return count;
    },
    async write(target, count) {
      if (!Number.isInteger(count) || count < 0) {
        throw new WarnCapacityError();
      }
      await migrationsFor(db);
      if (count === 0) {
        await db
          .prepare(deleteWarnSql)
          .bind(target.tenantId, target.chatId, target.actorId)
          .run();
        return;
      }
      const current = await readWarnCount(db, target);
      if (current === count) {
        return;
      }
      if (current > 0) {
        await db
          .prepare(updateWarnSql)
          .bind(count, target.tenantId, target.chatId, target.actorId)
          .run();
        return;
      }
      const inserted = await db
        .prepare(insertWarnSql)
        .bind(
          target.tenantId,
          target.chatId,
          target.actorId,
          count,
          target.tenantId,
          target.chatId,
          MAX_WARN_ACTORS,
          target.tenantId,
          target.chatId,
          MAX_WARN_CHATS,
        )
        .run();
      if (readChanges(inserted) < 1) {
        throw new WarnCapacityError();
      }
    },
    async clear(target) {
      await migrationsFor(db);
      const result = await db
        .prepare(deleteWarnSql)
        .bind(target.tenantId, target.chatId, target.actorId)
        .run();
      return readChanges(result) >= 1;
    },
    async list(tenantId, chatId) {
      await migrationsFor(db);
      const rows = await db.prepare(listWarnSql).bind(tenantId, chatId).all();
      const counts: WarnCount[] = [];
      for (const row of rows.results ?? []) {
        const parsed = readWarnRow(row);
        if (parsed) {
          counts.push(parsed);
        }
      }
      return sortWarnCounts(counts).slice(0, MAX_WARN_ACTORS);
    },
    async readLimit(tenantId, chatId) {
      await migrationsFor(db);
      const rows = await db
        .prepare(readWarnLimitSql)
        .bind(tenantId, chatId)
        .all();
      return normalizeWarnLimit(readWarnTotal(rows.results?.[0]) ?? WARN_LIMIT);
    },
    async writeLimit(tenantId, chatId, limit) {
      if (
        !Number.isInteger(limit) ||
        limit < MIN_WARN_LIMIT ||
        limit > MAX_WARN_LIMIT
      ) {
        throw new WarnCapacityError();
      }
      await migrationsFor(db);
      if (limit === WARN_LIMIT) {
        await db.prepare(deleteWarnLimitSql).bind(tenantId, chatId).run();
        return;
      }
      const rows = await db
        .prepare(upsertWarnLimitSql)
        .bind(tenantId, chatId, limit, tenantId, chatId, MAX_WARN_CHATS)
        .all();
      if (readWarnTotal(rows.results?.[0]) !== limit) {
        throw new WarnCapacityError();
      }
    },
  };
}

async function readWarnCount(
  db: SqlDatabase,
  target: WarnTarget,
): Promise<number> {
  const rows = await db
    .prepare(readWarnSql)
    .bind(target.tenantId, target.chatId, target.actorId)
    .all();
  return readWarnTotal(rows.results?.[0]) ?? 0;
}

function readWarnRow(row: unknown): WarnCount | undefined {
  if (typeof row !== "object" || row === null) {
    return undefined;
  }
  const record = row as Record<string, unknown>;
  const actorId = record.actor_id;
  if (typeof actorId !== "string" || !/^-?\d{1,20}$/.test(actorId)) {
    return undefined;
  }
  const count = readStoredCount(record.count);
  if (count === undefined || count <= 0) {
    return undefined;
  }
  return { actorId, count };
}

function readStoredCount(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
  }
  return undefined;
}

function readWarnTotal(row: unknown): number | undefined {
  if (typeof row !== "object" || row === null) {
    return undefined;
  }
  const count = readStoredCount((row as Record<string, unknown>).total);
  if (count === undefined || count < 0) {
    return undefined;
  }
  return count;
}

function readCaptcha(row: unknown): CaptchaChallenge | null {
  if (typeof row !== "object" || row === null) {
    return null;
  }
  const record = row as Record<string, unknown>;
  const messageId = captchaChallengeSchema.shape.messageId.safeParse(
    record.message_id,
  );
  const parsed = captchaChallengeSchema.safeParse({
    tenantId: record.tenant_id,
    chatId: record.chat_id,
    actorId: record.actor_id,
    nonce: record.nonce,
    expiresAt: record.expires_at,
    ...(messageId.success && messageId.data !== undefined
      ? { messageId: messageId.data }
      : {}),
  });
  return parsed.success ? parsed.data : null;
}

export async function applyStorageMigrations(db: SqlDatabase): Promise<void> {
  for (const statement of storageMigrationStatements) {
    await db.prepare(statement).run();
  }
  const rows = await db.prepare(captchaColumnsSql).all();
  const names = (rows.results ?? []).map((row) => row.name);
  if (!names.includes("message_id")) {
    await db.prepare(addCaptchaMessageIdSql).run();
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
    async claimAudit(record) {
      await migrationsFor(db);
      const parsed = parseAuditRecord(record);
      const result = await db
        .prepare(insertAuditIfAbsentSql)
        .bind(...auditValues(parsed))
        .run();
      return readChanges(result) >= 1;
    },
    async putAuditsIfAbsent(records) {
      if (records.length === 0) {
        return;
      }
      await migrationsFor(db);
      await db.batch(
        records.map((record) => {
          const parsed = parseAuditRecord(record);
          return db
            .prepare(insertAuditIfAbsentSql)
            .bind(...auditValues(parsed));
        }),
      );
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
    async getAudit(tenantId, chatId, eventId) {
      await migrationsFor(db);
      const rows = await db
        .prepare(getAuditSql)
        .bind(tenantId, chatId, eventId)
        .all();
      const row = rows.results?.[0];
      return row ? readAudit(row) : null;
    },
    async exportAudits(scope) {
      await migrationsFor(db);
      return exportMatching(db, scope);
    },
    async countAudits(scope) {
      await migrationsFor(db);
      const parsed = parseAuditScope(scope);
      const rows =
        parsed.chatId === undefined
          ? await db.prepare(countAuditsSql).bind(parsed.tenantId).all()
          : await db
              .prepare(countAuditsInChatSql)
              .bind(parsed.tenantId, parsed.chatId)
              .all();
      return readAuditCount(rows.results?.[0]);
    },
    async deleteAudits(scope) {
      await migrationsFor(db);
      const parsed = parseAuditScope(scope);
      let removed = 0;
      for (let page = 0; page < deletePageBudget; page += 1) {
        const result =
          parsed.chatId === undefined
            ? await db.prepare(deleteAuditsSql).bind(parsed.tenantId).run()
            : await db
                .prepare(deleteAuditsInChatSql)
                .bind(parsed.tenantId, parsed.chatId)
                .run();
        const changes = readChanges(result);
        removed += changes;
        if (changes < deletePageSize) {
          return removed;
        }
      }
      return removed;
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

export function createD1ReviewQueue(db: SqlDatabase): ReviewQueue {
  return {
    async enqueue(sample) {
      await migrationsFor(db);
      const parsed = parseReviewSample(sample);
      const existing = await db
        .prepare(findReviewSql)
        .bind(parsed.tenantId, parsed.chatId, parsed.eventId)
        .all();
      if ((existing.results ?? []).length === 0) {
        const counted = await db
          .prepare(countReviewSql)
          .bind(parsed.tenantId)
          .all();
        if (readCount(counted.results?.[0]) >= MAX_REVIEW_SAMPLES) {
          throw new ReviewCapacityError();
        }
      }
      await db
        .prepare(upsertReviewSql)
        .bind(...reviewValues(parsed))
        .run();
    },
    async list(scope) {
      await migrationsFor(db);
      const parsed = parseAuditScope(scope);
      const rows =
        parsed.chatId === undefined
          ? await db.prepare(listReviewSql).bind(parsed.tenantId).all()
          : await db
              .prepare(listReviewInChatSql)
              .bind(parsed.tenantId, parsed.chatId)
              .all();
      const samples: ReviewSample[] = [];
      for (const row of rows.results ?? []) {
        const sample = readReview(row);
        if (sample) {
          samples.push(sample);
        }
      }
      return samples;
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

function reviewValues(
  sample: ReviewSample,
): readonly (string | number | null)[] {
  return [
    sample.tenantId,
    sample.chatId,
    sample.eventId,
    sample.label,
    sample.textSha256 ?? null,
    sample.action,
    sample.score,
    JSON.stringify(sample.reasons),
    JSON.stringify(sample.ruleIds),
    sample.createdAt,
  ];
}

function readReview(row: Record<string, unknown>): ReviewSample | null {
  const reasons = readJson(row.reasons);
  const ruleIds = readJson(row.rule_ids);
  if (reasons === undefined || ruleIds === undefined) {
    return null;
  }
  const parsed = reviewSampleSchema.safeParse({
    tenantId: row.tenant_id,
    chatId: row.chat_id,
    eventId: row.event_id,
    label: row.label,
    ...(typeof row.text_sha256 === "string"
      ? { textSha256: row.text_sha256 }
      : {}),
    action: row.action,
    score: row.score,
    reasons,
    ruleIds,
    createdAt: row.created_at,
  });
  return parsed.success ? parsed.data : null;
}

function readChanges(result: unknown): number {
  if (typeof result !== "object" || result === null || !("meta" in result)) {
    throw new Error("delete_changes_missing");
  }
  const meta = result.meta;
  if (typeof meta !== "object" || meta === null || !("changes" in meta)) {
    throw new Error("delete_changes_missing");
  }
  const changes = meta.changes;
  if (
    typeof changes === "number" &&
    Number.isInteger(changes) &&
    changes >= 0
  ) {
    return changes;
  }
  if (typeof changes === "bigint" && changes >= 0n) {
    const asNumber = Number(changes);
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
  }
  throw new Error("delete_changes_missing");
}

function readAuditCount(row: Record<string, unknown> | undefined): number {
  const value = row?.total;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    Number.isSafeInteger(value)
  ) {
    return value;
  }
  if (typeof value === "bigint" && value >= 0n) {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) {
      return asNumber;
    }
  }
  throw new Error("audit_count_missing");
}

function readCount(row: Record<string, unknown> | undefined): number {
  const value = row?.total;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return 0;
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
