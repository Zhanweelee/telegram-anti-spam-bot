import { createMemoryModerator } from "@tasb/adapter-memory";
import type { ModerationPort } from "@tasb/core";
import { createTelegramModerator } from "@tasb/platform-telegram";

export function moderatorFor(input: {
  readonly token?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): ModerationPort {
  const token = input.token?.trim() ?? "";
  if (token.length === 0) {
    return createOpenModerator();
  }
  return createTelegramModerator({
    token,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

function createOpenModerator(): ModerationPort {
  const memory = createMemoryModerator();
  return {
    deleteMessage: (target) => memory.deleteMessage(target),
    muteActor: (target) => memory.muteActor(target),
    banActor: (target) => memory.banActor(target),
    declineJoin: (target) => memory.declineJoin(target),
    deferJoin: (target) => memory.deferJoin(target),
    async restrictActor() {
      throw new Error("restrict_unavailable");
    },
    async releaseActor() {
      throw new Error("restrict_unavailable");
    },
  };
}
