import {
  type Event,
  type Logger,
  type ReplyPort,
  runOperatorCommand,
} from "@tasb/core";
import { fileRuleSource } from "./rules.js";
import {
  createWorkerLogger,
  type ScreenDeps,
  screenTelegramEvent,
  workerCache,
  workerPolicyStore,
  workerRuntime,
  workerStorage,
} from "./screen.js";

export interface OperateDeps extends ScreenDeps {
  readonly adminActorIds?: readonly string[];
  readonly reply?: ReplyPort;
}

export async function handleIncomingEvent(
  event: Event,
  deps: OperateDeps = {},
): Promise<void> {
  const logger = deps.logger ?? createWorkerLogger();
  const cache = deps.cache ?? workerCache;
  const source = deps.source ?? fileRuleSource;
  const storage = deps.storage ?? workerStorage;
  const policyStore = deps.policyStore ?? workerPolicyStore;
  const runtime = deps.runtime ?? workerRuntime;
  const outcome = await runOperatorCommand({
    event,
    adminActorIds: deps.adminActorIds ?? [],
    cache,
    policyStore,
    runtime,
    source,
    storage,
    logger,
  });
  if (outcome.status === "reply") {
    await sendReply(event, outcome.text, outcome.command, deps.reply, logger);
    return;
  }
  await screenTelegramEvent(event, {
    logger,
    cache,
    source,
    storage,
    policyStore,
    runtime,
  });
}

async function sendReply(
  event: Event,
  text: string,
  command: string,
  reply: ReplyPort | undefined,
  logger: Logger,
): Promise<void> {
  try {
    if (!reply) {
      throw new Error("reply_unavailable");
    }
    await reply.send({
      tenantId: event.tenantId,
      chatId: event.chatId,
      text,
    });
    logger.info("operator_replied", {
      eventId: event.id,
      chatId: event.chatId,
      command,
    });
  } catch {
    logger.warn("reply_failed", {
      eventId: event.id,
      chatId: event.chatId,
    });
  }
}
