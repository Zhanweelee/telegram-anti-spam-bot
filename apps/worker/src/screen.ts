import { createDeleteAction } from "@tasb/actions";
import {
  createMemoryModerator,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import {
  type Event,
  type Logger,
  type PipelineResult,
  parseRuleSet,
  runPipeline,
  wrapLogger,
} from "@tasb/core";
import { createKeywordDetector } from "@tasb/detector-keyword";

/**
 * Stand-in until P0-03 loads a per-chat RuleSet.
 * The moderator is in-memory for this request only. It does not call
 * Telegram's deleteMessage API.
 */
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

const detector = createKeywordDetector({
  keywords: ["免费领取", "加微信"],
});

export function createWorkerLogger(): Logger {
  return wrapLogger({
    info(message, fields) {
      console.info(JSON.stringify({ level: "info", message, ...fields }));
    },
    warn(message, fields) {
      console.warn(JSON.stringify({ level: "warn", message, ...fields }));
    },
    error(message, fields) {
      console.error(JSON.stringify({ level: "error", message, ...fields }));
    },
  });
}

export async function screenTelegramEvent(
  event: Event,
  logger: Logger = createWorkerLogger(),
): Promise<PipelineResult> {
  const result = await runPipeline({
    event,
    rules,
    policy: { exemptAdmins: true, allowActorIds: [] },
    detectors: [detector],
    actions: [createDeleteAction()],
    storage: createMemoryStorage(),
    moderator: createMemoryModerator(),
    logger,
  });
  logger.info("webhook_screened", {
    eventId: result.eventId,
    chatId: event.chatId,
    action: result.decision.action,
    outcome: result.outcome,
  });
  return result;
}
