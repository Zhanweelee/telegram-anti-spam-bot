export const WARN_LIMIT = 3;
export const MIN_WARN_LIMIT = 1;
export const MAX_WARN_LIMIT = 10;
export const MAX_WARN_CHATS = 128;
export const MAX_WARN_ACTORS = 64;

export function normalizeWarnLimit(value: number): number {
  if (
    Number.isInteger(value) &&
    value >= MIN_WARN_LIMIT &&
    value <= MAX_WARN_LIMIT
  ) {
    return value;
  }
  return WARN_LIMIT;
}

export class WarnCapacityError extends Error {
  constructor() {
    super("warn_capacity");
    this.name = "WarnCapacityError";
  }
}

export interface WarnTarget {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
}

export interface WarnCount {
  readonly actorId: string;
  readonly count: number;
}

export interface WarnStore {
  read(target: WarnTarget): Promise<number>;
  increment(target: WarnTarget): Promise<number>;
  write(target: WarnTarget, count: number): Promise<void>;
  clear(target: WarnTarget): Promise<boolean>;
  list(tenantId: string, chatId: string): Promise<readonly WarnCount[]>;
  readLimit(tenantId: string, chatId: string): Promise<number>;
  writeLimit(tenantId: string, chatId: string, limit: number): Promise<void>;
}

export function sortWarnCounts(
  rows: readonly WarnCount[],
): readonly WarnCount[] {
  return [...rows].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    return compareActorId(left.actorId, right.actorId);
  });
}

export function createMemoryWarnStore(): WarnStore {
  const chats = new Map<string, Map<string, number>>();
  const limits = new Map<string, number>();

  return {
    async read(target) {
      return chats.get(chatKey(target))?.get(target.actorId) ?? 0;
    },
    async increment(target) {
      const actors = actorsFor(chats, target, true);
      const next = (actors.get(target.actorId) ?? 0) + 1;
      actors.set(target.actorId, next);
      return next;
    },
    async write(target, count) {
      if (!Number.isInteger(count) || count < 0) {
        throw new WarnCapacityError();
      }
      if (count === 0) {
        drop(chats, target);
        return;
      }
      const actors = actorsFor(chats, target, !hasActor(chats, target));
      actors.set(target.actorId, count);
    },
    async clear(target) {
      return drop(chats, target);
    },
    async list(tenantId, chatId) {
      const actors = chats.get(`${tenantId}\n${chatId}`);
      if (actors === undefined) {
        return [];
      }
      const rows: WarnCount[] = [];
      for (const [actorId, count] of actors) {
        rows.push({ actorId, count });
      }
      return sortWarnCounts(rows);
    },
    async readLimit(tenantId, chatId) {
      return limits.get(limitKey(tenantId, chatId)) ?? WARN_LIMIT;
    },
    async writeLimit(tenantId, chatId, limit) {
      if (
        !Number.isInteger(limit) ||
        limit < MIN_WARN_LIMIT ||
        limit > MAX_WARN_LIMIT
      ) {
        throw new WarnCapacityError();
      }
      const key = limitKey(tenantId, chatId);
      if (limit === WARN_LIMIT) {
        limits.delete(key);
        return;
      }
      if (!limits.has(key) && limits.size >= MAX_WARN_CHATS) {
        throw new WarnCapacityError();
      }
      limits.set(key, limit);
    },
  };
}

function limitKey(tenantId: string, chatId: string): string {
  return `${tenantId}\n${chatId}`;
}

function compareActorId(left: string, right: string): number {
  const leftDigits = /^-?\d+$/.test(left);
  const rightDigits = /^-?\d+$/.test(right);
  if (leftDigits && rightDigits) {
    const delta = BigInt(left) - BigInt(right);
    if (delta < 0n) {
      return -1;
    }
    if (delta > 0n) {
      return 1;
    }
    return 0;
  }
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function chatKey(target: WarnTarget): string {
  return `${target.tenantId}\n${target.chatId}`;
}

function hasActor(
  chats: Map<string, Map<string, number>>,
  target: WarnTarget,
): boolean {
  return chats.get(chatKey(target))?.has(target.actorId) ?? false;
}

function actorsFor(
  chats: Map<string, Map<string, number>>,
  target: WarnTarget,
  creating: boolean,
): Map<string, number> {
  const key = chatKey(target);
  const existing = chats.get(key);
  if (!creating) {
    if (existing === undefined) {
      throw new WarnCapacityError();
    }
    return existing;
  }
  const actors = existing ?? new Map<string, number>();
  if (actors.has(target.actorId)) {
    return actors;
  }
  if (actors.size >= MAX_WARN_ACTORS) {
    throw new WarnCapacityError();
  }
  if (existing === undefined && chats.size >= MAX_WARN_CHATS) {
    throw new WarnCapacityError();
  }
  if (existing === undefined) {
    chats.set(key, actors);
  }
  return actors;
}

function drop(
  chats: Map<string, Map<string, number>>,
  target: WarnTarget,
): boolean {
  const key = chatKey(target);
  const actors = chats.get(key);
  if (actors === undefined || !actors.has(target.actorId)) {
    return false;
  }
  actors.delete(target.actorId);
  if (actors.size === 0) {
    chats.delete(key);
  }
  return true;
}
