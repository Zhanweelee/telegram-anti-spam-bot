import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  bindCaptchaStoreContract,
  bindReviewQueueContract,
  bindStorageContract,
} from "@tasb/core/testing";
import { describe, expect, it } from "vitest";
import {
  applyStorageMigrations,
  createD1CaptchaStore,
  createD1ReviewQueue,
  createD1Storage,
  type SqlDatabase,
  type SqlPrepared,
  storageMigrationStatements,
} from "./d1.js";

bindStorageContract(() => createD1Storage(openSqlite()));
bindReviewQueueContract(() => createD1ReviewQueue(openSqlite()));
bindCaptchaStoreContract(() => createD1CaptchaStore(openSqlite()));

describe("d1 storage", () => {
  it("keeps the sql file equal to the exported statements", () => {
    const path = fileURLToPath(
      new URL("../migrations/0001_storage.sql", import.meta.url),
    );
    expect(readFileSync(path, "utf8").trim()).toBe(
      `${storageMigrationStatements.join(";\n\n")};`,
    );
  });

  it("applies the migration twice and then stores a rule set", async () => {
    const db = openSqlite();
    await applyStorageMigrations(db);
    await applyStorageMigrations(db);
    const storage = createD1Storage(db);
    const rules = {
      version: 1 as const,
      aggregate: "max" as const,
      rules: [
        {
          id: "spam_keywords",
          enabled: true,
          detectorIds: ["keyword"],
          threshold: 1,
          actions: ["delete" as const],
        },
      ],
    };
    await storage.putRuleSet("tenant_a", "chat_1", rules);
    expect(await storage.getRuleSet("tenant_a", "chat_1")).toEqual(rules);
  });

  it("skips a corrupt audit and a corrupt rule document", async () => {
    const db = openSqlite();
    await applyStorageMigrations(db);
    const storage = createD1Storage(db);
    await storage.getRuleSet("tenant_a", "chat_1");
    const secret = "请免费领取礼品";
    await db
      .prepare(
        `INSERT INTO audits (
          tenant_id, chat_id, event_id, action, score,
          reasons, evidence, rule_ids, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "tenant_a",
        "chat_1",
        "evt_bad",
        "delete",
        1,
        secret,
        "[]",
        "[]",
        "2026-11-01T00:00:00Z",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO rule_sets (tenant_id, chat_id, document) VALUES (?, ?, ?)`,
      )
      .bind("tenant_a", "chat_1", `{${secret}`)
      .run();
    const listed = await storage.listAudits({
      tenantId: "tenant_a",
      limit: 10,
    });
    expect(listed).toEqual([]);
    expect(await storage.getRuleSet("tenant_a", "chat_1")).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("skips a review row whose reasons are not a feature list", async () => {
    const db = openSqlite();
    const queue = createD1ReviewQueue(db);
    const secret = "请免费领取礼品";
    await queue.list({ tenantId: "tenant_a" });
    await db
      .prepare(
        `INSERT INTO review_samples (
          tenant_id, chat_id, event_id, label, action, score,
          reasons, rule_ids, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "tenant_a",
        "chat_1",
        "evt_bad",
        "confirmed",
        "delete",
        1,
        secret,
        "[]",
        "2026-11-01T00:00:00.000Z",
      )
      .run();
    const listed = await queue.list({ tenantId: "tenant_a" });
    expect(listed).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("shares one challenge across two stores and skips a bad row", async () => {
    const db = openSqlite();
    const first = createD1CaptchaStore(db);
    const second = createD1CaptchaStore(db);
    const challenge = {
      tenantId: "tenant_a",
      chatId: "chat_1",
      actorId: "user_1",
      nonce: "ab".repeat(8),
      expiresAt: "2026-11-01T00:05:00.000Z",
    };
    await first.put(challenge);
    expect(await second.get("tenant_a", "chat_1", "user_1")).toEqual(challenge);
    await second.delete("tenant_a", "chat_1", "user_1");
    expect(await first.get("tenant_a", "chat_1", "user_1")).toBeNull();

    const phrase = "请免费领取礼品";
    await applyStorageMigrations(db);
    await db
      .prepare(
        `INSERT INTO captcha_challenges (
          tenant_id, chat_id, actor_id, nonce, expires_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "tenant_a",
        "chat_1",
        "user_bad",
        phrase,
        "2020-01-01T00:00:00.000Z",
      )
      .run();
    expect(await first.get("tenant_a", "chat_1", "user_bad")).toBeNull();
    expect(await first.listExpired("2026-11-01T00:00:00.000Z")).toEqual([]);
    const left = await db
      .prepare(
        `SELECT nonce FROM captcha_challenges
         WHERE tenant_id = ? AND chat_id = ? AND actor_id = ?`,
      )
      .bind("tenant_a", "chat_1", "user_bad")
      .all();
    expect(left.results?.[0]?.nonce).toBe(phrase);
  });

  it("rejects a count result that does not report a total", async () => {
    const db: SqlDatabase = {
      prepare() {
        const prepared: SqlPrepared = {
          bind() {
            return prepared;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return {};
          },
        };
        return prepared;
      },
    };
    await expect(
      createD1Storage(db).countAudits({ tenantId: "tenant_a" }),
    ).rejects.toThrow("audit_count_missing");
  });

  it("rejects a delete result that does not report a count", async () => {
    const db: SqlDatabase = {
      prepare() {
        const prepared: SqlPrepared = {
          bind() {
            return prepared;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return {};
          },
        };
        return prepared;
      },
    };
    const storage = createD1Storage(db);
    await expect(
      storage.deleteAudits({ tenantId: "tenant_a" }),
    ).rejects.toThrow("delete_changes_missing");
  });

  it("runs the migration again after it fails", async () => {
    let fail = true;
    const db: SqlDatabase = {
      prepare(sql) {
        const prepared: SqlPrepared = {
          bind() {
            return prepared;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (fail && sql.includes("audits")) {
              throw new Error("busy");
            }
          },
        };
        return prepared;
      },
    };
    const storage = createD1Storage(db);
    await expect(storage.getRuleSet("tenant_a", "chat_1")).rejects.toThrow(
      "busy",
    );
    fail = false;
    expect(await storage.getRuleSet("tenant_a", "chat_1")).toBeNull();
  });
});

function openSqlite(): SqlDatabase {
  const database = new DatabaseSync(":memory:");
  return {
    prepare(sql) {
      const statement = database.prepare(sql);
      let bound: readonly (string | number | null)[] = [];
      const prepared: SqlPrepared = {
        bind(...values) {
          bound = values;
          return prepared;
        },
        async all() {
          const results = statement.all(...bound);
          return { results: results.map(asRow) };
        },
        async run() {
          const info: unknown = statement.run(...bound);
          if (typeof info === "object" && info !== null && "changes" in info) {
            return { meta: { changes: info.changes } };
          }
          return {};
        },
      };
      return prepared;
    },
  };
}

function asRow(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const row: Record<string, unknown> = {};
  for (const [key, cell] of Object.entries(value)) {
    row[key] = cell;
  }
  return row;
}
