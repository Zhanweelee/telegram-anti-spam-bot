import {
  type BotState,
  type ChatDirectory,
  type ChatDirectoryResult,
  type ChatNote,
  MAX_DIRECTORY_ACTORS,
  MAX_DIRECTORY_CHATS,
} from "@tasb/core";

const maxChatsDefault = MAX_DIRECTORY_CHATS;
const maxActors = MAX_DIRECTORY_ACTORS;

interface Room {
  actors: string[];
}

export function createMemoryChatDirectory(options?: {
  readonly maxChats?: number;
}): ChatDirectory {
  const maxChats = options?.maxChats ?? maxChatsDefault;
  const rooms = new Map<string, Room>();
  return {
    async noteBot(input) {
      return noteBot(rooms, maxChats, input);
    },
    async noteMember(input) {
      return noteMember(rooms, maxChats, input);
    },
    async chatsFor(tenantId, actorId) {
      return chatsFor(rooms, tenantId, actorId);
    },
    async list(tenantId) {
      return listChats(rooms, tenantId);
    },
  };
}

function noteBot(
  rooms: Map<string, Room>,
  maxChats: number,
  input: ChatNote & { readonly state: BotState },
): ChatDirectoryResult {
  if (!validTenant(input.tenantId) || !validId(input.chatId)) {
    return "ok";
  }
  const key = roomKey(input.tenantId, input.chatId);
  if (input.state === "gone") {
    rooms.delete(key);
    return "ok";
  }
  if (!validId(input.actorId)) {
    return "ok";
  }
  return remember(rooms, maxChats, key, input.actorId);
}

function noteMember(
  rooms: Map<string, Room>,
  maxChats: number,
  input: ChatNote & { readonly admin: boolean },
): ChatDirectoryResult {
  if (
    !validTenant(input.tenantId) ||
    !validId(input.chatId) ||
    !validId(input.actorId)
  ) {
    return "ok";
  }
  const key = roomKey(input.tenantId, input.chatId);
  if (!input.admin) {
    const room = rooms.get(key);
    if (room) {
      room.actors = room.actors.filter((id) => id !== input.actorId);
    }
    return "ok";
  }
  return remember(rooms, maxChats, key, input.actorId);
}

function remember(
  rooms: Map<string, Room>,
  maxChats: number,
  key: string,
  actorId: string,
): ChatDirectoryResult {
  let room = rooms.get(key);
  if (!room) {
    if (rooms.size >= maxChats) {
      return "full";
    }
    room = { actors: [] };
    rooms.set(key, room);
  }
  if (!room.actors.includes(actorId) && room.actors.length < maxActors) {
    room.actors.push(actorId);
  }
  return "ok";
}

function chatsFor(
  rooms: Map<string, Room>,
  tenantId: string,
  actorId: string,
): readonly string[] {
  const ids: string[] = [];
  for (const [key, room] of rooms) {
    const parsed = parseKey(key);
    if (
      parsed &&
      parsed.tenantId === tenantId &&
      room.actors.includes(actorId)
    ) {
      ids.push(parsed.chatId);
    }
  }
  ids.sort();
  return ids;
}

function listChats(
  rooms: Map<string, Room>,
  tenantId: string,
): readonly string[] {
  const ids: string[] = [];
  for (const key of rooms.keys()) {
    const parsed = parseKey(key);
    if (parsed && parsed.tenantId === tenantId) {
      ids.push(parsed.chatId);
    }
  }
  ids.sort();
  return ids;
}

function roomKey(tenantId: string, chatId: string): string {
  return `${tenantId}\n${chatId}`;
}

function parseKey(
  key: string,
): { readonly tenantId: string; readonly chatId: string } | null {
  const splitAt = key.indexOf("\n");
  if (splitAt <= 0) {
    return null;
  }
  return {
    tenantId: key.slice(0, splitAt),
    chatId: key.slice(splitAt + 1),
  };
}

function validTenant(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes("\n");
}

function validId(value: string): boolean {
  return /^-?\d{1,20}$/.test(value);
}
