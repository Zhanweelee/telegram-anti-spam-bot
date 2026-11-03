import {
  type Action,
  beginChallenge,
  buildReportNotice,
  type CaptchaStore,
  type Clock,
  defineAction,
  moreSevere,
  type Notifier,
  type Storage,
} from "@tasb/core";
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
      const audienceId = ctx.event.message?.audienceId;
      await ctx.moderator.deleteMessage({
        tenantId: ctx.event.tenantId,
        chatId: ctx.event.chatId,
        messageId,
        ...(audienceId ? { audienceId } : {}),
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

export const captchaConfigSchema = z.strictObject({
  ttlSeconds: z.number().int().positive().max(daySeconds),
});

export interface CaptchaActionDeps {
  readonly ttlSeconds?: number;
  readonly createNonce: () => string;
  readonly store: CaptchaStore;
  readonly clock: Clock;
}

const closedStorage: Storage = {
  async appendAudit() {
    throw new Error("storage");
  },
  async claimAudit() {
    throw new Error("storage");
  },
  async putAuditsIfAbsent() {},
  async listAudits() {
    return [];
  },
  async getAudit() {
    return null;
  },
  async exportAudits() {
    return [];
  },
  async countAudits() {
    return 0;
  },
  async deleteAudits() {
    return 0;
  },
  async getRuleSet() {
    return null;
  },
  async putRuleSet() {},
};

export function createCaptchaAction(deps: CaptchaActionDeps): Action {
  return defineAction({
    id: "captcha",
    version: "0.1.0",
    capabilities: ["moderation"],
    configSchema: captchaConfigSchema,
    config: { ttlSeconds: deps.ttlSeconds ?? 300 },
    async execute(ctx, parsed) {
      if (ctx.dryRun) {
        return { actionId: "captcha", status: "skipped", detail: "dry_run" };
      }
      if (ctx.event.kind !== "chat_member" || ctx.event.membership !== "join") {
        return { actionId: "captcha", status: "skipped", detail: "not_join" };
      }
      if (moreSevere(ctx.decision.action, "captcha") !== "captcha") {
        return { actionId: "captcha", status: "skipped", detail: "superseded" };
      }
      if (ctx.event.actor.id.length === 0) {
        return {
          actionId: "captcha",
          status: "failed",
          detail: "missing_actor",
        };
      }
      try {
        const nonce = deps.createNonce();
        if (!/^[a-f0-9]{16}$/.test(nonce)) {
          throw new Error("nonce");
        }
        await beginChallenge({
          event: ctx.event,
          ttlSeconds: parsed.ttlSeconds,
          nonce,
          ports: {
            store: deps.store,
            storage: closedStorage,
            restrict: (target) => ctx.moderator.restrictActor(target),
            release: (target) => ctx.moderator.releaseActor(target),
            clock: deps.clock,
            logger: ctx.logger,
            removePrompt: (target) => ctx.moderator.deleteMessage(target),
          },
        });
        return { actionId: "captcha", status: "executed" };
      } catch {
        ctx.logger.warn("captcha_failed", {
          eventId: ctx.event.id,
          chatId: ctx.event.chatId,
        });
        return {
          actionId: "captcha",
          status: "failed",
          detail: "captcha_unavailable",
        };
      }
    },
  });
}

export function createDeclineAction(): Action {
  return defineAction({
    id: "decline",
    version: "0.1.0",
    capabilities: ["moderation"],
    configSchema: z.strictObject({}),
    config: {},
    async execute(ctx) {
      if (ctx.dryRun) {
        return { actionId: "decline", status: "skipped", detail: "dry_run" };
      }
      if (ctx.event.kind !== "join_request") {
        return {
          actionId: "decline",
          status: "failed",
          detail: "not_join_request",
        };
      }
      if (ctx.event.actor.id.length === 0) {
        return {
          actionId: "decline",
          status: "failed",
          detail: "missing_actor",
        };
      }
      await ctx.moderator.declineJoin({
        tenantId: ctx.event.tenantId,
        chatId: ctx.event.chatId,
        actorId: ctx.event.actor.id,
      });
      return { actionId: "decline", status: "executed" };
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

export function createLogAction(): Action {
  return defineAction({
    id: "log",
    version: "0.1.0",
    capabilities: ["observe"],
    configSchema: z.strictObject({}),
    config: {},
    async execute(ctx) {
      if (ctx.dryRun) {
        return { actionId: "log", status: "skipped", detail: "dry_run" };
      }
      const notice = buildReportNotice(ctx.event, ctx.decision);
      ctx.logger.info("moderation_logged", {
        eventId: notice.eventId,
        tenantId: notice.tenantId,
        chatId: notice.chatId,
        score: notice.score,
        rules: notice.ruleIds.join(",") || "none",
        reasons: notice.reasons.join(",") || "none",
      });
      return { actionId: "log", status: "executed" };
    },
  });
}

export function createReportAction(
  deps: { readonly notifier?: Notifier } = {},
): Action {
  return defineAction({
    id: "report",
    version: "0.1.0",
    capabilities: ["notify"],
    configSchema: z.strictObject({}),
    config: {},
    async execute(ctx) {
      if (ctx.dryRun) {
        return { actionId: "report", status: "skipped", detail: "dry_run" };
      }
      const notifier = deps.notifier;
      if (!notifier) {
        return {
          actionId: "report",
          status: "failed",
          detail: "report_unavailable",
        };
      }
      try {
        const notice = buildReportNotice(ctx.event, ctx.decision);
        await notifier.notify(notice);
        ctx.logger.info("moderation_reported", {
          eventId: notice.eventId,
          chatId: notice.chatId,
        });
        return { actionId: "report", status: "executed" };
      } catch {
        ctx.logger.warn("report_failed", {
          eventId: ctx.event.id,
          tenantId: ctx.event.tenantId,
          chatId: ctx.event.chatId,
        });
        return {
          actionId: "report",
          status: "failed",
          detail: "report_failed",
        };
      }
    },
  });
}
