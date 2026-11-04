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
    /** Shared chat card. Titles, usernames, and ids stay out. */
    asSharedChat: z.literal(true).optional(),
    /** Chat photo service line. File ids and sizes stay out. */
    photo: z.enum(["set", "cleared"]).optional(),
    /** Chat background service line. Filenames, file ids, and theme names stay out. */
    background: z.enum(["wallpaper", "pattern", "fill", "theme"]).optional(),
    /** Gift service line. Star counts, ids, and publisher names stay out. */
    gift: z.enum(["card", "unique", "upgrade"]).optional(),
    /** Pin service line. The pinned message stays out. */
    asPin: z.literal(true).optional(),
    /** Giveaway creation or private completion. Counts and the prize message stay out. */
    giveawayNotice: z.enum(["created", "completed"]).optional(),
    /** Boost service line. The boost count stays out. */
    asBoost: z.literal(true).optional(),
    /** Forum service line. Topic names stay out. */
    forumNotice: z.enum(["closed", "reopened", "hidden", "shown"]).optional(),
    /** Auto-delete timer service line. The seconds stay out. */
    asAutoDelete: z.literal(true).optional(),
    /** Price-change service line. Star counts stay out. */
    priceNotice: z.enum(["paid", "direct"]).optional(),
    /** Suggested-post service line. The nested post stays out. */
    postNotice: z.enum(["approved", "failed", "paid", "refunded"]).optional(),
    /** Checklist done or undone service line. Task ids stay out. */
    checklistNotice: z.enum(["done", "undone"]).optional(),
    /** Video-chat invite. User ids stay out. Invited names stay in the text. */
    asCallInvite: z.literal(true).optional(),
    /** Owner change or owner left. User ids stay out. The new name stays in the text. */
    ownerNotice: z.enum(["changed", "left"]).optional(),
    /** Proximity alert. Distance and user ids stay out. Names stay in the text. */
    asProximity: z.literal(true).optional(),
    /** Poll option added or deleted. The option id and the poll stay out. */
    pollNotice: z.enum(["added", "deleted"]).optional(),
    /** Added checklist tasks. Task ids and the checklist stay out. Task text stays in the message. */
    asChecklistAdded: z.literal(true).optional(),
    /** Forum topic created or renamed. Icon color and emoji id stay out. The name stays in the message. */
    topicNotice: z.enum(["created", "edited"]).optional(),
    /** Declined suggested post. The nested post stays out. The comment stays in the message. */
    asPostDeclined: z.literal(true).optional(),
    /** Basic group created. Supergroup and channel creation stay out. */
    asGroupCreated: z.literal(true).optional(),
    /** Pending suggested post. Price and send date stay out. The post text stays in the message. */
    asPostPending: z.literal(true).optional(),
    /** Media covered by a spoiler. The file id stays out. The caption stays in the message. */
    asSpoiler: z.literal(true).optional(),
    /** Rich text phone number. The number stays out. The visible text stays in the message. */
    asRichPhone: z.literal(true).optional(),
    /** Rich text bank card. The number stays out. The visible text stays in the message. */
    asRichCard: z.literal(true).optional(),
    /** Rich text email address. The address stays out. The visible text stays in the message. */
    asRichEmail: z.literal(true).optional(),
    /** Rich text map. Coordinates stay out. The caption stays in the message. */
    asRichMap: z.literal(true).optional(),
    /** Rich text username mention. The username stays out. The visible text stays in the message. */
    asRichMention: z.literal(true).optional(),
    /** Rich text user mention. The user id stays out. The visible text stays in the message. */
    asRichTextMention: z.literal(true).optional(),
    /** Rich text bot command. The command stays out. The visible text stays in the message. */
    asRichCommand: z.literal(true).optional(),
    /** Rich text hashtag. The tag stays out. The visible text stays in the message. */
    asRichHashtag: z.literal(true).optional(),
    /** Rich text cashtag. The ticker stays out. The visible text stays in the message. */
    asRichCashtag: z.literal(true).optional(),
    /** Rich text anchor. The name stays out. The visible text stays in the message. */
    asRichAnchor: z.literal(true).optional(),
    /** Rich text anchor link. The anchor name stays out. The visible text stays in the message. */
    asRichAnchorLink: z.literal(true).optional(),
    /** Rich text reference. The name stays out. The visible text stays in the message. */
    asRichReference: z.literal(true).optional(),
    /** Rich text reference link. The reference name stays out. The visible text stays in the message. */
    asRichReferenceLink: z.literal(true).optional(),
    /** Ordinary text mention. The user id stays out. The visible text stays in the message. */
    asTextMention: z.literal(true).optional(),
    /** Custom emoji. The emoji id stays out. The visible text stays in the message. */
    asCustomEmoji: z.literal(true).optional(),
    /** Copy-to-clipboard button. The copied sentence stays out. The visible label stays in the message. */
    asCopyText: z.literal(true).optional(),
    /** Inline query inserted on tap. The query stays out. The visible label stays in the message. */
    asSwitchQuery: z.literal(true).optional(),
    /** Login button text shown after a forward. The sentence stays out. The visible label stays in the message. */
    asLoginForward: z.literal(true).optional(),
    /** Custom emoji shown on an inline button. The emoji id stays out. The visible label stays in the message. */
    asButtonEmoji: z.literal(true).optional(),
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
    /** This chat's saved settings also belong on `to`. The source stays. */
    chatMove: z
      .strictObject({
        from: idSchema,
        to: idSchema,
      })
      .optional(),
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
