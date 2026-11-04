import { createMemoryCaptchaStore } from "@tasb/adapter-memory";
import type { CaptchaPorts, ModerationPort, RuntimeStore } from "@tasb/core";

export const workerCaptcha = createMemoryCaptchaStore();

export function captchaExpiryHooks(
  runtime: RuntimeStore,
  moderator: ModerationPort,
): Pick<CaptchaPorts, "expiryAction" | "dismissExpired"> {
  return {
    async expiryAction(tenantId, chatId) {
      return runtime.getCaptchaFail(tenantId, chatId);
    },
    async dismissExpired(target) {
      if (target.action === "ban") {
        await moderator.banActor({
          tenantId: target.tenantId,
          chatId: target.chatId,
          actorId: target.actorId,
        });
        return;
      }
      await moderator.kickActor({
        tenantId: target.tenantId,
        chatId: target.chatId,
        actorId: target.actorId,
      });
    },
  };
}

export function createCaptchaNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
