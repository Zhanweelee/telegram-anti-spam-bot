import {
  createMemoryBlocklistStore,
  createMemoryCache,
  createMemoryPolicyStore,
  createMemoryReviewQueue,
  createMemoryRuleSubscriptionStore,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  createMemoryLogger,
  type Locale,
  parseEvent,
  type ReviewQueue,
  type RulePackArchive,
  type RulePackSource,
  type RuleSubscriptionStore,
  runOperatorCommand,
  type Storage,
} from "@tasb/core";

const rules = {
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

export async function runPrivateCommand(input: {
  readonly text: string;
  readonly actorId: string;
  readonly adminActorIds: readonly string[];
  readonly storage?: Storage;
  readonly review?: ReviewQueue;
  readonly rulePacks?: RuleSubscriptionStore;
  readonly rulePackSource?: RulePackSource;
  readonly rulePackArchive?: RulePackArchive;
  readonly locale?: Locale;
}): Promise<string | null> {
  const result = await runOperatorCommand({
    event: parseEvent({
      id: "evt_demo",
      tenantId: "local",
      chatId: input.actorId,
      kind: "message",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: input.actorId, isAdmin: false },
      direct: true,
      message: {
        id: "1",
        text: input.text,
        textSha256: "ab".repeat(32),
      },
    }),
    adminActorIds: input.adminActorIds,
    cache: createMemoryCache(),
    policyStore: createMemoryPolicyStore(),
    runtime: createMemoryRuntimeStore(),
    storage: input.storage ?? createMemoryStorage(),
    logger: createMemoryLogger(),
    blocklist: createMemoryBlocklistStore(),
    review: input.review ?? createMemoryReviewQueue(),
    rulePacks: input.rulePacks ?? createMemoryRuleSubscriptionStore(),
    ...(input.rulePackSource && input.rulePackArchive
      ? {
          rulePackSource: input.rulePackSource,
          rulePackArchive: input.rulePackArchive,
        }
      : {}),
    ...(input.locale ? { locale: input.locale } : {}),
    source: {
      async loadChat() {
        return null;
      },
      async loadDefault() {
        return rules;
      },
    },
  });
  return result.status === "reply" ? result.text : null;
}
