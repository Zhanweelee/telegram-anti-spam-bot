import { z } from "zod";
import type { BotState } from "./event.js";

/** One tenant directory holds at most this many chats. */
export const MAX_DIRECTORY_CHATS = 256;
/** One chat remembers at most this many operators. */
export const MAX_DIRECTORY_ACTORS = 32;

const directoryIdSchema = z.string().regex(/^-?\d{1,20}$/);

export const chatDirectoryDocumentSchema = z
  .strictObject({
    rooms: z
      .array(
        z.strictObject({
          chatId: directoryIdSchema,
          actorIds: z.array(directoryIdSchema).max(MAX_DIRECTORY_ACTORS),
        }),
      )
      .max(MAX_DIRECTORY_CHATS),
  })
  .superRefine((value, ctx) => {
    const chats = new Set<string>();
    for (const room of value.rooms) {
      if (chats.has(room.chatId)) {
        ctx.addIssue({
          code: "custom",
          message: "duplicate_chat_id",
          path: ["rooms"],
        });
      }
      chats.add(room.chatId);
      const actors = new Set<string>();
      for (const actorId of room.actorIds) {
        if (actors.has(actorId)) {
          ctx.addIssue({
            code: "custom",
            message: "duplicate_actor_id",
            path: ["rooms"],
          });
        }
        actors.add(actorId);
      }
    }
  });

export type ChatDirectoryDocument = z.output<
  typeof chatDirectoryDocumentSchema
>;

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
  /** People remembered for one chat, in the order they were noted. */
  operators(tenantId: string, chatId: string): Promise<readonly string[]>;
  list(tenantId: string): Promise<readonly string[]>;
}
