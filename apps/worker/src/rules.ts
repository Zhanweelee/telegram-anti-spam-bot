import type { RulePackSource, RuleSource } from "@tasb/core";
import chatDocuments from "../rules/chats.json" with { type: "json" };
import defaultDocument from "../rules/default.json" with { type: "json" };
import packDocuments from "../rules/packs.json" with { type: "json" };

const bundledPacks = packDocuments as Readonly<Record<string, unknown>>;

export const fileRuleSource: RuleSource = {
  async loadChat(_tenantId, chatId) {
    const found = Object.entries(chatDocuments).find(([id]) => id === chatId);
    return found ? found[1] : null;
  },
  async loadDefault() {
    return defaultDocument;
  },
};

export function filePackSource(
  documents: Readonly<Record<string, unknown>> = bundledPacks,
): RulePackSource {
  return {
    async load(packId) {
      if (!Object.hasOwn(documents, packId)) {
        throw new Error("pack_missing");
      }
      return documents[packId];
    },
  };
}
