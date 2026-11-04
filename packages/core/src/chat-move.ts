import type { PolicyStore } from "./policy-store.js";
import type { RuntimeStore } from "./runtime.js";

/**
 * Copies saved per-chat settings from one chat id onto another.
 * A destination that already has that setting keeps it. The source stays.
 * Returns how many settings were written.
 */
export async function copyMissingChatSettings(input: {
  readonly runtime: RuntimeStore;
  readonly policy?: PolicyStore;
  readonly tenantId: string;
  readonly fromChatId: string;
  readonly toChatId: string;
}): Promise<number> {
  if (input.fromChatId === input.toChatId) {
    return 0;
  }
  const { runtime, tenantId, fromChatId, toChatId } = input;
  let copied = 0;
  if (
    !(await runtime.getDryRun(tenantId, toChatId)) &&
    (await runtime.getDryRun(tenantId, fromChatId))
  ) {
    await runtime.setDryRun(tenantId, toChatId, true);
    copied += 1;
  }
  if ((await runtime.listRuleSwitches(tenantId, toChatId)).length === 0) {
    for (const item of await runtime.listRuleSwitches(tenantId, fromChatId)) {
      if (
        await runtime.setRuleSwitch(
          tenantId,
          toChatId,
          item.ruleId,
          item.enabled,
        )
      ) {
        copied += 1;
      }
    }
  }
  if ((await runtime.listRuleActions(tenantId, toChatId)).length === 0) {
    for (const item of await runtime.listRuleActions(tenantId, fromChatId)) {
      if (
        await runtime.setRuleAction(
          tenantId,
          toChatId,
          item.ruleId,
          item.action,
        )
      ) {
        copied += 1;
      }
    }
  }
  const report = await runtime.getReportChat(tenantId, fromChatId);
  if (
    report !== null &&
    (await runtime.getReportChat(tenantId, toChatId)) === null &&
    (await runtime.setReportChat(tenantId, toChatId, report))
  ) {
    copied += 1;
  }
  const flood = await runtime.getFloodPolicy(tenantId, fromChatId);
  if (
    flood !== null &&
    (await runtime.getFloodPolicy(tenantId, toChatId)) === null &&
    (await runtime.setFloodPolicy(tenantId, toChatId, flood))
  ) {
    copied += 1;
  }
  if ((await runtime.listKeywords(tenantId, toChatId)).length === 0) {
    for (const keyword of await runtime.listKeywords(tenantId, fromChatId)) {
      if (await runtime.addKeyword(tenantId, toChatId, keyword)) {
        copied += 1;
      }
    }
  }
  const repeat = await runtime.getRepeatPolicy(tenantId, fromChatId);
  if (
    repeat !== null &&
    (await runtime.getRepeatPolicy(tenantId, toChatId)) === null &&
    (await runtime.setRepeatPolicy(tenantId, toChatId, repeat))
  ) {
    copied += 1;
  }
  const mute = await runtime.getMuteDuration(tenantId, fromChatId);
  if (
    mute !== null &&
    (await runtime.getMuteDuration(tenantId, toChatId)) === null &&
    (await runtime.setMuteDuration(tenantId, toChatId, mute))
  ) {
    copied += 1;
  }
  const captcha = await runtime.getCaptchaTtl(tenantId, fromChatId);
  if (
    captcha !== null &&
    (await runtime.getCaptchaTtl(tenantId, toChatId)) === null &&
    (await runtime.setCaptchaTtl(tenantId, toChatId, captcha))
  ) {
    copied += 1;
  }
  const captchaFail = await runtime.getCaptchaFail(tenantId, fromChatId);
  if (
    captchaFail !== null &&
    (await runtime.getCaptchaFail(tenantId, toChatId)) === null &&
    (await runtime.setCaptchaFail(tenantId, toChatId, captchaFail))
  ) {
    copied += 1;
  }
  if ((await runtime.listAllowHosts(tenantId, toChatId)).length === 0) {
    for (const host of await runtime.listAllowHosts(tenantId, fromChatId)) {
      if (await runtime.addAllowHost(tenantId, toChatId, host)) {
        copied += 1;
      }
    }
  }
  if (input.policy) {
    const saved = await input.policy.get(tenantId, fromChatId);
    if (
      saved !== null &&
      (await input.policy.get(tenantId, toChatId)) === null
    ) {
      await input.policy.put(tenantId, toChatId, saved);
      copied += 1;
    }
  }
  return copied;
}
