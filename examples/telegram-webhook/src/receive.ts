import type { Event } from "@tasb/core";
import {
  handleTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
} from "@tasb/platform-telegram";

/**
 * Minimal webhook receiver. A wrong or missing secret never reaches `onEvent`.
 * The HTTP body is only `{ ok: true }` — message text stays in the Event.
 */
export async function receiveUpdate(input: {
  readonly secret: string;
  readonly body: string;
  readonly header?: string;
  readonly tenantId?: string;
  readonly adminUserIds?: readonly string[];
}): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly events: readonly Event[];
}> {
  const events: Event[] = [];
  const headers = new Headers();
  if (input.header !== undefined) {
    headers.set(TELEGRAM_SECRET_HEADER, input.header);
  }
  const response = await handleTelegramWebhook(
    new Request("https://bot.example/telegram/webhook", {
      method: "POST",
      headers,
      body: input.body,
    }),
    {
      secretToken: input.secret,
      tenantId: input.tenantId ?? "local",
      ...(input.adminUserIds ? { adminUserIds: input.adminUserIds } : {}),
      onEvent: async (event) => {
        events.push(event);
      },
    },
  );
  return {
    status: response.status,
    body: await response.json(),
    events,
  };
}
