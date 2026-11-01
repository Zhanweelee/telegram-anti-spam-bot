import { type Action, defineAction } from "@tasb/core";
import { z } from "zod";

export function createDeleteAction(): Action {
  return defineAction({
    id: "delete",
    version: "0.1.0",
    capabilities: ["moderation"],
    configSchema: z.strictObject({}),
    config: {},
    async execute(ctx) {
      if (ctx.dryRun) {
        return { actionId: "delete", status: "skipped", detail: "dry_run" };
      }
      const messageId = ctx.event.message?.id;
      if (!messageId) {
        return {
          actionId: "delete",
          status: "failed",
          detail: "missing_message",
        };
      }
      await ctx.moderator.deleteMessage({
        tenantId: ctx.event.tenantId,
        chatId: ctx.event.chatId,
        messageId,
      });
      return { actionId: "delete", status: "executed" };
    },
  });
}
