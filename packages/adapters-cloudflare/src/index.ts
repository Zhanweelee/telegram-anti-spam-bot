import {
  type ChatDirectory,
  type ChatDirectoryDocument,
  chatDirectoryDocumentSchema,
  MAX_DIRECTORY_ACTORS,
  MAX_DIRECTORY_CHATS,
  MAX_RULE_SWITCHES,
  type PolicyStore,
  prefilterPolicySchema,
  type RulePackArchive,
  type RuleSubscriptionStore,
  type RuntimeDocument,
  type RuntimeStore,
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
  createD1ReviewQueue,
  createD1Storage,
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
 * D1 stores audits and rule documents. KV stores prefilter policy and
 * the per-chat runtime switches and pack subscription. Workers AI is optional and stays out
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
