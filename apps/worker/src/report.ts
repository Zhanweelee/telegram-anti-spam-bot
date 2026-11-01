import { formatReportNotice, type Notifier, type ReplyPort } from "@tasb/core";

/** One private message to the first configured admin. No message text. */
export function adminNotifier(reply: ReplyPort, actorId: string): Notifier {
  return {
    async notify(notice) {
      await reply.send({
        tenantId: notice.tenantId,
        chatId: actorId,
        text: formatReportNotice(notice),
      });
    },
  };
}
