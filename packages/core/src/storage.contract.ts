import { describe, expect, it } from "vitest";
import {
  type AuditRecord,
  auditExportDocument,
  type Storage,
} from "./ports.js";
import type { RuleSet } from "./rule.js";

const record: AuditRecord = {
  tenantId: "tenant_a",
  chatId: "chat_1",
  eventId: "evt_1",
  textSha256: "d".repeat(64),
  action: "delete",
  score: 1,
  reasons: ["keyword_match"],
  evidence: [{ kind: "keyword", summary: "keyword:spam" }],
  ruleIds: ["spam_keywords"],
  createdAt: "2026-11-01T00:00:00Z",
};

const rules: RuleSet = {
  version: 1,
  aggregate: "max",
  rules: [
    {
      id: "spam_keywords",
      enabled: true,
      detectorIds: ["keyword"],
      threshold: 1,
      actions: ["delete"],
    },
  ],
};

/**
 * Behavioral contract shared by every `Storage`.
 * Call it from a test file at load time so each adapter runs the same cases.
 */
export function bindStorageContract(create: () => Storage): void {
  describe("storage contract", () => {
    it("returns null when no rule set is stored", async () => {
      const storage = create();
      expect(await storage.getRuleSet("tenant_a", "chat_1")).toBeNull();
    });

    it("round-trips a rule set for one tenant and chat", async () => {
      const storage = create();
      await storage.putRuleSet("tenant_a", "chat_1", rules);
      expect(await storage.getRuleSet("tenant_a", "chat_1")).toEqual(rules);
      expect(await storage.getRuleSet("tenant_b", "chat_1")).toBeNull();
      expect(await storage.getRuleSet("tenant_a", "chat_2")).toBeNull();
    });

    it("replaces the rule set for that chat", async () => {
      const storage = create();
      await storage.putRuleSet("tenant_a", "chat_1", rules);
      const replaced: RuleSet = { ...rules, aggregate: "sum" };
      await storage.putRuleSet("tenant_a", "chat_1", replaced);
      expect(await storage.getRuleSet("tenant_a", "chat_1")).toEqual(replaced);
    });

    it("keeps a tenant id that contains a quote", async () => {
      const storage = create();
      const tenantId = "o'reilly";
      await storage.putRuleSet(tenantId, "chat_1", rules);
      expect(await storage.getRuleSet(tenantId, "chat_1")).toEqual(rules);
      await storage.appendAudit({ ...record, tenantId, eventId: "evt_q" });
      const listed = await storage.listAudits({ tenantId, limit: 10 });
      expect(listed).toEqual([{ ...record, tenantId, eventId: "evt_q" }]);
    });

    it("reads one audit by tenant, chat, and event", async () => {
      const storage = create();
      expect(await storage.getAudit("tenant_a", "chat_1", "evt_1")).toBeNull();
      await storage.appendAudit(record);
      expect(await storage.getAudit("tenant_a", "chat_1", "evt_1")).toEqual(
        record,
      );
      expect(await storage.getAudit("tenant_b", "chat_1", "evt_1")).toBeNull();
      expect(await storage.getAudit("tenant_a", "chat_2", "evt_1")).toBeNull();
      expect(
        await storage.getAudit("tenant_a", "chat_1", "missing"),
      ).toBeNull();
    });

    it("lists audits oldest first for that tenant and chat", async () => {
      const storage = create();
      await storage.appendAudit(record);
      await storage.appendAudit({ ...record, eventId: "evt_2" });
      await storage.appendAudit({
        ...record,
        tenantId: "tenant_b",
        eventId: "evt_other",
      });
      await storage.appendAudit({
        ...record,
        chatId: "chat_2",
        eventId: "evt_3",
        messageId: "msg_3",
      });
      expect(
        await storage.listAudits({ tenantId: "tenant_a", limit: 10 }),
      ).toEqual([
        record,
        { ...record, eventId: "evt_2" },
        {
          ...record,
          chatId: "chat_2",
          eventId: "evt_3",
          messageId: "msg_3",
        },
      ]);
      expect(
        await storage.listAudits({
          tenantId: "tenant_a",
          chatId: "chat_1",
          limit: 1,
        }),
      ).toEqual([record]);
      expect(
        await storage.listAudits({
          tenantId: "tenant_a",
          chatId: "missing",
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await storage.listAudits({ tenantId: "tenant_b", limit: 10 }),
      ).toEqual([{ ...record, tenantId: "tenant_b", eventId: "evt_other" }]);
    });

    it("rejects an audit that carries message text", async () => {
      const storage = create();
      const secret = "请免费领取礼品";
      await expect(
        storage.appendAudit({ ...record, text: secret } as AuditRecord),
      ).rejects.toThrow();
      const listed = await storage.listAudits({
        tenantId: record.tenantId,
        limit: 10,
      });
      expect(listed).toEqual([]);
      expect(JSON.stringify(listed)).not.toContain(secret);
    });

    it("exports audits without message text and deletes that scope", async () => {
      const storage = create();
      const secret = "请免费领取礼品";
      await storage.appendAudit(record);
      await storage.appendAudit({
        ...record,
        chatId: "chat_2",
        eventId: "evt_2",
      });
      await storage.appendAudit({
        ...record,
        tenantId: "tenant_b",
        eventId: "evt_b",
      });
      await storage.putRuleSet("tenant_a", "chat_1", rules);
      const chatExport = await storage.exportAudits({
        tenantId: "tenant_a",
        chatId: "chat_1",
      });
      expect(chatExport).toEqual([record]);
      expect(
        await storage.countAudits({ tenantId: "tenant_a", chatId: "chat_1" }),
      ).toBe(1);
      expect(await storage.countAudits({ tenantId: "tenant_a" })).toBe(2);
      expect(await storage.countAudits({ tenantId: "tenant_b" })).toBe(1);
      const json = auditExportDocument(
        { tenantId: "tenant_a", chatId: "chat_1" },
        chatExport,
      );
      expect(JSON.parse(json)).toEqual({
        tenantId: "tenant_a",
        chatId: "chat_1",
        audits: [record],
      });
      expect(json).not.toContain(secret);
      expect(json).not.toContain('"text"');
      expect(
        await storage.deleteAudits({ tenantId: "tenant_a", chatId: "chat_1" }),
      ).toBe(1);
      expect(
        await storage.exportAudits({ tenantId: "tenant_a", chatId: "chat_1" }),
      ).toEqual([]);
      expect(
        await storage.listAudits({
          tenantId: "tenant_a",
          chatId: "chat_1",
          limit: 10,
        }),
      ).toEqual([]);
      expect(await storage.exportAudits({ tenantId: "tenant_a" })).toEqual([
        { ...record, chatId: "chat_2", eventId: "evt_2" },
      ]);
      expect(await storage.getRuleSet("tenant_a", "chat_1")).toEqual(rules);
      expect(await storage.deleteAudits({ tenantId: "tenant_a" })).toBe(1);
      expect(await storage.exportAudits({ tenantId: "tenant_a" })).toEqual([]);
      expect(await storage.countAudits({ tenantId: "tenant_a" })).toBe(0);
      expect(await storage.exportAudits({ tenantId: "tenant_b" })).toEqual([
        { ...record, tenantId: "tenant_b", eventId: "evt_b" },
      ]);
    });

    it("exports more audits than one list page", async () => {
      const storage = create();
      for (let index = 0; index < 101; index += 1) {
        await storage.appendAudit({ ...record, eventId: `evt_${index}` });
      }
      const exported = await storage.exportAudits({ tenantId: "tenant_a" });
      expect(exported).toHaveLength(101);
      expect(exported[0]?.eventId).toBe("evt_0");
      expect(exported[100]?.eventId).toBe("evt_100");
      expect(
        await storage.listAudits({ tenantId: "tenant_a", limit: 100 }),
      ).toHaveLength(100);
    });
  });
}
