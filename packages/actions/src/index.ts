import { type Action, defineAction } from "@tasb/core";
import { z } from "zod";

const daySeconds = 24 * 60 * 60;

export const muteConfigSchema = z.strictObject({
  durationSeconds: z
    .number()
    .int()
    .positive()
    .max(366 * daySeconds),
});

export type MuteConfig = z.input<typeof muteConfigSchema>;

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

export function createMuteAction(config: MuteConfig): Action {
  return defineAction({
    id: "mute",
    version: "0.1.0",
    capabilities: ["moderation"],
    configSchema: muteConfigSchema,
    config,
    async execute(ctx, parsed) {
      if (ctx.dryRun) {
        return { actionId: "mute", status: "skipped", detail: "dry_run" };
      }
      if (ctx.event.actor.id.length === 0) {
        return { actionId: "mute", status: "failed", detail: "missing_actor" };
      }
      await ctx.moderator.muteActor({
        tenantId: ctx.event.tenantId,
        chatId: ctx.event.chatId,
        actorId: ctx.event.actor.id,
        durationSeconds: parsed.durationSeconds,
      });
      return { actionId: "mute", status: "executed" };
    },
  });
}

export function createBanAction(): Action {
  return defineAction({
    id: "ban",
    version: "0.1.0",
    capabilities: ["moderation"],
    configSchema: z.strictObject({}),
    config: {},
    async execute(ctx) {
      if (ctx.dryRun) {
        return { actionId: "ban", status: "skipped", detail: "dry_run" };
      }
      if (ctx.event.actor.id.length === 0) {
        return { actionId: "ban", status: "failed", detail: "missing_actor" };
      }
      await ctx.moderator.banActor({
        tenantId: ctx.event.tenantId,
        chatId: ctx.event.chatId,
        actorId: ctx.event.actor.id,
      });
      return { actionId: "ban", status: "executed" };
    },
  });
}
