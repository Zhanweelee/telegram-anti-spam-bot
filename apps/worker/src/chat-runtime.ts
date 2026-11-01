import { createMemoryChatDirectory } from "@tasb/cloud";

/** Chats this isolate has seen the bot administer. A restart clears them. */
export const workerChats = createMemoryChatDirectory();
