import type { RuleSource } from "@tasb/core";
import chatDocuments from "../rules/chats.json" with { type: "json" };
import defaultDocument from "../rules/default.json" with { type: "json" };

export const fileRuleSource: RuleSource = {
  async loadChat(_tenantId, chatId) {
    const found = Object.entries(chatDocuments).find(([id]) => id === chatId);
    return found ? found[1] : null;
  },
  async loadDefault() {
    return defaultDocument;
  },
};
