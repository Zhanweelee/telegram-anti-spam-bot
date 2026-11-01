import { z } from "zod";

/** Actor ids are identifiers, never a sentence. */
const actorValueSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const hashValueSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const MAX_BLOCKLIST_ENTRIES = 256;
export const MAX_BLOCKLIST_CHATS = 128;

export const blocklistEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("actor"),
    value: actorValueSchema,
  }),
  z.strictObject({
    kind: z.literal("hash"),
    value: hashValueSchema,
  }),
]);

export type BlocklistEntry = z.output<typeof blocklistEntrySchema>;

export interface BlocklistSnapshotEntry {
  readonly tenantId: string;
  readonly kind: BlocklistEntry["kind"];
  readonly value: string;
}

export interface BlocklistSnapshot {
  readonly chats: readonly string[];
  readonly entries: readonly BlocklistSnapshotEntry[];
}

/**
 * Tenant-scoped shared identifiers. Opt-in is per chat and defaults to off.
 * `has` reads the shared set. Callers that honor opt-in must not call it
 * while that chat is off.
 */
export interface BlocklistStore {
  isEnabled(tenantId: string, chatId: string): Promise<boolean>;
  setEnabled(tenantId: string, chatId: string, enabled: boolean): Promise<void>;
  has(tenantId: string, entry: BlocklistEntry): Promise<boolean>;
  add(tenantId: string, entry: BlocklistEntry): Promise<void>;
}

export class BlocklistCapacityError extends Error {
  constructor() {
    super("blocklist_full");
    this.name = "BlocklistCapacityError";
  }
}

export function parseBlocklistEntry(input: unknown): BlocklistEntry {
  return blocklistEntrySchema.parse(input);
}

export function createMemoryBlocklistStore(): BlocklistStore & {
  snapshot(): BlocklistSnapshot;
} {
  const chats = new Set<string>();
  const entries = new Map<string, Set<string>>();
  return {
    async isEnabled(tenantId, chatId) {
      return chats.has(chatKey(tenantId, chatId));
    },
    async setEnabled(tenantId, chatId, enabled) {
      const id = chatKey(tenantId, chatId);
      if (!enabled) {
        chats.delete(id);
        return;
      }
      if (chats.has(id)) {
        return;
      }
      if (countChats(chats, tenantId) >= MAX_BLOCKLIST_CHATS) {
        throw new BlocklistCapacityError();
      }
      chats.add(id);
    },
    async has(tenantId, entry) {
      const parsed = parseBlocklistEntry(entry);
      return entries.get(tenantId)?.has(entryId(parsed)) ?? false;
    },
    async add(tenantId, entry) {
      const parsed = parseBlocklistEntry(entry);
      const id = entryId(parsed);
      let set = entries.get(tenantId);
      if (!set) {
        set = new Set();
        entries.set(tenantId, set);
      }
      if (set.has(id)) {
        return;
      }
      if (set.size >= MAX_BLOCKLIST_ENTRIES) {
        throw new BlocklistCapacityError();
      }
      set.add(id);
    },
    snapshot() {
      const listed: BlocklistSnapshotEntry[] = [];
      for (const [tenantId, set] of entries) {
        for (const id of set) {
          listed.push({ tenantId, ...splitEntry(id) });
        }
      }
      return { chats: [...chats], entries: listed };
    },
  };
}

function chatKey(tenantId: string, chatId: string): string {
  return `${tenantId.length}:${tenantId}\n${chatId.length}:${chatId}`;
}

function countChats(chats: ReadonlySet<string>, tenantId: string): number {
  const prefix = `${tenantId.length}:${tenantId}\n`;
  let count = 0;
  for (const key of chats) {
    if (key.startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
}

function entryId(entry: BlocklistEntry): string {
  return `${entry.kind}\n${entry.value}`;
}

function splitEntry(id: string): {
  kind: BlocklistEntry["kind"];
  value: string;
} {
  const split = id.indexOf("\n");
  const kind = id.slice(0, split);
  const value = id.slice(split + 1);
  if (kind === "hash") {
    return { kind, value };
  }
  return { kind: "actor", value };
}
