import { createHash } from "node:crypto";
import { type DeleteTarget, type Event, parseEvent } from "@tasb/core";

export type { DeleteTarget };

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function createMessageEvent(input: {
  readonly text: string;
  readonly tenantId?: string;
  readonly chatId?: string;
  readonly actorId?: string;
  readonly isAdmin?: boolean;
  readonly id?: string;
  readonly messageId?: string;
  readonly occurredAt?: string;
}): Event {
  return parseEvent({
    id: input.id ?? "evt_1",
    tenantId: input.tenantId ?? "tenant_demo",
    chatId: input.chatId ?? "chat_demo",
    kind: "message",
    occurredAt: input.occurredAt ?? "2026-11-01T00:00:00Z",
    actor: {
      id: input.actorId ?? "user_1",
      isAdmin: input.isAdmin ?? false,
    },
    message: {
      id: input.messageId ?? "msg_1",
      text: input.text,
      textSha256: sha256Hex(input.text),
    },
  });
}
