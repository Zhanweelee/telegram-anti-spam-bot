import { createDeleteAction } from "@tasb/actions";
import {
  createMemoryModerator,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  createFixedClock,
  createMemoryLogger,
  type PipelineResult,
  parseRuleSet,
  runPipeline,
} from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";
import { createMessageEvent } from "@tasb/sdk";

const rules = parseRuleSet({
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
});

export async function screen(
  text: string,
  options?: { readonly dryRun?: boolean },
): Promise<{
  result: PipelineResult;
  audits: readonly unknown[];
  deleted: number;
}> {
  const storage = createMemoryStorage();
  const moderator = createMemoryModerator();
  const result = await runPipeline({
    event: createMessageEvent({
      text,
      tenantId: "tenant_demo",
      chatId: "chat_demo",
    }),
    rules,
    policy: { exemptAdmins: true, allowActorIds: [] },
    detectors: [createKeywordDetector({ keywords: ["免费领取", "加微信"] })],
    actions: [createDeleteAction()],
    storage,
    moderator,
    logger: createMemoryLogger(),
    clock: createFixedClock("2026-11-01T00:00:00Z"),
    dryRun: options?.dryRun ?? false,
  });
  return { result, audits: storage.records, deleted: moderator.deleted.length };
}
