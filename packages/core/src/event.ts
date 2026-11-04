import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const idSchema = z.string().min(1).max(128);

export const eventKinds = [
  "message",
  "chat_member",
  "join_request",
  "command",
  "challenge",
  "bot_membership",
] as const;
export const eventKindSchema = z.enum(eventKinds);

export const forwardKinds = ["user", "chat", "channel", "hidden"] as const;
export const forwardKindSchema = z.enum(forwardKinds);

export const mediaKinds = [
  "sticker",
  "animation",
  "photo",
  "video",
  "document",
  "voice",
  "video_note",
  "audio",
  "dice",
] as const;
export const mediaKindSchema = z.enum(mediaKinds);
export type MediaKind = z.output<typeof mediaKindSchema>;

export const botStates = ["admin", "gone"] as const;
export const botStateSchema = z.enum(botStates);

function isHostname(value: string): boolean {
  if (value.length < 1 || value.length > 253) {
    return false;
  }
  if (!/^[a-z0-9.-]+$/.test(value)) {
    return false;
  }
  if (value.includes("..") || value.startsWith(".") || value.endsWith(".")) {
    return false;
  }
  return true;
}

const hostnameSchema = z.string().refine(isHostname);

export const messageSchema = z
  .strictObject({
    id: idSchema,
    text: z.string().max(4096),
    textSha256: sha256Schema,
    /** Source class only. Titles and author names stay out. */
    forward: forwardKindSchema.optional(),
    /** Hostnames from hidden links. Paths and queries stay out. */
    hosts: z.array(hostnameSchema).min(1).max(8).optional(),
    /** Invite hostnames. The invite code stays out. */
    invites: z.array(hostnameSchema).min(1).max(8).optional(),
    /** Shared contact card. Phone numbers and names stay out. */
    contact: z.literal(true).optional(),
    /** Sent through an inline bot. The bot username stays out. */
    via: z.literal(true).optional(),
    /** Paid post that must stay. Star counts stay out. */
    paid: z.literal(true).optional(),
    /** Sent by a schedule or another implicit action. The reason stays out. */
    offline: z.literal(true).optional(),
    /** File class. File ids, names, and set titles stay out. */
    media: mediaKindSchema.optional(),
    /** Digest of the file class and file_unique_id. The id stays out. */
    mediaSha256: sha256Schema.optional(),
    /** One album. Digits only, so a caption cannot ride along. */
    albumId: z
      .string()
      .regex(/^[0-9]{1,20}$/)
      .optional(),
    /** Only user who can see this message. Names stay out. */
    audienceId: idSchema.optional(),
    /** Join or leave service line. Names stay in the visible text, if any. */
    notice: z.enum(["join", "leave"]).optional(),
    /** Sent as another channel. Channel ids and titles stay out. */
    asChannel: z.literal(true).optional(),
    /** Shared story card. Poster names, ids, and usernames stay out. */
    asStory: z.literal(true).optional(),
    /** Bare location pin. Coordinates stay out. */
    asLocation: z.literal(true).optional(),
    /** Giveaway card. Channel names, ids, and winner names stay out. */
    asGiveaway: z.literal(true).optional(),
    /** Video-chat service line. Durations and start times stay out. */
    call: z.enum(["started", "ended", "scheduled"]).optional(),
    /** Chat was renamed. The new name stays out. */
    asTitle: z.literal(true).optional(),
    /** Community service line. Names and ids stay out. */
    community: z.enum(["added", "joined", "removed"]).optional(),
  })
  .refine(
    (message) =>
      message.media !== undefined || message.mediaSha256 === undefined,
  );

export const profileSchema = z.strictObject({
  text: z.string().min(1).max(256),
  textSha256: sha256Schema,
});

export const actorSchema = z.strictObject({
  id: idSchema,
  isAdmin: z.boolean(),
  /** True when a bot joined from outside the chat. Usernames stay out. */
  bot: z.literal(true).optional(),
});

export const eventSchema = z
  .strictObject({
    id: idSchema,
    tenantId: idSchema,
    chatId: idSchema,
    kind: eventKindSchema,
    occurredAt: isoSchema,
    actor: actorSchema,
    /** True when the event is a private conversation with the bot. */
    direct: z.boolean().optional(),
    /** True when this message replaces an earlier one. */
    edited: z.literal(true).optional(),
    /** Present when a member joined from outside the chat, left it, was promoted, or was unrestricted. */
    membership: z.enum(["join", "leave", "promote", "unrestrict"]).optional(),
    /** Bot admin state. Chat titles stay out of the event. */
    bot: botStateSchema.optional(),
    /** Still in the chat. Directory state stays gone. */
    botSeat: z.literal("in").optional(),
    /** Delete right. Present only together with botRestrict. */
    botDelete: z.enum(["on", "off"]).optional(),
    /** Restrict right. Present only together with botDelete. */
    botRestrict: z.enum(["on", "off"]).optional(),
    /** Button answer. The nonce is not message text. */
    challenge: z
      .strictObject({
        nonce: z.string().regex(/^[a-f0-9]{16}$/),
        messageId: z
          .string()
          .regex(/^[1-9][0-9]{0,15}$/)
          .optional(),
      })
      .optional(),
    message: messageSchema.optional(),
    /** Visible join name. Request memory only; audits keep the hash. */
    profile: profileSchema.optional(),
    /** Guard-bot join query. Phrases and blank ids stay out. */
    joinQueryId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .optional(),
    /** Joined through a chat-folder invite. The invite link stays out. */
    folderInvite: z.literal(true).optional(),
  })
  .refine(
    (event) =>
      (event.botDelete === undefined) === (event.botRestrict === undefined),
  );

export type EventKind = z.output<typeof eventKindSchema>;
export type ForwardKind = z.output<typeof forwardKindSchema>;
export type BotState = z.output<typeof botStateSchema>;
export type MessageContent = z.output<typeof messageSchema>;
export type Profile = z.output<typeof profileSchema>;
export type Actor = z.output<typeof actorSchema>;
export type Event = z.output<typeof eventSchema>;

export function parseEvent(input: unknown): Event {
  return eventSchema.parse(input);
}
