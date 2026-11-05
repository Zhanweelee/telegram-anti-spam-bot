import {
  allowHostDocumentSchema,
  allowHostSchema,
  BlocklistCapacityError,
  type BlocklistDocument,
  type BlocklistStore,
  blocklistDocumentSchema,
  blocklistEntrySchema,
  CAPTCHA_TTL_SECONDS,
  type ChatDirectory,
  type ChatDirectoryDocument,
  captchaFailDocumentSchema,
  captchaTtlDocumentSchema,
  chatDirectoryDocumentSchema,
  chatKeywordDocumentSchema,
  chatKeywordSchema,
  FLOOD_THRESHOLD,
  FLOOD_WINDOW_SECONDS,
  type FloodPolicy,
  floodPolicyDocumentSchema,
  MAX_ALLOW_HOSTS,
  MAX_BLOCKLIST_CHATS,
  MAX_BLOCKLIST_ENTRIES,
  MAX_CHAT_KEYWORDS,
  MAX_DIRECTORY_ACTORS,
  MAX_DIRECTORY_CHATS,
  MAX_RULE_SWITCHES,
  MUTE_DURATION_SECONDS,
  muteDurationDocumentSchema,
  type PolicyStore,
  prefilterPolicySchema,
  REPEAT_THRESHOLD,
  REPEAT_WINDOW_SECONDS,
  type RepeatPolicy,
  type RuleActionDocument,
  type RuleActionOverride,
  type RulePackArchive,
  type RuleSubscriptionStore,
  type RuntimeDocument,
  type RuntimeStore,
  repeatPolicyDocumentSchema,
  reportChatDocumentSchema,
  ruleActionDocumentSchema,
  ruleActionSchema,
  rulePackIdSchema,
  ruleSetSchema,
  ruleSubscriptionDocumentSchema,
  ruleSwitchSchema,
  runtimeDocumentSchema,
} from "@tasb/core";

export {
  createWorkersAiClassifier,
  FREE_PLAN_TEXT_MODEL,
  LlmUnavailableError,
  PAID_PLAN_MODELS,
  type WorkersAiBinding,
} from "./ai.js";
export {
  applyStorageMigrations,
  createD1CaptchaStore,
  createD1ReviewQueue,
  createD1Storage,
  createD1WarnStore,
  type SqlDatabase,
  type SqlPrepared,
  storageMigrationStatements,
} from "./d1.js";
export {
  hmacSha256Hex,
  sha256HexUtf8,
  signaturesMatch,
} from "./plugin-digest.js";

/**
 * Cloudflare bindings adapter.
 * D1 stores audits, rule documents, captcha challenges, and warning counts. KV stores prefilter policy,
 * per-chat runtime switches, one action override per rule, pack subscription, and the shared
 * blocklist. Workers AI is optional and stays out
 * of the committed wrangler config. Queues and Durable Objects stay
 * unused. This module must not be imported by @tasb/core, and it does
 * not import Workers types.
 */
export const cloudflareAdapter = {
  id: "cloudflare",
  version: "0.0.0",
  plannedBindings: ["d1", "kv", "ai", "queues", "durable_objects"],
} as const;

/** Minimal KV surface. The worker binding satisfies this when P0-08 wires it. */
export interface StringStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export function createKvPolicyStore(kv: StringStore): PolicyStore {
  return {
    async get(tenantId, chatId) {
      const raw = await kv.get(recordKey(tenantId, chatId));
      if (raw === null) {
        return null;
      }
      try {
        const parsed = prefilterPolicySchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
    async put(tenantId, chatId, policy) {
      const parsed = prefilterPolicySchema.parse(policy);
      await kv.put(recordKey(tenantId, chatId), JSON.stringify(parsed));
    },
  };
}

const DEFAULT_KV_TTL_MS = 60_000;

const emptyRuntime: RuntimeDocument = { dryRun: false, switches: [] };
const emptyActions: RuleActionDocument = { actions: [] };

export function createKvRuntimeStore(
  kv: StringStore,
  options?: { readonly now?: () => number; readonly ttlMs?: number },
): RuntimeStore {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_KV_TTL_MS;
  const cache = new Map<
    string,
    { readonly document: RuntimeDocument; readonly expiresAt: number }
  >();
  const actionCache = new Map<
    string,
    { readonly document: RuleActionDocument; readonly expiresAt: number }
  >();
  const reportCache = new Map<
    string,
    { readonly targetId: string | null; readonly expiresAt: number }
  >();
  const floodCache = new Map<
    string,
    { readonly policy: FloodPolicy | null; readonly expiresAt: number }
  >();
  const keywordCache = new Map<
    string,
    { readonly keywords: readonly string[]; readonly expiresAt: number }
  >();
  const repeatCache = new Map<
    string,
    { readonly policy: RepeatPolicy | null; readonly expiresAt: number }
  >();
  const muteCache = new Map<
    string,
    { readonly seconds: number | null; readonly expiresAt: number }
  >();
  const captchaCache = new Map<
    string,
    { readonly seconds: number | null; readonly expiresAt: number }
  >();
  const captchaFailCache = new Map<
    string,
    { readonly action: "kick" | "ban" | null; readonly expiresAt: number }
  >();
  const allowHostCache = new Map<
    string,
    { readonly hosts: readonly string[]; readonly expiresAt: number }
  >();

  async function load(
    tenantId: string,
    chatId: string,
  ): Promise<RuntimeDocument> {
    const id = runtimeKey(tenantId, chatId);
    const at = now();
    const hit = cache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.document;
    }
    const document = parseRuntime(await kv.get(id));
    cache.set(id, { document, expiresAt: at + ttlMs });
    return document;
  }

  async function save(
    tenantId: string,
    chatId: string,
    document: RuntimeDocument,
  ): Promise<void> {
    const id = runtimeKey(tenantId, chatId);
    const parsed = runtimeDocumentSchema.parse(document);
    await kv.put(id, JSON.stringify(parsed));
    cache.set(id, { document: parsed, expiresAt: now() + ttlMs });
  }

  async function loadActions(
    tenantId: string,
    chatId: string,
  ): Promise<RuleActionDocument> {
    const id = runtimeActionKey(tenantId, chatId);
    const at = now();
    const hit = actionCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.document;
    }
    const document = parseActions(await kv.get(id));
    actionCache.set(id, { document, expiresAt: at + ttlMs });
    return document;
  }

  async function saveActions(
    tenantId: string,
    chatId: string,
    actions: readonly RuleActionOverride[],
  ): Promise<void> {
    const id = runtimeActionKey(tenantId, chatId);
    const parsed = ruleActionDocumentSchema.parse({ actions });
    await kv.put(id, JSON.stringify(parsed));
    actionCache.set(id, { document: parsed, expiresAt: now() + ttlMs });
  }

  async function loadReport(
    tenantId: string,
    chatId: string,
  ): Promise<string | null> {
    const id = runtimeReportKey(tenantId, chatId);
    const at = now();
    const hit = reportCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.targetId;
    }
    const targetId = parseReport(await kv.get(id));
    reportCache.set(id, { targetId, expiresAt: at + ttlMs });
    return targetId;
  }

  async function saveReport(
    tenantId: string,
    chatId: string,
    targetId: string | null,
  ): Promise<void> {
    const id = runtimeReportKey(tenantId, chatId);
    const body =
      targetId === null
        ? "{}"
        : JSON.stringify(reportChatDocumentSchema.parse({ targetId }));
    await kv.put(id, body);
    reportCache.set(id, { targetId, expiresAt: now() + ttlMs });
  }

  async function loadFlood(
    tenantId: string,
    chatId: string,
  ): Promise<FloodPolicy | null> {
    const id = runtimeFloodKey(tenantId, chatId);
    const at = now();
    const hit = floodCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.policy;
    }
    const policy = parseFlood(await kv.get(id));
    floodCache.set(id, { policy, expiresAt: at + ttlMs });
    return policy;
  }

  async function saveFlood(
    tenantId: string,
    chatId: string,
    policy: FloodPolicy | null,
  ): Promise<void> {
    const id = runtimeFloodKey(tenantId, chatId);
    const body =
      policy === null
        ? "{}"
        : JSON.stringify(floodPolicyDocumentSchema.parse(policy));
    await kv.put(id, body);
    floodCache.set(id, { policy, expiresAt: now() + ttlMs });
  }

  async function loadKeywords(
    tenantId: string,
    chatId: string,
  ): Promise<readonly string[]> {
    const id = runtimeKeywordKey(tenantId, chatId);
    const at = now();
    const hit = keywordCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.keywords;
    }
    const saved = parseKeywords(await kv.get(id));
    keywordCache.set(id, { keywords: saved, expiresAt: at + ttlMs });
    return saved;
  }

  async function saveKeywords(
    tenantId: string,
    chatId: string,
    saved: readonly string[] | null,
  ): Promise<void> {
    const id = runtimeKeywordKey(tenantId, chatId);
    const keywords = saved ?? [];
    const body =
      keywords.length === 0
        ? "{}"
        : JSON.stringify(chatKeywordDocumentSchema.parse({ keywords }));
    await kv.put(id, body);
    keywordCache.set(id, { keywords, expiresAt: now() + ttlMs });
  }

  async function loadAllowHosts(
    tenantId: string,
    chatId: string,
  ): Promise<readonly string[]> {
    const id = runtimeAllowHostKey(tenantId, chatId);
    const at = now();
    const hit = allowHostCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.hosts;
    }
    const saved = parseAllowHosts(await kv.get(id));
    allowHostCache.set(id, { hosts: saved, expiresAt: at + ttlMs });
    return saved;
  }

  async function saveAllowHosts(
    tenantId: string,
    chatId: string,
    saved: readonly string[] | null,
  ): Promise<void> {
    const id = runtimeAllowHostKey(tenantId, chatId);
    const hosts = saved ?? [];
    const body =
      hosts.length === 0
        ? "{}"
        : JSON.stringify(allowHostDocumentSchema.parse({ hosts }));
    await kv.put(id, body);
    allowHostCache.set(id, { hosts, expiresAt: now() + ttlMs });
  }

  async function loadRepeat(
    tenantId: string,
    chatId: string,
  ): Promise<RepeatPolicy | null> {
    const id = runtimeRepeatKey(tenantId, chatId);
    const at = now();
    const hit = repeatCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.policy;
    }
    const policy = parseRepeat(await kv.get(id));
    repeatCache.set(id, { policy, expiresAt: at + ttlMs });
    return policy;
  }

  async function saveRepeat(
    tenantId: string,
    chatId: string,
    policy: RepeatPolicy | null,
  ): Promise<void> {
    const id = runtimeRepeatKey(tenantId, chatId);
    const body =
      policy === null
        ? "{}"
        : JSON.stringify(repeatPolicyDocumentSchema.parse(policy));
    await kv.put(id, body);
    repeatCache.set(id, { policy, expiresAt: now() + ttlMs });
  }

  async function loadMute(
    tenantId: string,
    chatId: string,
  ): Promise<number | null> {
    const id = runtimeMuteKey(tenantId, chatId);
    const at = now();
    const hit = muteCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.seconds;
    }
    const seconds = parseMute(await kv.get(id));
    muteCache.set(id, { seconds, expiresAt: at + ttlMs });
    return seconds;
  }

  async function saveMute(
    tenantId: string,
    chatId: string,
    seconds: number | null,
  ): Promise<void> {
    const id = runtimeMuteKey(tenantId, chatId);
    const body =
      seconds === null
        ? "{}"
        : JSON.stringify(muteDurationDocumentSchema.parse({ seconds }));
    await kv.put(id, body);
    muteCache.set(id, { seconds, expiresAt: now() + ttlMs });
  }

  async function loadCaptcha(
    tenantId: string,
    chatId: string,
  ): Promise<number | null> {
    const id = runtimeCaptchaKey(tenantId, chatId);
    const at = now();
    const hit = captchaCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.seconds;
    }
    const seconds = parseCaptcha(await kv.get(id));
    captchaCache.set(id, { seconds, expiresAt: at + ttlMs });
    return seconds;
  }

  async function saveCaptcha(
    tenantId: string,
    chatId: string,
    seconds: number | null,
  ): Promise<void> {
    const id = runtimeCaptchaKey(tenantId, chatId);
    const body =
      seconds === null
        ? "{}"
        : JSON.stringify(captchaTtlDocumentSchema.parse({ seconds }));
    await kv.put(id, body);
    captchaCache.set(id, { seconds, expiresAt: now() + ttlMs });
  }

  async function loadCaptchaFail(
    tenantId: string,
    chatId: string,
  ): Promise<"kick" | "ban" | null> {
    const id = runtimeCaptchaFailKey(tenantId, chatId);
    const at = now();
    const hit = captchaFailCache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.action;
    }
    const action = parseCaptchaFail(await kv.get(id));
    captchaFailCache.set(id, { action, expiresAt: at + ttlMs });
    return action;
  }

  async function saveCaptchaFail(
    tenantId: string,
    chatId: string,
    action: "kick" | "ban" | null,
  ): Promise<void> {
    const id = runtimeCaptchaFailKey(tenantId, chatId);
    const body =
      action === null
        ? "{}"
        : JSON.stringify(captchaFailDocumentSchema.parse({ action }));
    await kv.put(id, body);
    captchaFailCache.set(id, { action, expiresAt: now() + ttlMs });
  }

  return {
    async getDryRun(tenantId, chatId) {
      return (await load(tenantId, chatId)).dryRun;
    },
    async setDryRun(tenantId, chatId, enabled) {
      const current = await load(tenantId, chatId);
      if (current.dryRun === enabled) {
        return;
      }
      await save(tenantId, chatId, { ...current, dryRun: enabled });
    },
    async listRuleSwitches(tenantId, chatId) {
      return (await load(tenantId, chatId)).switches;
    },
    async setRuleSwitch(tenantId, chatId, ruleId, enabled) {
      if (!ruleSwitchSchema.safeParse({ ruleId, enabled }).success) {
        return false;
      }
      const current = await load(tenantId, chatId);
      const index = current.switches.findIndex(
        (item) => item.ruleId === ruleId,
      );
      if (index === -1 && current.switches.length >= MAX_RULE_SWITCHES) {
        return false;
      }
      if (index !== -1 && current.switches[index]?.enabled === enabled) {
        return true;
      }
      const switches =
        index === -1
          ? [...current.switches, { ruleId, enabled }]
          : current.switches.map((item) =>
              item.ruleId === ruleId ? { ruleId, enabled } : item,
            );
      await save(tenantId, chatId, { ...current, switches });
      return true;
    },
    async clearRuleSwitch(tenantId, chatId, ruleId) {
      const current = await load(tenantId, chatId);
      const switches = current.switches.filter(
        (item) => item.ruleId !== ruleId,
      );
      if (switches.length === current.switches.length) {
        return;
      }
      await save(tenantId, chatId, { ...current, switches });
    },
    async listRuleActions(tenantId, chatId) {
      return (await loadActions(tenantId, chatId)).actions;
    },
    async setRuleAction(tenantId, chatId, ruleId, action) {
      if (!ruleActionSchema.safeParse({ ruleId, action }).success) {
        return false;
      }
      const current = await loadActions(tenantId, chatId);
      const index = current.actions.findIndex((item) => item.ruleId === ruleId);
      if (index === -1 && current.actions.length >= MAX_RULE_SWITCHES) {
        return false;
      }
      if (index !== -1 && current.actions[index]?.action === action) {
        return true;
      }
      const actions =
        index === -1
          ? [...current.actions, { ruleId, action }]
          : current.actions.map((item) =>
              item.ruleId === ruleId ? { ruleId, action } : item,
            );
      await saveActions(tenantId, chatId, actions);
      return true;
    },
    async clearRuleAction(tenantId, chatId, ruleId) {
      const current = await loadActions(tenantId, chatId);
      const actions = current.actions.filter((item) => item.ruleId !== ruleId);
      if (actions.length === current.actions.length) {
        return;
      }
      await saveActions(tenantId, chatId, actions);
    },
    async getReportChat(tenantId, chatId) {
      return loadReport(tenantId, chatId);
    },
    async setReportChat(tenantId, chatId, targetId) {
      if (!reportChatDocumentSchema.safeParse({ targetId }).success) {
        return false;
      }
      const current = await loadReport(tenantId, chatId);
      if (current === targetId) {
        return true;
      }
      await saveReport(tenantId, chatId, targetId);
      return true;
    },
    async clearReportChat(tenantId, chatId) {
      const current = await loadReport(tenantId, chatId);
      if (current === null) {
        return;
      }
      await saveReport(tenantId, chatId, null);
    },
    async getFloodPolicy(tenantId, chatId) {
      return loadFlood(tenantId, chatId);
    },
    async setFloodPolicy(tenantId, chatId, policy) {
      const parsed = floodPolicyDocumentSchema.safeParse(policy);
      if (!parsed.success) {
        return false;
      }
      const current = await loadFlood(tenantId, chatId);
      const next = isDefaultFlood(parsed.data) ? null : parsed.data;
      if (sameFlood(current, next)) {
        return true;
      }
      await saveFlood(tenantId, chatId, next);
      return true;
    },
    async clearFloodPolicy(tenantId, chatId) {
      const current = await loadFlood(tenantId, chatId);
      if (current === null) {
        return;
      }
      await saveFlood(tenantId, chatId, null);
    },
    async listKeywords(tenantId, chatId) {
      return loadKeywords(tenantId, chatId);
    },
    async addKeyword(tenantId, chatId, keyword) {
      const parsed = chatKeywordSchema.safeParse(keyword);
      if (!parsed.success) {
        return false;
      }
      const current = await loadKeywords(tenantId, chatId);
      if (current.includes(parsed.data)) {
        return true;
      }
      if (current.length >= MAX_CHAT_KEYWORDS) {
        return false;
      }
      await saveKeywords(tenantId, chatId, [...current, parsed.data]);
      return true;
    },
    async removeKeyword(tenantId, chatId, keyword) {
      const parsed = chatKeywordSchema.safeParse(keyword);
      if (!parsed.success) {
        return false;
      }
      const current = await loadKeywords(tenantId, chatId);
      if (!current.includes(parsed.data)) {
        return false;
      }
      await saveKeywords(
        tenantId,
        chatId,
        current.filter((item) => item !== parsed.data),
      );
      return true;
    },
    async clearKeywords(tenantId, chatId) {
      const current = await loadKeywords(tenantId, chatId);
      if (current.length === 0) {
        return;
      }
      await saveKeywords(tenantId, chatId, null);
    },
    async getRepeatPolicy(tenantId, chatId) {
      return loadRepeat(tenantId, chatId);
    },
    async setRepeatPolicy(tenantId, chatId, policy) {
      const parsed = repeatPolicyDocumentSchema.safeParse(policy);
      if (!parsed.success) {
        return false;
      }
      const current = await loadRepeat(tenantId, chatId);
      const next = isDefaultRepeat(parsed.data) ? null : parsed.data;
      if (sameRepeat(current, next)) {
        return true;
      }
      await saveRepeat(tenantId, chatId, next);
      return true;
    },
    async clearRepeatPolicy(tenantId, chatId) {
      const current = await loadRepeat(tenantId, chatId);
      if (current === null) {
        return;
      }
      await saveRepeat(tenantId, chatId, null);
    },
    async getMuteDuration(tenantId, chatId) {
      return loadMute(tenantId, chatId);
    },
    async setMuteDuration(tenantId, chatId, seconds) {
      const parsed = muteDurationDocumentSchema.safeParse({ seconds });
      if (!parsed.success) {
        return false;
      }
      const current = await loadMute(tenantId, chatId);
      const next =
        parsed.data.seconds === MUTE_DURATION_SECONDS
          ? null
          : parsed.data.seconds;
      if (current === next) {
        return true;
      }
      await saveMute(tenantId, chatId, next);
      return true;
    },
    async clearMuteDuration(tenantId, chatId) {
      const current = await loadMute(tenantId, chatId);
      if (current === null) {
        return;
      }
      await saveMute(tenantId, chatId, null);
    },
    async getCaptchaTtl(tenantId, chatId) {
      return loadCaptcha(tenantId, chatId);
    },
    async setCaptchaTtl(tenantId, chatId, seconds) {
      const parsed = captchaTtlDocumentSchema.safeParse({ seconds });
      if (!parsed.success) {
        return false;
      }
      const current = await loadCaptcha(tenantId, chatId);
      const next =
        parsed.data.seconds === CAPTCHA_TTL_SECONDS
          ? null
          : parsed.data.seconds;
      if (current === next) {
        return true;
      }
      await saveCaptcha(tenantId, chatId, next);
      return true;
    },
    async clearCaptchaTtl(tenantId, chatId) {
      const current = await loadCaptcha(tenantId, chatId);
      if (current === null) {
        return;
      }
      await saveCaptcha(tenantId, chatId, null);
    },
    async getCaptchaFail(tenantId, chatId) {
      return loadCaptchaFail(tenantId, chatId);
    },
    async setCaptchaFail(tenantId, chatId, action) {
      if (action === "stay") {
        const current = await loadCaptchaFail(tenantId, chatId);
        if (current === null) {
          return true;
        }
        await saveCaptchaFail(tenantId, chatId, null);
        return true;
      }
      const parsed = captchaFailDocumentSchema.safeParse({ action });
      if (!parsed.success) {
        return false;
      }
      const current = await loadCaptchaFail(tenantId, chatId);
      if (current === parsed.data.action) {
        return true;
      }
      await saveCaptchaFail(tenantId, chatId, parsed.data.action);
      return true;
    },
    async clearCaptchaFail(tenantId, chatId) {
      const current = await loadCaptchaFail(tenantId, chatId);
      if (current === null) {
        return;
      }
      await saveCaptchaFail(tenantId, chatId, null);
    },
    async listAllowHosts(tenantId, chatId) {
      return loadAllowHosts(tenantId, chatId);
    },
    async addAllowHost(tenantId, chatId, host) {
      const parsed = allowHostSchema.safeParse(host);
      if (!parsed.success) {
        return false;
      }
      const current = await loadAllowHosts(tenantId, chatId);
      if (current.includes(parsed.data)) {
        return true;
      }
      if (current.length >= MAX_ALLOW_HOSTS) {
        return false;
      }
      await saveAllowHosts(tenantId, chatId, [...current, parsed.data]);
      return true;
    },
    async removeAllowHost(tenantId, chatId, host) {
      const parsed = allowHostSchema.safeParse(host);
      if (!parsed.success) {
        return false;
      }
      const current = await loadAllowHosts(tenantId, chatId);
      if (!current.includes(parsed.data)) {
        return false;
      }
      await saveAllowHosts(
        tenantId,
        chatId,
        current.filter((item) => item !== parsed.data),
      );
      return true;
    },
    async clearAllowHosts(tenantId, chatId) {
      const current = await loadAllowHosts(tenantId, chatId);
      if (current.length === 0) {
        return;
      }
      await saveAllowHosts(tenantId, chatId, null);
    },
  };
}

function parseRuntime(raw: string | null): RuntimeDocument {
  if (raw === null) {
    return emptyRuntime;
  }
  try {
    const parsed = runtimeDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyRuntime;
  } catch {
    return emptyRuntime;
  }
}

function recordKey(tenantId: string, chatId: string): string {
  return `policy\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeKey(tenantId: string, chatId: string): string {
  return `runtime\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeActionKey(tenantId: string, chatId: string): string {
  return `runtime-action\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeReportKey(tenantId: string, chatId: string): string {
  return `runtime-report\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeFloodKey(tenantId: string, chatId: string): string {
  return `runtime-flood\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeKeywordKey(tenantId: string, chatId: string): string {
  return `runtime-keyword\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeRepeatKey(tenantId: string, chatId: string): string {
  return `runtime-repeat\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeMuteKey(tenantId: string, chatId: string): string {
  return `runtime-mute\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeCaptchaKey(tenantId: string, chatId: string): string {
  return `runtime-captcha\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeCaptchaFailKey(tenantId: string, chatId: string): string {
  return `runtime-captcha-fail\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function runtimeAllowHostKey(tenantId: string, chatId: string): string {
  return `runtime-allow-host\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

function parseCaptchaFail(raw: string | null): "kick" | "ban" | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = captchaFailDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.action : null;
  } catch {
    return null;
  }
}

function parseCaptcha(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = captchaTtlDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.seconds : null;
  } catch {
    return null;
  }
}

function parseMute(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = muteDurationDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.seconds : null;
  } catch {
    return null;
  }
}

function parseAllowHosts(raw: string | null): readonly string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed = allowHostDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.hosts : [];
  } catch {
    return [];
  }
}

function parseKeywords(raw: string | null): readonly string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed = chatKeywordDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.keywords : [];
  } catch {
    return [];
  }
}

function isDefaultFlood(policy: FloodPolicy): boolean {
  return (
    policy.threshold === FLOOD_THRESHOLD &&
    policy.windowSeconds === FLOOD_WINDOW_SECONDS
  );
}

function sameFlood(
  left: FloodPolicy | null,
  right: FloodPolicy | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.threshold === right.threshold &&
    left.windowSeconds === right.windowSeconds
  );
}

function isDefaultRepeat(policy: RepeatPolicy): boolean {
  return (
    policy.threshold === REPEAT_THRESHOLD &&
    policy.windowSeconds === REPEAT_WINDOW_SECONDS
  );
}

function sameRepeat(
  left: RepeatPolicy | null,
  right: RepeatPolicy | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    left.threshold === right.threshold &&
    left.windowSeconds === right.windowSeconds
  );
}

function parseRepeat(raw: string | null): RepeatPolicy | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = repeatPolicyDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseFlood(raw: string | null): FloodPolicy | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = floodPolicyDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseReport(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = reportChatDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.targetId : null;
  } catch {
    return null;
  }
}

function parseActions(raw: string | null): RuleActionDocument {
  if (raw === null) {
    return emptyActions;
  }
  try {
    const parsed = ruleActionDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyActions;
  } catch {
    return emptyActions;
  }
}

export function createKvRuleSubscriptionStore(
  kv: StringStore,
  options?: { readonly now?: () => number; readonly ttlMs?: number },
): RuleSubscriptionStore {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_KV_TTL_MS;
  const cache = new Map<
    string,
    { readonly packId: string | null; readonly expiresAt: number }
  >();

  async function load(
    tenantId: string,
    chatId: string,
  ): Promise<string | null> {
    const id = packKey(tenantId, chatId);
    const at = now();
    const hit = cache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.packId;
    }
    const packId = parseSubscription(await kv.get(id));
    cache.set(id, { packId, expiresAt: at + ttlMs });
    return packId;
  }

  return {
    get(tenantId, chatId) {
      return load(tenantId, chatId);
    },
    async put(tenantId, chatId, packId) {
      requireSubscriptionIds(tenantId, chatId);
      const next = packId === null ? null : rulePackIdSchema.parse(packId);
      const current = await load(tenantId, chatId);
      if (current === next) {
        return;
      }
      const document = ruleSubscriptionDocumentSchema.parse({ packId: next });
      const id = packKey(tenantId, chatId);
      await kv.put(id, JSON.stringify(document));
      cache.set(id, { packId: document.packId, expiresAt: now() + ttlMs });
    },
  };
}

function parseSubscription(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = ruleSubscriptionDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.packId : null;
  } catch {
    return null;
  }
}

function packKey(tenantId: string, chatId: string): string {
  return `pack\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}`;
}

export const MAX_RULE_PACK_ARCHIVE_CHARS = 16_384;

export function createKvRulePackArchive(
  kv: StringStore,
  options?: {
    readonly now?: () => number;
    readonly ttlMs?: number;
    readonly maxChars?: number;
  },
): RulePackArchive {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_KV_TTL_MS;
  const maxChars = options?.maxChars ?? MAX_RULE_PACK_ARCHIVE_CHARS;
  const cache = new Map<
    string,
    { readonly raw: string | null; readonly expiresAt: number }
  >();

  async function loadRaw(id: string): Promise<string | null> {
    const at = now();
    const hit = cache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.raw;
    }
    const raw = await kv.get(id);
    cache.set(id, { raw, expiresAt: at + ttlMs });
    return raw;
  }

  return {
    async get(tenantId, chatId, packId) {
      requireArchiveIds(tenantId, chatId, packId);
      return parseArchived(await loadRaw(archiveKey(tenantId, chatId, packId)));
    },
    async put(tenantId, chatId, packId, rules) {
      requireArchiveIds(tenantId, chatId, packId);
      const raw = JSON.stringify(ruleSetSchema.parse(rules));
      if (raw.length > maxChars) {
        throw new Error("pack_archive_too_large");
      }
      const id = archiveKey(tenantId, chatId, packId);
      if ((await loadRaw(id)) === raw) {
        return;
      }
      await kv.put(id, raw);
      cache.set(id, { raw, expiresAt: now() + ttlMs });
    },
  };
}

function parseArchived(
  raw: string | null,
): ReturnType<typeof ruleSetSchema.parse> | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = ruleSetSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function archiveKey(tenantId: string, chatId: string, packId: string): string {
  return `pack-rules\n${tenantId.length}:${tenantId}${chatId.length}:${chatId}${packId.length}:${packId}`;
}

function requireArchiveIds(
  tenantId: string,
  chatId: string,
  packId: string,
): void {
  requireSubscriptionIds(tenantId, chatId);
  rulePackIdSchema.parse(packId);
}

const emptyBlocklist: BlocklistDocument = { chats: [], entries: [] };

export function createKvBlocklistStore(
  kv: StringStore,
  options?: { readonly now?: () => number; readonly ttlMs?: number },
): BlocklistStore {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_KV_TTL_MS;
  const cache = new Map<
    string,
    { readonly document: BlocklistDocument; readonly expiresAt: number }
  >();

  async function load(tenantId: string): Promise<BlocklistDocument> {
    requireBlocklistTenant(tenantId);
    const id = blocklistKey(tenantId);
    const at = now();
    const hit = cache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.document;
    }
    const document = parseBlocklist(await kv.get(id));
    cache.set(id, { document, expiresAt: at + ttlMs });
    return document;
  }

  async function save(
    tenantId: string,
    document: BlocklistDocument,
  ): Promise<void> {
    const id = blocklistKey(tenantId);
    const parsed = blocklistDocumentSchema.parse(document);
    await kv.put(id, JSON.stringify(parsed));
    cache.set(id, { document: parsed, expiresAt: now() + ttlMs });
  }

  return {
    async isEnabled(tenantId, chatId) {
      return (await load(tenantId)).chats.includes(chatId);
    },
    async setEnabled(tenantId, chatId, enabled) {
      const current = await load(tenantId);
      const on = current.chats.includes(chatId);
      if (enabled === on) {
        return;
      }
      if (!enabled) {
        await save(tenantId, {
          ...current,
          chats: current.chats.filter((id) => id !== chatId),
        });
        return;
      }
      if (current.chats.length >= MAX_BLOCKLIST_CHATS) {
        throw new BlocklistCapacityError();
      }
      await save(tenantId, { ...current, chats: [...current.chats, chatId] });
    },
    async has(tenantId, entry) {
      const parsed = blocklistEntrySchema.parse(entry);
      return (await load(tenantId)).entries.some(
        (item) => item.kind === parsed.kind && item.value === parsed.value,
      );
    },
    async add(tenantId, entry) {
      const parsed = blocklistEntrySchema.parse(entry);
      const current = await load(tenantId);
      if (
        current.entries.some(
          (item) => item.kind === parsed.kind && item.value === parsed.value,
        )
      ) {
        return;
      }
      if (current.entries.length >= MAX_BLOCKLIST_ENTRIES) {
        throw new BlocklistCapacityError();
      }
      await save(tenantId, {
        ...current,
        entries: [...current.entries, parsed],
      });
    },
    async remove(tenantId, entry) {
      const parsed = blocklistEntrySchema.parse(entry);
      const current = await load(tenantId);
      if (!sameBlocklistEntry(current.entries, parsed)) {
        return false;
      }
      await save(tenantId, {
        ...current,
        entries: current.entries.filter(
          (item) => item.kind !== parsed.kind || item.value !== parsed.value,
        ),
      });
      return true;
    },
    async size(tenantId) {
      return (await load(tenantId)).entries.length;
    },
  };
}

function sameBlocklistEntry(
  entries: readonly { kind: string; value: string }[],
  entry: { kind: string; value: string },
): boolean {
  return entries.some(
    (item) => item.kind === entry.kind && item.value === entry.value,
  );
}

function parseBlocklist(raw: string | null): BlocklistDocument {
  if (raw === null) {
    return emptyBlocklist;
  }
  try {
    const parsed = blocklistDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyBlocklist;
  } catch {
    return emptyBlocklist;
  }
}

function blocklistKey(tenantId: string): string {
  return `blocklist\n${tenantId.length}:${tenantId}`;
}

function requireBlocklistTenant(tenantId: string): void {
  if (!validTenant(tenantId)) {
    throw new Error("invalid_id");
  }
}

function requireSubscriptionIds(tenantId: string, chatId: string): void {
  if (
    tenantId.length < 1 ||
    tenantId.length > 128 ||
    chatId.length < 1 ||
    chatId.length > 128
  ) {
    throw new Error("invalid_id");
  }
}

const emptyDirectory: ChatDirectoryDocument = { rooms: [] };

export function createKvChatDirectory(
  kv: StringStore,
  options?: { readonly now?: () => number; readonly ttlMs?: number },
): ChatDirectory {
  const now = options?.now ?? (() => Date.now());
  const ttlMs = options?.ttlMs ?? DEFAULT_KV_TTL_MS;
  const cache = new Map<
    string,
    { readonly document: ChatDirectoryDocument; readonly expiresAt: number }
  >();

  async function load(tenantId: string): Promise<ChatDirectoryDocument> {
    const id = directoryKey(tenantId);
    const at = now();
    const hit = cache.get(id);
    if (hit && hit.expiresAt > at) {
      return hit.document;
    }
    const document = parseDirectory(await kv.get(id));
    cache.set(id, { document, expiresAt: at + ttlMs });
    return document;
  }

  async function save(
    tenantId: string,
    document: ChatDirectoryDocument,
  ): Promise<void> {
    const id = directoryKey(tenantId);
    const parsed = chatDirectoryDocumentSchema.parse(document);
    await kv.put(id, JSON.stringify(parsed));
    cache.set(id, { document: parsed, expiresAt: now() + ttlMs });
  }

  async function update(
    tenantId: string,
    change: (rooms: ChatDirectoryDocument["rooms"]) => {
      readonly rooms: ChatDirectoryDocument["rooms"];
      readonly result: "ok" | "full";
      readonly changed: boolean;
    },
  ): Promise<"ok" | "full"> {
    if (!validTenant(tenantId)) {
      return "ok";
    }
    const current = await load(tenantId);
    const next = change(current.rooms);
    if (next.changed) {
      await save(tenantId, { rooms: next.rooms });
    }
    return next.result;
  }

  return {
    noteBot(input) {
      if (!validId(input.chatId)) {
        return Promise.resolve("ok");
      }
      if (input.state === "gone") {
        return update(input.tenantId, (rooms) => {
          const next = rooms.filter((room) => room.chatId !== input.chatId);
          return {
            rooms: next,
            result: "ok",
            changed: next.length !== rooms.length,
          };
        });
      }
      if (!validId(input.actorId)) {
        return Promise.resolve("ok");
      }
      return update(input.tenantId, (rooms) =>
        grant(rooms, input.chatId, input.actorId),
      );
    },
    noteMember(input) {
      if (!validId(input.chatId) || !validId(input.actorId)) {
        return Promise.resolve("ok");
      }
      return update(input.tenantId, (rooms) =>
        input.admin
          ? grant(rooms, input.chatId, input.actorId)
          : revoke(rooms, input.chatId, input.actorId),
      );
    },
    async chatsFor(tenantId, actorId) {
      if (!validTenant(tenantId) || !validId(actorId)) {
        return [];
      }
      const document = await load(tenantId);
      return document.rooms
        .filter((room) => room.actorIds.includes(actorId))
        .map((room) => room.chatId)
        .sort();
    },
    async operators(tenantId, chatId) {
      if (!validTenant(tenantId) || !validId(chatId)) {
        return [];
      }
      const document = await load(tenantId);
      const room = document.rooms.find((item) => item.chatId === chatId);
      return room ? [...room.actorIds] : [];
    },
    async list(tenantId) {
      if (!validTenant(tenantId)) {
        return [];
      }
      const document = await load(tenantId);
      return document.rooms.map((room) => room.chatId).sort();
    },
  };
}

function grant(
  rooms: ChatDirectoryDocument["rooms"],
  chatId: string,
  actorId: string,
): {
  readonly rooms: ChatDirectoryDocument["rooms"];
  readonly result: "ok" | "full";
  readonly changed: boolean;
} {
  if (!validId(chatId)) {
    return { rooms, result: "ok", changed: false };
  }
  const index = rooms.findIndex((room) => room.chatId === chatId);
  if (index === -1) {
    if (rooms.length >= MAX_DIRECTORY_CHATS) {
      return { rooms, result: "full", changed: false };
    }
    return {
      rooms: [...rooms, { chatId, actorIds: [actorId] }],
      result: "ok",
      changed: true,
    };
  }
  const room = rooms[index];
  if (!room || room.actorIds.includes(actorId)) {
    return { rooms, result: "ok", changed: false };
  }
  if (room.actorIds.length >= MAX_DIRECTORY_ACTORS) {
    return { rooms, result: "ok", changed: false };
  }
  return {
    rooms: rooms.map((item, itemIndex) =>
      itemIndex === index
        ? { chatId, actorIds: [...item.actorIds, actorId] }
        : item,
    ),
    result: "ok",
    changed: true,
  };
}

function revoke(
  rooms: ChatDirectoryDocument["rooms"],
  chatId: string,
  actorId: string,
): {
  readonly rooms: ChatDirectoryDocument["rooms"];
  readonly result: "ok" | "full";
  readonly changed: boolean;
} {
  const index = rooms.findIndex((room) => room.chatId === chatId);
  const room = index === -1 ? undefined : rooms[index];
  if (!room?.actorIds.includes(actorId)) {
    return { rooms, result: "ok", changed: false };
  }
  return {
    rooms: rooms.map((item, itemIndex) =>
      itemIndex === index
        ? {
            chatId,
            actorIds: item.actorIds.filter((id) => id !== actorId),
          }
        : item,
    ),
    result: "ok",
    changed: true,
  };
}

function parseDirectory(raw: string | null): ChatDirectoryDocument {
  if (raw === null) {
    return emptyDirectory;
  }
  try {
    const parsed = chatDirectoryDocumentSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyDirectory;
  } catch {
    return emptyDirectory;
  }
}

function directoryKey(tenantId: string): string {
  return `chats\n${tenantId.length}:${tenantId}`;
}

function validTenant(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes("\n");
}

function validId(value: string): boolean {
  return /^-?\d{1,20}$/.test(value);
}
