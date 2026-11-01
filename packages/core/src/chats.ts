import type { BotState } from "./event.js";

export interface ChatNote {
  readonly tenantId: string;
  readonly chatId: string;
  readonly actorId: string;
}

export type ChatDirectoryResult = "ok" | "full";

/**
 * Which chats a person may operate after they make the bot an admin.
 * Counting and payment stay outside this port.
 */
export interface ChatDirectory {
  noteBot(
    input: ChatNote & { readonly state: BotState },
  ): Promise<ChatDirectoryResult>;
  noteMember(
    input: ChatNote & { readonly admin: boolean },
  ): Promise<ChatDirectoryResult>;
  chatsFor(tenantId: string, actorId: string): Promise<readonly string[]>;
  list(tenantId: string): Promise<readonly string[]>;
}
