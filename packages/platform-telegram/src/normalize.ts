import {
  androidStrictTld,
  androidUrlSpan,
  type Event,
  type ForwardKind,
  foldBracketDots,
  foldCyrillicLookalikes,
  foldDotLookalikes,
  foldEncodedAlphabet,
  foldEncodedGaps,
  foldEncodedMiddleDot,
  foldEncodedSeparators,
  foldFullwidthLatin,
  foldHostInterrupters,
  foldHostScan,
  foldMappedLatin,
  foldMatchText,
  type MediaKind,
  parseEvent,
} from "@tasb/core";
import { sha256Hex } from "./hash.js";

const MAX_TEXT = 4096;

export interface NormalizeInput {
  readonly update: unknown;
  readonly tenantId: string;
  readonly adminUserIds: readonly string[];
  readonly nowIso: string;
}

export type NormalizeOutcome =
  | { readonly status: "event"; readonly event: Event }
  | { readonly status: "ignored" }
  | { readonly status: "invalid" };

export async function normalizeUpdate(
  input: NormalizeInput,
): Promise<NormalizeOutcome> {
  if (!isRecord(input.update)) {
    return { status: "invalid" };
  }
  const updateId = safeId(input.update.update_id);
  if (updateId === null || updateId < 0) {
    return { status: "invalid" };
  }
  if (Object.hasOwn(input.update, "callback_query")) {
    return callbackEvent(input.update.callback_query, updateId, input);
  }
  if (Object.hasOwn(input.update, "my_chat_member")) {
    return botMembershipEvent(input.update.my_chat_member, updateId, input);
  }
  if (Object.hasOwn(input.update, "chat_member")) {
    return await chatMemberEvent(input.update.chat_member, updateId, input);
  }
  if (Object.hasOwn(input.update, "chat_join_request")) {
    return joinRequestEvent(input.update.chat_join_request, updateId, input);
  }
  if (Object.hasOwn(input.update, "edited_message")) {
    return messageEvent(input.update.edited_message, updateId, input, true);
  }
  if (!Object.hasOwn(input.update, "message")) {
    return { status: "ignored" };
  }
  return messageEvent(input.update.message, updateId, input, false);
}

function callbackEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): NormalizeOutcome {
  if (!isRecord(value) || typeof value.data !== "string") {
    return { status: "ignored" };
  }
  const matched = /^c:([a-f0-9]{16})$/.exec(value.data);
  const nonce = matched?.[1];
  if (!nonce) {
    return { status: "ignored" };
  }
  const actor = nestedId(value.from);
  const message = isRecord(value.message) ? value.message : null;
  const chatId = message ? nestedId(message.chat) : null;
  if (!actor || !chatId) {
    return { status: "ignored" };
  }
  const admins = new Set(input.adminUserIds);
  const clickedId = promptMessageId(message?.message_id);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "challenge" as const,
    occurredAt: occurredAt(message?.date, input.nowIso),
    actor: { id: actor, isAdmin: admins.has(actor) },
    challenge: {
      nonce,
      ...(clickedId ? { messageId: clickedId } : {}),
    },
  });
}

function promptMessageId(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  const text = String(value);
  return /^[1-9][0-9]{0,15}$/.test(text) ? text : undefined;
}

async function messageEvent(
  message: unknown,
  updateId: number,
  input: NormalizeInput,
  edited: boolean,
): Promise<NormalizeOutcome> {
  if (!isRecord(message)) {
    return { status: "ignored" };
  }
  if (foreignChat(message)) {
    return { status: "ignored" };
  }
  const chatId = nestedId(message.chat);
  const audienceId = positiveId(nestedId(message.receiver_user));
  const ephemeralId = positiveId(message.ephemeral_message_id);
  const messageId =
    ephemeralId !== null && audienceId !== null
      ? ephemeralId
      : idString(message.message_id);
  const actor = nestedId(message.from) ?? nestedId(message.sender_chat);
  if (!chatId || !messageId || !actor) {
    return { status: "ignored" };
  }
  if (messageId === "0" && ephemeralId === null) {
    return { status: "ignored" };
  }
  const text = messageText(message);
  const sideTag = besideSenderTag(message, text);
  const sideButtons = besideButtonText(message, text);
  const sideSignature = besideAuthorSignature(message, text);
  const sideMirror = besideMirrorSignature(message, text);
  const sidePoll = besidePollOption(message, text);
  const sideTasks = besideChecklistTask(message, text);
  const sideMedia = besideMediaName(message, text);
  const sidePerformer = besidePerformer(message, text);
  const sideGame = besideGameText(message, text);
  const sideInvoice = besideInvoiceText(message, text);
  const sideVenue = besideVenueAddress(message, text);
  const sideExplanation = besidePollExplanation(message, text);
  const sideQuestion = besidePollQuestion(message, text);
  const sidePrize = besidePrizeText(message, text);
  const sideChecklist = besideChecklistTitle(message, text);
  const sideGameTitle = besideCardTitle(message, "game", 4096, text);
  const sideInvoiceTitle = besideCardTitle(message, "invoice", 32, text);
  const sideVenueTitle = besideCardTitle(message, "venue", 4096, text);
  const sideWebAppButton = besideWebAppButton(message, text);
  const sideQuote = besideManualQuote(message, text);
  const sideGift = besideGiftText(message, text);
  const sideGiftLabel = besideGiftLabel(message, text);
  const sideTopic = besideTopicName(message, text);
  const sideDecline = besideDeclineComment(message, text);
  const sideAdded = besideAddedText(message, text);
  const sideHidden = besideHiddenName(message, text);
  const sideMember = besideMemberName(message, text);
  const sideShared = besideSharedName(message, text);
  const sideManaged = besideManagedName(message, text);
  const sideAccess = besideAccessName(message, text);
  const sideGameFile = besideGameFile(message, text);
  const sideAudioFile = besideAudioFile(message, text);
  const sidePaidFile = besidePaidFile(message, text);
  const sideRichName = besideRichName(message, text);
  const sidePollMedia = besidePollMedia(message, text);
  const sidePollDescription = besidePollDescription(message, text);
  const sideRichText = besideRichText(message, text);
  const sideRichButton = besideRichButton(message, text);
  const sideLaterName = besideLaterName(message, text);
  const forward = forwardKind(message);
  const links = linkHosts(message);
  const media = await mediaMark(message);
  const albumId = albumToken(message.media_group_id);
  const notice = serviceNotice(message);
  const asChannel = sentAsForeignChannel(message);
  const asStory = sharedStory(message);
  const asLocation = bareLocation(message);
  const asGiveaway = sharedGiveaway(message);
  const call = callNotice(message);
  const asTitle = renamedChat(message);
  const community = communityNotice(message);
  const asSharedChat = sharedChatCard(message);
  const photo = photoNotice(message);
  const background = backgroundNotice(message);
  const gift = giftNotice(message);
  const asPin = pinnedNotice(message);
  const giveawayNotice = scheduledGiveaway(message);
  const asBoost = addedBoost(message);
  const forumNotice = forumService(message);
  const asAutoDelete = autoDeleteNotice(message);
  const priceNotice = changedPrice(message);
  const postNotice = suggestedPost(message);
  const checklistNotice = taskNotice(message);
  const asCallInvite = videoInvite(message);
  const ownerNotice = changedOwner(message);
  const asProximity = nearUsers(message);
  const pollNotice = changedPoll(message);
  const asChecklistAdded = addedChecklist(message);
  const topicNotice = changedTopic(message);
  const asPostDeclined = declinedPost(message);
  const asGroupCreated = createdGroup(message);
  const asPostPending = pendingPost(message);
  const asSpoiler = coveredMedia(message);
  const asEffect = messageEffect(message);
  const richContact = richContactMark(message);
  const asTextMention = textMentionMark(message);
  const asCustomEmoji = customEmojiMark(message);
  const asCopyText = copyTextMark(message);
  const asSwitchQuery = switchQueryMark(message);
  const asLoginForward = loginForwardMark(message);
  const asButtonEmoji = buttonEmojiMark(message);
  const asStickerEmoji = stickerEmojiMark(message);
  const asRichMap = richMap(message);
  const chatMove = movedChat(message, chatId);
  const direct = isPrivateChat(message.chat);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "message" as const,
    occurredAt: occurredAt(message.date, input.nowIso),
    actor: {
      id: actor,
      isAdmin: actorIsAdmin(message, new Set(input.adminUserIds)),
    },
    ...(direct ? { direct: true } : {}),
    ...(chatMove === undefined ? {} : { chatMove }),
    ...(edited ? { edited: true as const } : {}),
    message: {
      id: messageId,
      text,
      textSha256: await sha256Hex(text),
      ...(sideTag.length > 0 ? { senderTag: sideTag } : {}),
      ...(sideButtons.length > 0 ? { buttonText: sideButtons } : {}),
      ...(sideSignature.length > 0 ? { authorSignature: sideSignature } : {}),
      ...(sideMirror.length > 0 ? { mirrorSignature: sideMirror } : {}),
      ...(sidePoll.length > 0 ? { pollOption: sidePoll } : {}),
      ...(sideTasks.length > 0 ? { checklistTask: sideTasks } : {}),
      ...(sideMedia.length > 0 ? { mediaName: sideMedia } : {}),
      ...(sidePerformer.length > 0 ? { performer: sidePerformer } : {}),
      ...(sideGame.length > 0 ? { gameText: sideGame } : {}),
      ...(sideInvoice.length > 0 ? { invoiceText: sideInvoice } : {}),
      ...(sideVenue.length > 0 ? { venueAddress: sideVenue } : {}),
      ...(sideExplanation.length > 0
        ? { pollExplanation: sideExplanation }
        : {}),
      ...(sideQuestion.length > 0 ? { pollQuestion: sideQuestion } : {}),
      ...(sidePrize.length > 0 ? { prizeText: sidePrize } : {}),
      ...(sideChecklist.length > 0 ? { checklistTitle: sideChecklist } : {}),
      ...(sideGameTitle.length > 0 ? { gameTitle: sideGameTitle } : {}),
      ...(sideInvoiceTitle.length > 0
        ? { invoiceTitle: sideInvoiceTitle }
        : {}),
      ...(sideVenueTitle.length > 0 ? { venueTitle: sideVenueTitle } : {}),
      ...(sideWebAppButton.length > 0
        ? { webAppButtonText: sideWebAppButton }
        : {}),
      ...(sideQuote.length > 0 ? { quoteText: sideQuote } : {}),
      ...(sideGift.length > 0 ? { giftText: sideGift } : {}),
      ...(sideGiftLabel.length > 0 ? { giftLabel: sideGiftLabel } : {}),
      ...(sideTopic.length > 0 ? { topicName: sideTopic } : {}),
      ...(sideDecline.length > 0 ? { declineComment: sideDecline } : {}),
      ...(sideAdded.length > 0 ? { addedText: sideAdded } : {}),
      ...(sideHidden.length > 0 ? { hiddenName: sideHidden } : {}),
      ...(sideMember.length > 0 ? { memberName: sideMember } : {}),
      ...(sideShared.length > 0 ? { sharedName: sideShared } : {}),
      ...(sideManaged.length > 0 ? { managedName: sideManaged } : {}),
      ...(sideAccess.length > 0 ? { accessName: sideAccess } : {}),
      ...(sideGameFile.length > 0 ? { gameFile: sideGameFile } : {}),
      ...(sideAudioFile.length > 0 ? { audioFile: sideAudioFile } : {}),
      ...(sidePaidFile.length > 0 ? { paidFile: sidePaidFile } : {}),
      ...(sideRichName.length > 0 ? { richName: sideRichName } : {}),
      ...(sidePollMedia.length > 0 ? { pollMedia: sidePollMedia } : {}),
      ...(sidePollDescription.length > 0
        ? { pollDescription: sidePollDescription }
        : {}),
      ...(sideRichText.length > 0 ? { richText: sideRichText } : {}),
      ...(sideRichButton.length > 0 ? { richButton: sideRichButton } : {}),
      ...(sideLaterName.length > 0 ? { laterName: sideLaterName } : {}),
      ...(ephemeralId !== null && audienceId !== null ? { audienceId } : {}),
      ...(forward ? { forward } : {}),
      ...(links.hosts.length > 0 ? { hosts: links.hosts } : {}),
      ...(links.invites.length > 0 ? { invites: links.invites } : {}),
      ...(isRecord(message.contact) ? { contact: true as const } : {}),
      ...(isRecord(message.via_bot) ? { via: true as const } : {}),
      ...(message.is_paid_post === true ? { paid: true as const } : {}),
      ...(message.is_from_offline === true ? { offline: true as const } : {}),
      ...(albumId ? { albumId } : {}),
      ...(media ? { media: media.kind } : {}),
      ...(media?.sha256 ? { mediaSha256: media.sha256 } : {}),
      ...(notice === undefined ? {} : { notice }),
      ...(asChannel ? { asChannel: true as const } : {}),
      ...(asStory ? { asStory: true as const } : {}),
      ...(asLocation ? { asLocation: true as const } : {}),
      ...(asGiveaway ? { asGiveaway: true as const } : {}),
      ...(call === undefined ? {} : { call }),
      ...(asTitle ? { asTitle: true as const } : {}),
      ...(community === undefined ? {} : { community }),
      ...(asSharedChat ? { asSharedChat: true as const } : {}),
      ...(photo === undefined ? {} : { photo }),
      ...(background === undefined ? {} : { background }),
      ...(gift === undefined ? {} : { gift }),
      ...(asPin ? { asPin: true as const } : {}),
      ...(giveawayNotice === undefined ? {} : { giveawayNotice }),
      ...(asBoost ? { asBoost: true as const } : {}),
      ...(forumNotice === undefined ? {} : { forumNotice }),
      ...(asAutoDelete ? { asAutoDelete: true as const } : {}),
      ...(priceNotice === undefined ? {} : { priceNotice }),
      ...(postNotice === undefined ? {} : { postNotice }),
      ...(checklistNotice === undefined ? {} : { checklistNotice }),
      ...(asCallInvite ? { asCallInvite: true as const } : {}),
      ...(ownerNotice === undefined ? {} : { ownerNotice }),
      ...(asProximity ? { asProximity: true as const } : {}),
      ...(pollNotice === undefined ? {} : { pollNotice }),
      ...(asChecklistAdded ? { asChecklistAdded: true as const } : {}),
      ...(topicNotice === undefined ? {} : { topicNotice }),
      ...(asPostDeclined ? { asPostDeclined: true as const } : {}),
      ...(asGroupCreated ? { asGroupCreated: true as const } : {}),
      ...(asPostPending ? { asPostPending: true as const } : {}),
      ...(asSpoiler ? { asSpoiler: true as const } : {}),
      ...(asEffect ? { asEffect: true as const } : {}),
      ...(richContact.phone ? { asRichPhone: true as const } : {}),
      ...(richContact.card ? { asRichCard: true as const } : {}),
      ...(richContact.email ? { asRichEmail: true as const } : {}),
      ...(asRichMap ? { asRichMap: true as const } : {}),
      ...(richContact.mention ? { asRichMention: true as const } : {}),
      ...(richContact.textMention ? { asRichTextMention: true as const } : {}),
      ...(richContact.command ? { asRichCommand: true as const } : {}),
      ...(richContact.hashtag ? { asRichHashtag: true as const } : {}),
      ...(richContact.cashtag ? { asRichCashtag: true as const } : {}),
      ...(richContact.anchor ? { asRichAnchor: true as const } : {}),
      ...(richContact.anchorLink ? { asRichAnchorLink: true as const } : {}),
      ...(richContact.reference ? { asRichReference: true as const } : {}),
      ...(richContact.referenceLink
        ? { asRichReferenceLink: true as const }
        : {}),
      ...(asTextMention ? { asTextMention: true as const } : {}),
      ...(asCustomEmoji ? { asCustomEmoji: true as const } : {}),
      ...(asCopyText ? { asCopyText: true as const } : {}),
      ...(asSwitchQuery ? { asSwitchQuery: true as const } : {}),
      ...(asLoginForward ? { asLoginForward: true as const } : {}),
      ...(asButtonEmoji ? { asButtonEmoji: true as const } : {}),
      ...(asStickerEmoji ? { asStickerEmoji: true as const } : {}),
    },
  });
}

function changedPoll(
  message: Record<string, unknown>,
): "added" | "deleted" | undefined {
  if (hasPollOptionText(message.poll_option_added)) {
    return "added";
  }
  if (hasPollOptionText(message.poll_option_deleted)) {
    return "deleted";
  }
  return undefined;
}

function hasPollOptionText(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.option_text === "string" &&
    value.option_text.length > 0
  );
}

function createdGroup(message: Record<string, unknown>): boolean {
  return message.group_chat_created === true;
}

function pendingPost(message: Record<string, unknown>): boolean {
  const info = message.suggested_post_info;
  return isRecord(info) && info.state === "pending";
}

function coveredMedia(message: Record<string, unknown>): boolean {
  return (
    message.has_media_spoiler === true || richBlockSpoiler(message.rich_message)
  );
}

function messageEffect(message: Record<string, unknown>): boolean {
  const id = message.effect_id;
  return typeof id === "string" && id.trim().length > 0;
}

function richBlockSpoiler(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => richBlockSpoiler(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (
    (value.type === "photo" ||
      value.type === "video" ||
      value.type === "animation") &&
    value.has_spoiler === true
  ) {
    return true;
  }
  for (const nested of Object.values(value)) {
    if (richBlockSpoiler(nested)) {
      return true;
    }
  }
  return false;
}

function richContactMark(message: Record<string, unknown>): {
  phone: boolean;
  card: boolean;
  email: boolean;
  mention: boolean;
  textMention: boolean;
  command: boolean;
  hashtag: boolean;
  cashtag: boolean;
  anchor: boolean;
  anchorLink: boolean;
  reference: boolean;
  referenceLink: boolean;
} {
  const found = {
    phone: false,
    card: false,
    email: false,
    mention: false,
    textMention: false,
    command: false,
    hashtag: false,
    cashtag: false,
    anchor: false,
    anchorLink: false,
    reference: false,
    referenceLink: false,
  };
  const rich = message.rich_message;
  if (isRecord(rich)) {
    walkRichContact(rich.blocks, found);
  }
  return found;
}

function walkRichContact(
  value: unknown,
  found: {
    phone: boolean;
    card: boolean;
    email: boolean;
    mention: boolean;
    textMention: boolean;
    command: boolean;
    hashtag: boolean;
    cashtag: boolean;
    anchor: boolean;
    anchorLink: boolean;
    reference: boolean;
    referenceLink: boolean;
  },
): void {
  if (
    found.phone &&
    found.card &&
    found.email &&
    found.mention &&
    found.textMention &&
    found.command &&
    found.hashtag &&
    found.cashtag &&
    found.anchor &&
    found.anchorLink &&
    found.reference &&
    found.referenceLink
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkRichContact(item, found);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.type === "phone_number" && hiddenSecret(value.phone_number)) {
    found.phone = true;
  }
  if (
    value.type === "bank_card_number" &&
    hiddenSecret(value.bank_card_number)
  ) {
    found.card = true;
  }
  if (value.type === "email_address" && hiddenSecret(value.email_address)) {
    found.email = true;
  }
  if (value.type === "mention" && hiddenSecret(value.username)) {
    found.mention = true;
  }
  if (value.type === "text_mention" && mentionedUser(value.user)) {
    found.textMention = true;
  }
  if (value.type === "bot_command" && hiddenSecret(value.bot_command)) {
    found.command = true;
  }
  if (value.type === "hashtag" && hiddenSecret(value.hashtag)) {
    found.hashtag = true;
  }
  if (value.type === "cashtag" && hiddenSecret(value.cashtag)) {
    found.cashtag = true;
  }
  if (value.type === "anchor" && hiddenSecret(value.name)) {
    found.anchor = true;
  }
  if (value.type === "anchor_link" && hiddenSecret(value.anchor_name)) {
    found.anchorLink = true;
  }
  if (value.type === "reference" && hiddenSecret(value.name)) {
    found.reference = true;
  }
  if (value.type === "reference_link" && hiddenSecret(value.reference_name)) {
    found.referenceLink = true;
  }
  for (const nested of Object.values(value)) {
    walkRichContact(nested, found);
  }
}

function hiddenSecret(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function textMentionMark(message: Record<string, unknown>): boolean {
  const lists: unknown[] = [message.entities, message.caption_entities];
  const poll = message.poll;
  if (isRecord(poll)) {
    lists.push(
      poll.question_entities,
      poll.explanation_entities,
      poll.description_entities,
    );
  }
  const checklist = message.checklist;
  if (isRecord(checklist)) {
    lists.push(checklist.title_entities);
    pushTaskMentionLists(checklist.tasks, lists);
  }
  const addedTasks = message.checklist_tasks_added;
  if (isRecord(addedTasks)) {
    pushTaskMentionLists(addedTasks.tasks, lists);
  }
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const gift = message[field];
    if (isRecord(gift)) {
      lists.push(gift.entities);
    }
  }
  const game = message.game;
  if (isRecord(game)) {
    lists.push(game.text_entities);
  }
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entity of list) {
      if (
        isRecord(entity) &&
        entity.type === "text_mention" &&
        mentionedUser(entity.user)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 清单任务上的实体列表。投票选项和手动引用不读。 */
function pushTaskMentionLists(tasks: unknown, lists: unknown[]): void {
  if (!Array.isArray(tasks)) {
    return;
  }
  for (const task of tasks) {
    if (isRecord(task)) {
      lists.push(task.text_entities);
    }
  }
}

function customEmojiMark(message: Record<string, unknown>): boolean {
  const lists: unknown[] = [message.entities, message.caption_entities];
  const poll = message.poll;
  if (isRecord(poll)) {
    lists.push(
      poll.question_entities,
      poll.explanation_entities,
      poll.description_entities,
    );
    if (Array.isArray(poll.options)) {
      for (const option of poll.options) {
        if (isRecord(option)) {
          lists.push(option.text_entities);
        }
      }
    }
  }
  for (const field of ["poll_option_added", "poll_option_deleted"]) {
    const value = message[field];
    if (isRecord(value)) {
      lists.push(value.option_text_entities);
    }
  }
  const checklist = message.checklist;
  if (isRecord(checklist)) {
    lists.push(checklist.title_entities);
    if (Array.isArray(checklist.tasks)) {
      for (const task of checklist.tasks) {
        if (isRecord(task)) {
          lists.push(task.text_entities);
        }
      }
    }
  }
  const addedTasks = message.checklist_tasks_added;
  if (isRecord(addedTasks)) {
    pushTaskMentionLists(addedTasks.tasks, lists);
  }
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const gift = message[field];
    if (isRecord(gift)) {
      lists.push(gift.entities);
    }
  }
  const game = message.game;
  if (isRecord(game)) {
    lists.push(game.text_entities);
  }
  const quote = message.quote;
  if (isRecord(quote) && quote.is_manual === true) {
    lists.push(quote.entities);
  }
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entity of list) {
      if (
        isRecord(entity) &&
        entity.type === "custom_emoji" &&
        hiddenSecret(entity.custom_emoji_id)
      ) {
        return true;
      }
    }
  }
  const rich = message.rich_message;
  return isRecord(rich) && richCustomEmoji(rich);
}

function richCustomEmoji(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => richCustomEmoji(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "custom_emoji" && hiddenSecret(value.custom_emoji_id)) {
    return true;
  }
  for (const nested of Object.values(value)) {
    if (richCustomEmoji(nested)) {
      return true;
    }
  }
  return false;
}

function copyTextMark(message: Record<string, unknown>): boolean {
  if (inlineCopyText(message.reply_markup)) {
    return true;
  }
  const rich = message.rich_message;
  return isRecord(rich) && richCopyText(rich);
}

function inlineCopyText(markup: unknown): boolean {
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return false;
  }
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (buttonCopiesText(button)) {
        return true;
      }
    }
  }
  return false;
}

function buttonCopiesText(button: unknown): boolean {
  if (!isRecord(button)) {
    return false;
  }
  const copied = button.copy_text;
  return isRecord(copied) && hiddenSecret(copied.text);
}

function richCopyText(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => richCopyText(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "button" && buttonCopiesText(value.button)) {
    return true;
  }
  if (value.type === "buttons" && Array.isArray(value.buttons)) {
    for (const button of value.buttons) {
      if (buttonCopiesText(button)) {
        return true;
      }
    }
  }
  for (const nested of Object.values(value)) {
    if (richCopyText(nested)) {
      return true;
    }
  }
  return false;
}

function switchQueryMark(message: Record<string, unknown>): boolean {
  if (inlineSwitchQuery(message.reply_markup)) {
    return true;
  }
  const rich = message.rich_message;
  return isRecord(rich) && richSwitchQuery(rich);
}

function inlineSwitchQuery(markup: unknown): boolean {
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return false;
  }
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (buttonSwitchesQuery(button)) {
        return true;
      }
    }
  }
  return false;
}

function buttonSwitchesQuery(button: unknown): boolean {
  if (!isRecord(button)) {
    return false;
  }
  if (hiddenSecret(button.switch_inline_query)) {
    return true;
  }
  if (hiddenSecret(button.switch_inline_query_current_chat)) {
    return true;
  }
  const chosen = button.switch_inline_query_chosen_chat;
  return isRecord(chosen) && hiddenSecret(chosen.query);
}

function richSwitchQuery(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => richSwitchQuery(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "button" && buttonSwitchesQuery(value.button)) {
    return true;
  }
  if (value.type === "buttons" && Array.isArray(value.buttons)) {
    for (const button of value.buttons) {
      if (buttonSwitchesQuery(button)) {
        return true;
      }
    }
  }
  for (const nested of Object.values(value)) {
    if (richSwitchQuery(nested)) {
      return true;
    }
  }
  return false;
}

function loginForwardMark(message: Record<string, unknown>): boolean {
  if (inlineLoginForward(message.reply_markup)) {
    return true;
  }
  const rich = message.rich_message;
  return isRecord(rich) && richLoginForward(rich);
}

function inlineLoginForward(markup: unknown): boolean {
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return false;
  }
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (buttonForwardsLogin(button)) {
        return true;
      }
    }
  }
  return false;
}

function buttonForwardsLogin(button: unknown): boolean {
  if (!isRecord(button)) {
    return false;
  }
  const login = button.login_url;
  return isRecord(login) && hiddenSecret(login.forward_text);
}

function richLoginForward(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => richLoginForward(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "button" && buttonForwardsLogin(value.button)) {
    return true;
  }
  if (value.type === "buttons" && Array.isArray(value.buttons)) {
    for (const button of value.buttons) {
      if (buttonForwardsLogin(button)) {
        return true;
      }
    }
  }
  for (const nested of Object.values(value)) {
    if (richLoginForward(nested)) {
      return true;
    }
  }
  return false;
}

function buttonEmojiMark(message: Record<string, unknown>): boolean {
  return inlineButtonEmoji(message.reply_markup);
}

function inlineButtonEmoji(markup: unknown): boolean {
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return false;
  }
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (buttonShowsEmoji(button)) {
        return true;
      }
    }
  }
  return false;
}

function buttonShowsEmoji(button: unknown): boolean {
  return isRecord(button) && hiddenSecret(button.icon_custom_emoji_id);
}

function stickerEmojiMark(message: Record<string, unknown>): boolean {
  return (
    isRecord(message.sticker) && hiddenSecret(message.sticker.custom_emoji_id)
  );
}

function mentionedUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0
  );
}

function declinedPost(message: Record<string, unknown>): boolean {
  return isRecord(message.suggested_post_declined);
}

function changedTopic(
  message: Record<string, unknown>,
): "created" | "edited" | undefined {
  if (hasTopicName(message.forum_topic_created)) {
    return "created";
  }
  if (hasTopicEdit(message.forum_topic_edited)) {
    return "edited";
  }
  return undefined;
}

function hasTopicName(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.name === "string" && value.name.length > 0
  );
}

function hasTopicEdit(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.name === "string" && value.name.length > 0) {
    return true;
  }
  return typeof value.icon_custom_emoji_id === "string";
}

function addedChecklist(message: Record<string, unknown>): boolean {
  const added = message.checklist_tasks_added;
  if (!isRecord(added) || !Array.isArray(added.tasks)) {
    return false;
  }
  return added.tasks.some(
    (task) =>
      isRecord(task) && typeof task.text === "string" && task.text.length > 0,
  );
}

function nearUsers(message: Record<string, unknown>): boolean {
  const alert = message.proximity_alert_triggered;
  if (!isRecord(alert) || typeof alert.distance !== "number") {
    return false;
  }
  return Number.isSafeInteger(alert.distance) && alert.distance >= 0;
}

function changedOwner(
  message: Record<string, unknown>,
): "changed" | "left" | undefined {
  const changed = message.chat_owner_changed;
  if (isRecord(changed) && isRecord(changed.new_owner)) {
    return "changed";
  }
  if (isRecord(message.chat_owner_left)) {
    return "left";
  }
  return undefined;
}

function videoInvite(message: Record<string, unknown>): boolean {
  const invited = message.video_chat_participants_invited;
  if (!isRecord(invited) || !Array.isArray(invited.users)) {
    return false;
  }
  return invited.users.some((item) => isRecord(item));
}

function movedChat(
  message: Record<string, unknown>,
  chatId: string,
): { readonly from: string; readonly to: string } | undefined {
  const to = migrateChatId(message.migrate_to_chat_id);
  if (to !== null && to !== chatId) {
    return { from: chatId, to };
  }
  const from = migrateChatId(message.migrate_from_chat_id);
  if (from !== null && from !== chatId) {
    return { from, to: chatId };
  }
  return undefined;
}

function migrateChatId(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value === 0
  ) {
    return null;
  }
  const text = String(value);
  return text.length <= 128 ? text : null;
}

function taskNotice(
  message: Record<string, unknown>,
): "done" | "undone" | undefined {
  const done = message.checklist_tasks_done;
  if (!isRecord(done)) {
    return undefined;
  }
  if (taskIds(done.marked_as_done_task_ids)) {
    return "done";
  }
  if (taskIds(done.marked_as_not_done_task_ids)) {
    return "undone";
  }
  return undefined;
}

function taskIds(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) =>
        typeof item === "number" && Number.isSafeInteger(item) && item > 0,
    )
  );
}

function suggestedPost(
  message: Record<string, unknown>,
): "approved" | "failed" | "paid" | "refunded" | undefined {
  const approved = message.suggested_post_approved;
  if (isRecord(approved)) {
    const sendDate = approved.send_date;
    if (
      typeof sendDate === "number" &&
      Number.isSafeInteger(sendDate) &&
      sendDate >= 0
    ) {
      return "approved";
    }
  }
  const failed = message.suggested_post_approval_failed;
  if (isRecord(failed) && isRecord(failed.price)) {
    return "failed";
  }
  const paid = message.suggested_post_paid;
  if (isRecord(paid) && (paid.currency === "XTR" || paid.currency === "TON")) {
    return "paid";
  }
  const refunded = message.suggested_post_refunded;
  if (
    isRecord(refunded) &&
    (refunded.reason === "post_deleted" ||
      refunded.reason === "payment_refunded")
  ) {
    return "refunded";
  }
  return undefined;
}

function changedPrice(
  message: Record<string, unknown>,
): "paid" | "direct" | undefined {
  const paid = message.paid_message_price_changed;
  if (isRecord(paid)) {
    const stars = paid.paid_message_star_count;
    if (
      typeof stars === "number" &&
      Number.isSafeInteger(stars) &&
      stars >= 0
    ) {
      return "paid";
    }
  }
  const direct = message.direct_message_price_changed;
  if (
    isRecord(direct) &&
    (direct.are_direct_messages_enabled === true ||
      direct.are_direct_messages_enabled === false)
  ) {
    return "direct";
  }
  return undefined;
}

function autoDeleteNotice(message: Record<string, unknown>): boolean {
  const changed = message.message_auto_delete_timer_changed;
  if (!isRecord(changed)) {
    return false;
  }
  const seconds = changed.message_auto_delete_time;
  return (
    typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds >= 0
  );
}

function forumService(
  message: Record<string, unknown>,
): "closed" | "reopened" | "hidden" | "shown" | undefined {
  if (isRecord(message.forum_topic_closed)) {
    return "closed";
  }
  if (isRecord(message.forum_topic_reopened)) {
    return "reopened";
  }
  if (isRecord(message.general_forum_topic_hidden)) {
    return "hidden";
  }
  if (isRecord(message.general_forum_topic_unhidden)) {
    return "shown";
  }
  return undefined;
}

function addedBoost(message: Record<string, unknown>): boolean {
  const added = message.boost_added;
  if (!isRecord(added)) {
    return false;
  }
  const count = added.boost_count;
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0;
}

function scheduledGiveaway(
  message: Record<string, unknown>,
): "created" | "completed" | undefined {
  if (isRecord(message.giveaway_created)) {
    return "created";
  }
  const completed = message.giveaway_completed;
  if (!isRecord(completed)) {
    return undefined;
  }
  const winners = completed.winner_count;
  if (
    typeof winners === "number" &&
    Number.isSafeInteger(winners) &&
    winners >= 0
  ) {
    return "completed";
  }
  return undefined;
}

function pinnedNotice(message: Record<string, unknown>): boolean {
  const pinned = message.pinned_message;
  if (!isRecord(pinned)) {
    return false;
  }
  const id = pinned.message_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

function giftNotice(
  message: Record<string, unknown>,
): "card" | "unique" | "upgrade" | undefined {
  if (giftRecord(message.gift)) {
    return "card";
  }
  if (giftRecord(message.unique_gift)) {
    return "unique";
  }
  if (giftRecord(message.gift_upgrade_sent)) {
    return "upgrade";
  }
  return undefined;
}

function giftRecord(value: unknown): boolean {
  return isRecord(value) && isRecord(value.gift);
}

function backgroundNotice(
  message: Record<string, unknown>,
): "wallpaper" | "pattern" | "fill" | "theme" | undefined {
  const background = message.chat_background_set;
  if (!isRecord(background) || !isRecord(background.type)) {
    return undefined;
  }
  switch (background.type.type) {
    case "wallpaper":
      return "wallpaper";
    case "pattern":
      return "pattern";
    case "fill":
      return "fill";
    case "chat_theme":
      return "theme";
    default:
      return undefined;
  }
}

function photoNotice(
  message: Record<string, unknown>,
): "set" | "cleared" | undefined {
  if (photoSizes(message.new_chat_photo)) {
    return "set";
  }
  if (message.delete_chat_photo === true) {
    return "cleared";
  }
  return undefined;
}

function photoSizes(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item));
}

function sharedChatCard(message: Record<string, unknown>): boolean {
  const shared = message.chat_shared;
  return isRecord(shared) && Number.isSafeInteger(shared.chat_id);
}

function communityNotice(
  message: Record<string, unknown>,
): "added" | "joined" | "removed" | undefined {
  if (communityRecord(message.community_chat_added)) {
    return "added";
  }
  if (communityRecord(message.community_chat_joined)) {
    return "joined";
  }
  if (isRecord(message.community_chat_removed)) {
    return "removed";
  }
  return undefined;
}

function communityRecord(value: unknown): boolean {
  return isRecord(value) && isRecord(value.community);
}

function renamedChat(message: Record<string, unknown>): boolean {
  return (
    typeof message.new_chat_title === "string" &&
    message.new_chat_title.length > 0
  );
}

function callNotice(
  message: Record<string, unknown>,
): "started" | "ended" | "scheduled" | undefined {
  if (isRecord(message.video_chat_started)) {
    return "started";
  }
  if (timedCall(message.video_chat_ended, "duration")) {
    return "ended";
  }
  if (timedCall(message.video_chat_scheduled, "start_date")) {
    return "scheduled";
  }
  return undefined;
}

function timedCall(value: unknown, field: "duration" | "start_date"): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const mark = value[field];
  return typeof mark === "number" && Number.isFinite(mark) && mark >= 0;
}

function sharedGiveaway(message: Record<string, unknown>): boolean {
  const giveaway = message.giveaway;
  if (isRecord(giveaway) && hasChatRecord(giveaway.chats)) {
    return true;
  }
  const winners = message.giveaway_winners;
  return isRecord(winners) && isRecord(winners.chat);
}

function hasChatRecord(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item));
}

function richMap(message: Record<string, unknown>): boolean {
  return findRichMap(message.rich_message);
}

function findRichMap(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => findRichMap(item));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "map" && mapPoint(value.location)) {
    return true;
  }
  for (const nested of Object.values(value)) {
    if (findRichMap(nested)) {
      return true;
    }
  }
  return false;
}

function mapPoint(value: unknown): boolean {
  return (
    isRecord(value) &&
    finiteCoordinate(value.latitude) &&
    finiteCoordinate(value.longitude)
  );
}

function bareLocation(message: Record<string, unknown>): boolean {
  if (isRecord(message.venue)) {
    return false;
  }
  const location = message.location;
  return (
    isRecord(location) &&
    finiteCoordinate(location.latitude) &&
    finiteCoordinate(location.longitude)
  );
}

function finiteCoordinate(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function sharedStory(message: Record<string, unknown>): boolean {
  const story = message.story;
  return isRecord(story) && isRecord(story.chat);
}

function sentAsForeignChannel(message: Record<string, unknown>): boolean {
  if (message.is_automatic_forward === true) {
    return false;
  }
  const sender = message.sender_chat;
  if (!isRecord(sender) || sender.type !== "channel") {
    return false;
  }
  const chat = nestedId(message.chat);
  const senderId = nestedId(sender);
  return chat !== null && senderId !== null && chat !== senderId;
}

function serviceNotice(
  message: Record<string, unknown>,
): "join" | "leave" | undefined {
  if (hasJoinMembers(message.new_chat_members)) {
    return "join";
  }
  if (isRecord(message.left_chat_member)) {
    return "leave";
  }
  return undefined;
}

function hasJoinMembers(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item));
}

function albumToken(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,20}$/.test(value)) {
    return undefined;
  }
  return value;
}

function foreignChat(message: Record<string, unknown>): boolean {
  return (
    nonEmptyString(message.business_connection_id) ||
    nonEmptyString(message.guest_query_id)
  );
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function forwardKind(
  message: Record<string, unknown>,
): ForwardKind | undefined {
  const kind = forwardOriginKind(message);
  if (kind === "channel" && message.is_automatic_forward === true) {
    return undefined;
  }
  return kind;
}

function forwardOriginKind(
  message: Record<string, unknown>,
): ForwardKind | undefined {
  const origin = message.forward_origin;
  if (isRecord(origin)) {
    switch (origin.type) {
      case "channel":
        return "channel";
      case "chat":
        return "chat";
      case "hidden_user":
        return "hidden";
      case "user":
        return "user";
      default:
        break;
    }
  }
  if (
    typeof message.forward_sender_name === "string" &&
    message.forward_sender_name.length > 0
  ) {
    return "hidden";
  }
  if (isRecord(message.forward_from_chat)) {
    return message.forward_from_chat.type === "channel" ? "channel" : "chat";
  }
  if (isRecord(message.forward_from)) {
    return "user";
  }
  return undefined;
}

/**
 * The actor is the member whose status changed (`new_chat_member.user`),
 * not `from`. `from` is whoever performed the action, often an admin.
 */
async function chatMemberEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): Promise<NormalizeOutcome> {
  if (!isRecord(value) || !isRecord(value.new_chat_member)) {
    return { status: "ignored" };
  }
  const chatId = nestedId(value.chat);
  const actor = nestedId(value.new_chat_member.user);
  if (!chatId || !actor) {
    return { status: "ignored" };
  }
  const status = value.new_chat_member.status;
  const admins = new Set(input.adminUserIds);
  const direct = isPrivateChat(value.chat);
  const botJoin = joiningBot(value);
  const membership = memberChange(value);
  const profile =
    membership === "join" && isRecord(value.new_chat_member.user)
      ? await joinProfile(value.new_chat_member.user, value.new_chat_member.tag)
      : await changedMemberTag(value);
  const configured = admins.has(actor);
  const folderInvite =
    value.via_chat_folder_invite_link === true &&
    (membership === "join" || botJoin);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "chat_member" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: {
      id: actor,
      isAdmin: botJoin
        ? configured
        : status === "administrator" || status === "creator" || configured,
      ...(botJoin ? { bot: true as const } : {}),
    },
    ...(direct ? { direct: true } : {}),
    ...(membership ? { membership } : {}),
    ...(profile ? { profile } : {}),
    ...(folderInvite ? { folderInvite: true as const } : {}),
  });
}

async function joinRequestEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): Promise<NormalizeOutcome> {
  if (!isRecord(value)) {
    return { status: "ignored" };
  }
  const chatId = nestedId(value.chat);
  const actor = nestedId(value.from);
  if (!chatId || !actor) {
    return { status: "ignored" };
  }
  const profile = await requestBio(value.bio);
  const joinQueryId = safeJoinQueryId(value.query_id);
  const direct = isPrivateChat(value.chat);
  const links = requestNameLinks(value.from);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "join_request" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: { id: actor, isAdmin: new Set(input.adminUserIds).has(actor) },
    ...(direct ? { direct: true } : {}),
    ...(profile ? { profile } : {}),
    ...(joinQueryId ? { joinQueryId } : {}),
    ...(links.hosts.length > 0 ? { nameHosts: links.hosts } : {}),
    ...(links.invites.length > 0 ? { nameInvites: links.invites } : {}),
  });
}

/**
 * 入群申请上画出的名字只留主机名。
 * 名的长度大于 0 时不读姓。空白也算有名。用户名不读。
 * 群名、邀请链接和用户编号不读。名字不进简介。
 */
function requestNameLinks(user: unknown): {
  hosts: string[];
  invites: string[];
} {
  const urls: string[] = [];
  pushVisiblePartyUrls(user, undefined, urls);
  return collectLinkHosts(urls);
}

function safeJoinQueryId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    return undefined;
  }
  return value;
}

async function requestBio(
  value: unknown,
): Promise<{ readonly text: string; readonly textSha256: string } | undefined> {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const text = trimmed.slice(0, 256);
  return { text, textSha256: await sha256Hex(text) };
}

async function joinProfile(
  user: Record<string, unknown>,
  tag: unknown,
): Promise<{ readonly text: string; readonly textSha256: string } | undefined> {
  const parts: string[] = [];
  for (const key of ["first_name", "last_name", "username"]) {
    const value = user[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      parts.push(trimmed);
    }
  }
  const trimmed = trimmedTag(tag);
  if (trimmed !== undefined) {
    parts.push(trimmed);
  }
  if (parts.length === 0) {
    return undefined;
  }
  const text = parts.join(" ").slice(0, 256);
  return { text, textSha256: await sha256Hex(text) };
}

async function changedMemberTag(
  value: Record<string, unknown>,
): Promise<{ readonly text: string; readonly textSha256: string } | undefined> {
  if (!isRecord(value.new_chat_member) || !stillInside(value.new_chat_member)) {
    return undefined;
  }
  const user = value.new_chat_member.user;
  if (isRecord(user) && user.is_bot === true) {
    return undefined;
  }
  const next = trimmedTag(value.new_chat_member.tag);
  if (next === undefined) {
    return undefined;
  }
  const previous = isRecord(value.old_chat_member)
    ? trimmedTag(value.old_chat_member.tag)
    : undefined;
  if (previous === next) {
    return undefined;
  }
  const text = next.slice(0, 256);
  return { text, textSha256: await sha256Hex(text) };
}

function trimmedTag(tag: unknown): string | undefined {
  if (typeof tag !== "string") {
    return undefined;
  }
  const trimmed = tag.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function botMembershipEvent(
  value: unknown,
  updateId: number,
  input: NormalizeInput,
): NormalizeOutcome {
  if (!isRecord(value) || !isGroupChat(value.chat)) {
    return { status: "ignored" };
  }
  if (!isRecord(value.new_chat_member)) {
    return { status: "ignored" };
  }
  const state = botState(value.new_chat_member.status);
  const chatId = nestedId(value.chat);
  const actor = nestedId(value.from);
  if (!state || !chatId || !actor) {
    return { status: "ignored" };
  }
  const admins = new Set(input.adminUserIds);
  const seat = botSeat(value.new_chat_member);
  const rights = botRights(value.new_chat_member);
  return finish({
    id: `tg_${updateId}`,
    tenantId: input.tenantId,
    chatId,
    kind: "bot_membership" as const,
    occurredAt: occurredAt(value.date, input.nowIso),
    actor: { id: actor, isAdmin: admins.has(actor) },
    bot: state,
    ...(seat === undefined ? {} : { botSeat: seat }),
    ...(rights === undefined
      ? {}
      : { botDelete: rights.delete, botRestrict: rights.restrict }),
  });
}

function botSeat(member: Record<string, unknown>): "in" | undefined {
  if (member.status === "member") {
    return "in";
  }
  if (member.status !== "restricted") {
    return undefined;
  }
  if (member.is_member === true || member.is_member === undefined) {
    return "in";
  }
  return undefined;
}

function botRights(
  member: Record<string, unknown>,
):
  | { readonly delete: "on" | "off"; readonly restrict: "on" | "off" }
  | undefined {
  if (member.status === "creator") {
    return { delete: "on", restrict: "on" };
  }
  if (member.status !== "administrator") {
    return undefined;
  }
  const canDelete = member.can_delete_messages;
  const canRestrict = member.can_restrict_members;
  if (typeof canDelete !== "boolean" || typeof canRestrict !== "boolean") {
    return undefined;
  }
  return {
    delete: canDelete ? "on" : "off",
    restrict: canRestrict ? "on" : "off",
  };
}

function botState(status: unknown): "admin" | "gone" | null {
  if (status === "administrator" || status === "creator") {
    return "admin";
  }
  if (
    status === "left" ||
    status === "kicked" ||
    status === "member" ||
    status === "restricted"
  ) {
    return "gone";
  }
  return null;
}

function isGroupChat(chat: unknown): boolean {
  return (
    isRecord(chat) && (chat.type === "group" || chat.type === "supergroup")
  );
}

function joiningBot(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (!isRecord(user) || user.is_bot !== true) {
    return false;
  }
  const status = value.new_chat_member.status;
  if (
    status !== "member" &&
    status !== "restricted" &&
    status !== "administrator"
  ) {
    return false;
  }
  if (restrictedOutside(value.new_chat_member)) {
    return false;
  }
  if (!isRecord(value.old_chat_member)) {
    return true;
  }
  const previous = value.old_chat_member.status;
  return (
    previous === "left" ||
    previous === "kicked" ||
    previous === undefined ||
    restrictedOutside(value.old_chat_member)
  );
}

function memberChange(
  value: Record<string, unknown>,
): "join" | "leave" | "promote" | "unrestrict" | undefined {
  if (joiningMember(value)) {
    return "join";
  }
  if (leavingMember(value)) {
    return "leave";
  }
  if (promotingMember(value)) {
    return "promote";
  }
  if (unrestrictingMember(value)) {
    return "unrestrict";
  }
  return undefined;
}

function unrestrictingMember(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (isRecord(user) && user.is_bot === true) {
    return false;
  }
  if (value.new_chat_member.status !== "member") {
    return false;
  }
  if (!isRecord(value.old_chat_member)) {
    return false;
  }
  return (
    value.old_chat_member.status === "restricted" &&
    !restrictedOutside(value.old_chat_member)
  );
}

function promotingMember(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (isRecord(user) && user.is_bot === true) {
    return false;
  }
  const status = value.new_chat_member.status;
  if (status !== "administrator" && status !== "creator") {
    return false;
  }
  if (!isRecord(value.old_chat_member)) {
    return false;
  }
  const previous = value.old_chat_member.status;
  if (previous !== "member" && previous !== "restricted") {
    return false;
  }
  return !restrictedOutside(value.old_chat_member);
}

function leavingMember(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (isRecord(user) && user.is_bot === true) {
    return false;
  }
  if (!stillInside(value.old_chat_member)) {
    return false;
  }
  const status = value.new_chat_member.status;
  return (
    status === "left" ||
    status === "kicked" ||
    restrictedOutside(value.new_chat_member)
  );
}

function joiningMember(value: Record<string, unknown>): boolean {
  if (!isRecord(value.new_chat_member)) {
    return false;
  }
  const user = value.new_chat_member.user;
  if (isRecord(user) && user.is_bot === true) {
    return false;
  }
  const status = value.new_chat_member.status;
  if (status !== "member" && status !== "restricted") {
    return false;
  }
  if (restrictedOutside(value.new_chat_member)) {
    return false;
  }
  if (!isRecord(value.old_chat_member)) {
    return true;
  }
  const previous = value.old_chat_member.status;
  return (
    previous === "left" ||
    previous === "kicked" ||
    previous === undefined ||
    restrictedOutside(value.old_chat_member)
  );
}

function stillInside(member: unknown): boolean {
  if (!isRecord(member)) {
    return false;
  }
  const status = member.status;
  if (
    status === "member" ||
    status === "administrator" ||
    status === "creator"
  ) {
    return true;
  }
  return status === "restricted" && member.is_member !== false;
}

function restrictedOutside(member: unknown): boolean {
  return (
    isRecord(member) &&
    member.status === "restricted" &&
    member.is_member === false
  );
}

function isPrivateChat(chat: unknown): boolean {
  return isRecord(chat) && chat.type === "private";
}

function finish(draft: unknown): NormalizeOutcome {
  try {
    return { status: "event", event: parseEvent(draft) };
  } catch {
    return { status: "ignored" };
  }
}

const MAX_LINK = 2048;
const MAX_HOSTS = 8;

function linkHosts(message: Record<string, unknown>): {
  hosts: string[];
  invites: string[];
} {
  const urls: unknown[] = [];
  const poll = message.poll;
  const checklist = message.checklist;
  const lists = [message.entities, message.caption_entities];
  if (isRecord(poll)) {
    lists.push(poll.question_entities);
  }
  if (isRecord(checklist)) {
    lists.push(checklist.title_entities);
  }
  const quote = message.quote;
  if (
    messageText(message, false).length === 0 &&
    isRecord(quote) &&
    quote.is_manual === true &&
    typeof quote.text === "string" &&
    quote.text.length > 0
  ) {
    lists.push(quote.entities);
  }
  for (const list of lists) {
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entity of list) {
      if (!isRecord(entity)) {
        continue;
      }
      if (entity.type === "text_link") {
        urls.push(entity.url);
      }
      for (const found of preLanguageUrls(entity)) {
        urls.push(found);
      }
    }
  }
  for (const url of buttonUrls(message)) {
    urls.push(url);
  }
  for (const url of richUrls(message)) {
    urls.push(url);
  }
  for (const url of sideUrls(message)) {
    urls.push(url);
  }
  return collectLinkHosts(urls);
}

function collectLinkHosts(urls: readonly unknown[]): {
  hosts: string[];
  invites: string[];
} {
  const hosts: string[] = [];
  const invites: string[] = [];
  const seenHosts = new Set<string>();
  const seenInvites = new Set<string>();
  for (const url of urls) {
    const link = hostFromUrl(url);
    if (!link) {
      continue;
    }
    if (!seenHosts.has(link.host) && hosts.length < MAX_HOSTS) {
      seenHosts.add(link.host);
      hosts.push(link.host);
    }
    for (const extra of link.extras ?? []) {
      if (!seenHosts.has(extra.host) && hosts.length < MAX_HOSTS) {
        seenHosts.add(extra.host);
        hosts.push(extra.host);
      }
      if (
        extra.invite &&
        !seenInvites.has(extra.host) &&
        invites.length < MAX_HOSTS
      ) {
        seenInvites.add(extra.host);
        invites.push(extra.host);
      }
    }
    if (
      link.invite &&
      !seenInvites.has(link.host) &&
      invites.length < MAX_HOSTS
    ) {
      seenInvites.add(link.host);
      invites.push(link.host);
    }
  }
  return { hosts, invites };
}

const COPY_URL =
  /(?:https?:\/\/|tg:(?:\/\/)?|www\.)[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/gi;

const DRAFT_IP_HEAD = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9])";
const DRAFT_IP_MID = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[1-9]|0)";
const DRAFT_IP_LAST = "(?:25[0-5]|2[0-4][0-9]|[0-1][0-9]{2}|[1-9][0-9]|[0-9])";
const DRAFT_IP = `${DRAFT_IP_HEAD}\\.${DRAFT_IP_MID}\\.${DRAFT_IP_MID}\\.${DRAFT_IP_LAST}`;
const DRAFT_IP_TAIL = '(?::\\d{1,5}(?!\\d))?(?:[/?][^\\s<>"]*)?';
const DRAFT_ASCII_LABEL = "[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?";
const DRAFT_ATOM =
  "(?:[A-Za-z0-9]|[^\\t\\n\\v\\f\\r \\u00A0\\u2000-\\u200A\\u2028\\u2029\\u202F\\u3000\\u0000-\\u007F\\u0080-\\u009F\\uD800-\\uDFFF\\uE000-\\uF8FF\\uFDD0-\\uFDEF\\uFFF0-\\uFFFF])";
const DRAFT_BRIDGED = `(?=[^.]{0,62}[_-])${DRAFT_ATOM}(?:${DRAFT_ATOM}|[_-]){0,61}${DRAFT_ATOM}`;
const DRAFT_NAME = `(?:${DRAFT_BRIDGED}|${DRAFT_ASCII_LABEL})`;
const DRAFT_BARE = `(?<!:\\/\\/)(?:^|\\b)(?:${DRAFT_NAME}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])(?::\\d{1,5}(?!\\d))?(?:[/?][^\\s<>"]*)?`;
const STRICT_TLD_LABEL = new RegExp(`^(?:${androidStrictTld})$`, "i");
const DRAFT_MARK =
  "[\\u0300-\\u0344\\u0346-\\u036F\\u0483-\\u0487\\u0591-\\u05BD\\u05BF\\u05C1-\\u05C2" +
  "\\u05C4-\\u05C5\\u05C7\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-" +
  "\\u06DC\\u06DF-\\u06E4\\u06E7-\\u06E8\\u06EA-\\u06ED\\u0711\\u0730-" +
  "\\u074A\\u07A6-\\u07B0\\u07EB-\\u07F3\\u07FD\\u0816-\\u0819\\u081B-" +
  "\\u0823\\u0825-\\u0827\\u0829-\\u082D\\u0859-\\u085B\\u0898-\\u089F" +
  "\\u08CA-\\u08E1\\u08E3-\\u0902\\u093A\\u093C\\u0941-\\u0948\\u094D" +
  "\\u0951-\\u0957\\u0962-\\u0963\\u0981\\u09BC\\u09C1-\\u09C4\\u09CD" +
  "\\u09E2-\\u09E3\\u09FE\\u0A01-\\u0A02\\u0A3C\\u0A41-\\u0A42\\u0A47-" +
  "\\u0A48\\u0A4B-\\u0A4D\\u0A51\\u0A70-\\u0A71\\u0A75\\u0A81-\\u0A82" +
  "\\u0ABC\\u0AC1-\\u0AC5\\u0AC7-\\u0AC8\\u0ACD\\u0AE2-\\u0AE3\\u0AFA-" +
  "\\u0AFF\\u0B01\\u0B3C\\u0B3F\\u0B41-\\u0B44\\u0B4D\\u0B55-\\u0B56" +
  "\\u0B62-\\u0B63\\u0B82\\u0BC0\\u0BCD\\u0C00\\u0C04\\u0C3C\\u0C3E-" +
  "\\u0C40\\u0C46-\\u0C48\\u0C4A-\\u0C4D\\u0C55-\\u0C56\\u0C62-\\u0C63" +
  "\\u0C81\\u0CBC\\u0CBF\\u0CC6\\u0CCC-\\u0CCD\\u0CE2-\\u0CE3\\u0D00-" +
  "\\u0D01\\u0D3B-\\u0D3C\\u0D41-\\u0D44\\u0D4D\\u0D62-\\u0D63\\u0D81" +
  "\\u0DCA\\u0DD2-\\u0DD4\\u0DD6\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E" +
  "\\u0EB1\\u0EB4-\\u0EBC\\u0EC8-\\u0ECE\\u0F18-\\u0F19\\u0F35\\u0F37" +
  "\\u0F39\\u0F71-\\u0F7E\\u0F80-\\u0F84\\u0F86-\\u0F87\\u0F8D-\\u0F97" +
  "\\u0F99-\\u0FBC\\u0FC6\\u102D-\\u1030\\u1032-\\u1037\\u1039-\\u103A" +
  "\\u103D-\\u103E\\u1058-\\u1059\\u105E-\\u1060\\u1071-\\u1074\\u1082" +
  "\\u1085-\\u1086\\u108D\\u109D\\u135D-\\u135F\\u1712-\\u1714\\u1732-" +
  "\\u1733\\u1752-\\u1753\\u1772-\\u1773\\u17B4-\\u17B5\\u17B7-\\u17BD" +
  "\\u17C6\\u17C9-\\u17D3\\u17DD\\u180B-\\u180D\\u180F\\u1885-\\u1886" +
  "\\u18A9\\u1920-\\u1922\\u1927-\\u1928\\u1932\\u1939-\\u193B\\u1A17-" +
  "\\u1A18\\u1A1B\\u1A56\\u1A58-\\u1A5E\\u1A60\\u1A62\\u1A65-\\u1A6C" +
  "\\u1A73-\\u1A7C\\u1A7F\\u1AB0-\\u1ABD\\u1ABF-\\u1ACE\\u1B00-\\u1B03" +
  "\\u1B34\\u1B36-\\u1B3A\\u1B3C\\u1B42\\u1B6B-\\u1B73\\u1B80-\\u1B81" +
  "\\u1BA2-\\u1BA5\\u1BA8-\\u1BA9\\u1BAB-\\u1BAD\\u1BE6\\u1BE8-\\u1BE9" +
  "\\u1BED\\u1BEF-\\u1BF1\\u1C2C-\\u1C33\\u1C36-\\u1C37\\u1CD0-\\u1CD2" +
  "\\u1CD4-\\u1CE0\\u1CE2-\\u1CE8\\u1CED\\u1CF4\\u1CF8-\\u1CF9\\u1DC0-" +
  "\\u1DFF\\u20D0-\\u20DC\\u20E1\\u20E5-\\u20F0\\u2CEF-\\u2CF1\\u2D7F" +
  "\\u2DE0-\\u2DFF\\u302A-\\u302D\\u3099-\\u309A\\uA66F\\uA674-\\uA67D" +
  "\\uA69E-\\uA69F\\uA6F0-\\uA6F1\\uA802\\uA806\\uA80B\\uA825-\\uA826" +
  "\\uA82C\\uA8C4-\\uA8C5\\uA8E0-\\uA8F1\\uA8FF\\uA926-\\uA92D\\uA947-" +
  "\\uA951\\uA980-\\uA982\\uA9B3\\uA9B6-\\uA9B9\\uA9BC-\\uA9BD\\uA9E5" +
  "\\uAA29-\\uAA2E\\uAA31-\\uAA32\\uAA35-\\uAA36\\uAA43\\uAA4C\\uAA7C" +
  "\\uAAB0\\uAAB2-\\uAAB4\\uAAB7-\\uAAB8\\uAABE-\\uAABF\\uAAC1\\uAAEC-" +
  "\\uAAED\\uAAF6\\uABE5\\uABE8\\uABED\\uFB1E\\uFE00-\\uFE0F\\uFE20-" +
  "\\uFE2F]";
const DRAFT_MARK_CHAR = new RegExp(`^(?:${DRAFT_MARK})`);
const DRAFT_URL = `(?<![A-Za-z0-9_](?:${DRAFT_MARK})*)(?:https?:\\/\\/|tg:(?:\\/\\/)?)[^\\s<>"']+|www\\.[^\\s<>"']+|${DRAFT_BARE}`;

function urlsInText(text: string): string[] {
  return scanUrls(text, COPY_URL.source);
}

function scanUrls(
  text: string,
  source: string,
  keepPathApostrophe = false,
): string[] {
  const found: string[] = [];
  const folded = foldHostScan(text);
  const re = new RegExp(source, "gi");
  let match: RegExpExecArray | null = re.exec(folded);
  while (match !== null) {
    let raw = match[0] ?? "";
    if (keepPathApostrophe && pathStarted(raw)) {
      const extra = /^'[^\s<>"]*/.exec(folded.slice(re.lastIndex));
      if (extra?.[0]) {
        raw += extra[0];
        re.lastIndex += extra[0].length;
      }
    }
    const trimmed = raw.replace(/[),.;!?]+$/g, "");
    const end = re.lastIndex;
    if (
      keepPathApostrophe &&
      trimmed.length > 0 &&
      (markInsideAuthority(trimmed) || boundaryMarkAt(folded, end))
    ) {
      re.lastIndex = match.index + 1;
      match = re.exec(folded);
      continue;
    }
    if (trimmed) {
      let url = /^(?:https?|tg):/i.test(trimmed)
        ? trimmed
        : `http://${trimmed}`;
      // 后面的空格仍交给这一段，Android 才能退回上一个单词。
      if (keepPathApostrophe && folded.charAt(end) === " ") {
        url += " ";
      }
      found.push(url);
    }
    match = re.exec(folded);
  }
  return found;
}

/** U+0345 在忽略大小写时会连上希腊字母。先换成普通的组合附加符号。 */
function foldBoundaryMark(text: string): string {
  return text.replaceAll("\u0345", "\u0300");
}

function boundaryMark(code: number): boolean {
  return DRAFT_MARK_CHAR.test(String.fromCodePoint(code));
}

function boundaryMarkAt(text: string, index: number): boolean {
  const code = text.codePointAt(index);
  return code !== undefined && boundaryMark(code);
}

/** 主机名还没进路径时，非间距符号把这一段粘住。 */
function markInsideAuthority(raw: string): boolean {
  let index = 0;
  const scheme = /^(?:https?:\/\/|tg:(?:\/\/)?)/i.exec(raw);
  if (scheme?.[0]) {
    index = scheme[0].length;
  }
  while (index < raw.length) {
    const code = raw.codePointAt(index);
    if (code === undefined) {
      return false;
    }
    if (boundaryMark(code)) {
      return true;
    }
    const char = String.fromCodePoint(code);
    if (char === "/" || char === "?" || char === "#") {
      return false;
    }
    index += char.length;
  }
  return false;
}

/** `%2F` 后面的字面斜杠仍分开下一段。两道编码斜杠留在一起。 */
function openEncodedSlashBoundary(text: string): string {
  return text.replace(/%2F(?=\/)/gi, (mark) => `${mark} `);
}

/** 已经结束的主机名在编码间隔前停下。协议正后面的间隔留下十六进制。 */
function openEncodedGapHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const gap = draftEncodedGapLength(text, index);
    if (gap > 0 && encodedDotAfterHost(out)) {
      const hex = text.slice(index, index + gap).replace(/%/g, "");
      out += ` ${hex}`;
      index += gap;
      continue;
    }
    if (gap > 0 && out.toLowerCase().endsWith("://")) {
      out += text.slice(index, index + gap).replace(/%/g, "");
      index += gap;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function draftEncodedGapLength(text: string, index: number): number {
  const single = draftSingleEncodedGap(text, index);
  if (single > 0) {
    return single;
  }
  return draftDoubleEncodedGap(text, index);
}

function draftSingleEncodedGap(text: string, index: number): number {
  const first = draftPercentByte(text, index);
  if (first === null) {
    return 0;
  }
  const width = draftUtf8Width(first.byte);
  if (width === 0) {
    return 0;
  }
  const bytes = [first.byte];
  let next = first.next;
  for (let part = 1; part < width; part += 1) {
    const byte = draftPercentByte(text, next);
    if (byte === null || (byte.byte & 0xc0) !== 0x80) {
      return 0;
    }
    bytes.push(byte.byte);
    next = byte.next;
  }
  let char = "";
  try {
    char = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return 0;
  }
  if (foldMatchText(char) !== "") {
    return 0;
  }
  return next - index;
}

function draftDoubleEncodedGap(text: string, index: number): number {
  let inner = "";
  let cursor = index;
  let groups = 0;
  while (groups < 4 && cursor + 5 <= text.length) {
    if (text.slice(cursor, cursor + 3).toLowerCase() !== "%25") {
      break;
    }
    const hex = text.slice(cursor + 3, cursor + 5);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      break;
    }
    inner += `%${hex}`;
    cursor += 5;
    groups += 1;
    if (draftEncodedGapsCover(inner)) {
      return cursor - index;
    }
  }
  return 0;
}

function draftEncodedGapsCover(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const skipped = draftSingleEncodedGap(text, index);
    if (skipped === 0) {
      return false;
    }
    index += skipped;
  }
  return text.length > 0;
}

function draftPercentByte(
  text: string,
  index: number,
): { byte: number; next: number } | null {
  if (text.charCodeAt(index) !== 37) {
    return null;
  }
  const hex = text.slice(index + 1, index + 3);
  if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
    return null;
  }
  return { byte: Number.parseInt(hex, 16), next: index + 3 };
}

function draftUtf8Width(first: number): number {
  if (first < 0x80) {
    return 1;
  }
  if (first >= 0xc2 && first <= 0xdf) {
    return 2;
  }
  if (first >= 0xe0 && first <= 0xef) {
    return 3;
  }
  if (first >= 0xf0 && first <= 0xf4) {
    return 4;
  }
  return 0;
}

/** 粘连扫描会吃掉的间隔。普通空格留下，字面主机名仍能打开。 */
const DRAFT_HOST_GAP =
  /[\t\n\v\f\r\u00A0\u00AD\u061C\u1680\u180E\u2000-\u200F\u2028-\u202E\u202F\u205F\u2060-\u2064\u2066-\u2069\u3000\uFEFF]/;

/** 贴在编码主机名前面的 `%2B`、`%2F`、`%2D` 和 `%252D` 在百分号处停下。 */
function openEncodedHostBody(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const percent = encodedHostBodyPercent(text, index);
    if (percent >= 0) {
      out += `${text.slice(index, percent)} `;
      index = percent + 1;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedHostBodyPercent(text: string, index: number): number {
  const marker = encodedHostBodyMarker(text, index);
  if (marker === 0 || encodedHostBodyInPath(text, index)) {
    return -1;
  }
  let cursor = index + marker;
  while (DRAFT_HOST_GAP.test(text.charAt(cursor))) {
    cursor += 1;
  }
  const scheme = text.slice(cursor, cursor + 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return -1;
  }
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === "%") {
      const rest = text.slice(cursor + 1);
      if (
        /^[0-9A-Fa-f]{2}/.test(rest) &&
        (encodedBodyHost(rest) || encodedBodyIp(rest))
      ) {
        return cursor;
      }
      const unit = encodedBodyUnit(text, cursor);
      if (unit === 0) {
        return -1;
      }
      cursor += unit;
      continue;
    }
    if (/[A-Za-z0-9._-]/.test(char)) {
      cursor += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

function encodedHostBodyMarker(text: string, index: number): number {
  if (text.slice(index, index + 5).toLowerCase() === "%252d") {
    return 5;
  }
  const three = text.slice(index, index + 3).toLowerCase();
  if (three === "%2b" || three === "%2f" || three === "%2d") {
    return 3;
  }
  return 0;
}

function encodedHostBodyInPath(text: string, index: number): boolean {
  if (text.charAt(index - 1) === "/") {
    return true;
  }
  return text.slice(index - 3, index).toLowerCase() === "%2f";
}

function encodedBodyHost(rest: string): boolean {
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
    "i",
  ).test(rest);
}

function encodedBodyIp(rest: string): boolean {
  return new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest);
}

function encodedBodyUnit(text: string, index: number): number {
  for (const marker of ["%25", "%"] as const) {
    if (text.slice(index, index + marker.length).toLowerCase() !== marker) {
      continue;
    }
    const hex = text.slice(index + marker.length, index + marker.length + 2);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      continue;
    }
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    if (/[A-Za-z0-9_-]/.test(char)) {
      return marker.length + 2;
    }
  }
  return 0;
}

/** 不在路径里的 `%2D` 和 `%252D` 留下十六进制，后面的主机名仍能以短链结尾。 */
function openEncodedHyphenHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const taken = encodedHyphenHostMark(text, index);
    if (taken > 0) {
      out += ` ${text.slice(index + 1, index + taken)}`;
      index += taken;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedHyphenHostMark(text: string, index: number): number {
  const five = text.slice(index, index + 5).toLowerCase();
  const three = text.slice(index, index + 3).toLowerCase();
  const taken = five === "%252d" ? 5 : three === "%2d" ? 3 : 0;
  if (taken === 0) {
    return 0;
  }
  if (text.charAt(index - 1) === "/") {
    return 0;
  }
  if (text.slice(index - 3, index).toLowerCase() === "%2f") {
    return 0;
  }
  const rest = text.slice(index + taken);
  const scheme = rest.slice(0, 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return 0;
  }
  if (new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest)) {
    return taken;
  }
  if (
    new RegExp(
      `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
      "i",
    ).test(rest)
  ) {
    return taken;
  }
  return 0;
}

/** 贴在字面主机名前面的 `%2F` 留下两位十六进制，短链后缀仍对得上。 */
function openEncodedSlashHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (encodedSlashSplitsHost(text, index)) {
      out += ` ${text.slice(index + 1, index + 3)}`;
      index += 3;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedSlashSplitsHost(text: string, index: number): boolean {
  if (text.slice(index, index + 3).toLowerCase() !== "%2f") {
    return false;
  }
  const rest = text.slice(index + 3);
  if (rest.startsWith("/")) {
    return false;
  }
  const scheme = rest.slice(0, 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return false;
  }
  if (new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest)) {
    return true;
  }
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
    "i",
  ).test(rest);
}

/** 不在路径里的 `%2B` 留下两位十六进制，后面的主机名仍能以短链结尾。 */
function openEncodedPlusHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (encodedPlusSplitsHost(text, index)) {
      out += ` ${text.slice(index + 1, index + 3)}`;
      index += 3;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedPlusSplitsHost(text: string, index: number): boolean {
  if (text.slice(index, index + 3).toLowerCase() !== "%2b") {
    return false;
  }
  if (text.charAt(index - 1) === "/") {
    return false;
  }
  if (text.slice(index - 3, index).toLowerCase() === "%2f") {
    return false;
  }
  const rest = text.slice(index + 3);
  const scheme = rest.slice(0, 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return false;
  }
  if (new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").test(rest)) {
    return true;
  }
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})(?![A-Za-z0-9_-])`,
    "i",
  ).test(rest);
}

/**
 * 一层括号点。闭合括号写成百分号时，已经结束的主机名后面留下十六进制。
 * 字面闭合括号收成点，避免停住字符先把 `[.]` 拆开。
 */
const DRAFT_BRACKET_DOT =
  /(?:[[\uFF3B]|%5B)(?:\.|。|%2E)(?:[\]\uFF3D]|%5D)|(?:[(\uFF08]|%28)(?:\.|。|%2E)(?:[)\uFF09]|%29)|(?:[{\uFF5B]|%7B)(?:\.|。|%2E)(?:[}\uFF5D]|%7D)/gi;

/** 已经结束的主机名后面，编码括号点留下闭合十六进制。字面括号点收成点。 */
function openEncodedBracketHost(text: string): string {
  const pattern = new RegExp(DRAFT_BRACKET_DOT.source, "gi");
  let out = "";
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0] ?? "";
    out += text.slice(index, start);
    const closer = draftEncodedBracketHex(raw);
    if (closer !== null && encodedDotAfterHost(out)) {
      out += ` ${closer}`;
    } else if (closer === null && encodedDotAfterHost(out)) {
      out += " ";
    } else if (closer === null) {
      out += ".";
    } else {
      out += raw;
    }
    index = start + raw.length;
  }
  return out + text.slice(index);
}

function draftEncodedBracketHex(raw: string): string | null {
  const tail = raw.slice(-3);
  if (/^%(?:5d|29|7d)$/i.test(tail)) {
    return tail.slice(1);
  }
  return null;
}

/**
 * 带协议的主机名在多字节百分号前停下。
 * 路径、用户信息、间隔和点状字符仍留在这一段。
 */
function openSchemedPercentHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const lookalike = encodedDotLookalikeLength(text, index);
    if (lookalike > 0) {
      out += text.slice(index, index + lookalike);
      index += lookalike;
      continue;
    }
    const byte = draftPercentByte(text, index);
    if (
      byte !== null &&
      byte.byte >= 0x80 &&
      draftEncodedGapLength(text, index) === 0 &&
      schemedAuthorityAt(text, index)
    ) {
      out += " ";
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedDotLookalikeLength(text: string, index: number): number {
  const first = draftPercentByte(text, index);
  if (first === null) {
    return 0;
  }
  const width = draftUtf8Width(first.byte);
  if (width < 2) {
    return 0;
  }
  const bytes = [first.byte];
  let next = first.next;
  for (let part = 1; part < width; part += 1) {
    const byte = draftPercentByte(text, next);
    if (byte === null || (byte.byte & 0xc0) !== 0x80) {
      return 0;
    }
    bytes.push(byte.byte);
    next = byte.next;
  }
  let char = "";
  try {
    char = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(bytes),
    );
  } catch {
    return 0;
  }
  return DRAFT_DOT_LOOKALIKE.has(char.codePointAt(0) ?? -1) ? next - index : 0;
}

function schemedAuthorityAt(text: string, index: number): boolean {
  let from = index;
  while (from > 0) {
    const head = text.slice(0, from).toLowerCase();
    const https = head.lastIndexOf("https://");
    const http = head.lastIndexOf("http://");
    let scheme = -1;
    let mark = 0;
    if (https > http) {
      scheme = https;
      mark = 8;
    } else if (http >= 0 && !(https >= 0 && http === https + 1)) {
      scheme = http;
      mark = 7;
    } else if (https >= 0) {
      scheme = https;
      mark = 8;
    }
    if (scheme < 0) {
      return false;
    }
    if (scheme > 0 && /[A-Za-z0-9_]/.test(text.charAt(scheme - 1))) {
      from = scheme;
      continue;
    }
    const authority = text.slice(scheme + mark, index);
    if (/[/?#\s]/.test(authority)) {
      return false;
    }
    const rest = text.slice(index);
    const end = rest.search(/[/?#\s]/);
    const tail = end === -1 ? rest : rest.slice(0, end);
    return !tail.includes("@");
  }
  return false;
}

/** 已经结束的主机名后面，`%2E` 留下两位十六进制。紧挨协议的 `%2E` 仍交给粘连扫描。 */
function openFinishedEncodedDot(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (
      text.slice(index, index + 3).toLowerCase() === "%2e" &&
      !encodedDotBeforeScheme(text, index + 3) &&
      encodedDotAfterHost(out)
    ) {
      out += ` ${text.slice(index + 1, index + 3)}`;
      index += 3;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedDotBeforeScheme(text: string, index: number): boolean {
  const next = text.slice(index, index + 8).toLowerCase();
  return next.startsWith("https://") || next.startsWith("http://");
}

function encodedDotAfterHost(out: string): boolean {
  let host = out;
  const scheme = host.toLowerCase().lastIndexOf("://");
  if (scheme >= 0) {
    host = host.slice(scheme + 3);
  }
  const at = host.lastIndexOf("@");
  if (at >= 0) {
    host = host.slice(at + 1);
  }
  if (/[/?#\s]/.test(host)) {
    return false;
  }
  host = host.replace(/:\d{1,5}$/, "");
  if (new RegExp(`^(?:${DRAFT_IP})$`, "i").test(host)) {
    return true;
  }
  return new RegExp(
    `^(?:${DRAFT_ASCII_LABEL}\\.)+(?:${androidStrictTld})$`,
    "i",
  ).test(host);
}

/** 路径或问号已经开始后，单引号仍属于这一段。 */
function pathStarted(raw: string): boolean {
  const scheme = raw.indexOf("://");
  const body = scheme === -1 ? raw : raw.slice(scheme + 3);
  return /[/?]/.test(body);
}

/** 草稿里 Android 停住、而整段抽取不停的字符。路径里留住的增补字符另外判断。 */
const DRAFT_STOP_CHAR = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}[\\]\\\\^\`{|\\u0080-\\u009F\\uD800-\\uDFFF\\uE000-\\uF8FF\\uFDD0-\\uFDEF\\uFFF0-\\uFFFF}]`,
);

/** `://` 后面不是一到五位端口时，路径里的网址另开。 */
function openHostlessPort(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeEndingAt(text, index);
    if (scheme > 0 && text.charAt(index) === ":") {
      const digits = /^\d*/.exec(text.slice(index + 1))?.[0] ?? "";
      const next = text.charAt(index + 1 + digits.length);
      const port = digits.length >= 1 && digits.length <= 5;
      if (!port && (next === "/" || next === "?")) {
        out += `${text.slice(index - scheme, index + 1 + digits.length)} `;
        index += 1 + digits.length;
        continue;
      }
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

/** `://` 后面紧挨的 `#` 结束这一段，后面的主机名另开。 */
function openEmptyHash(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.charAt(index) === "#" && schemeEndingAt(text, index) > 0) {
      out += " ";
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function schemeEndingAt(text: string, index: number): number {
  if (index >= 8 && text.slice(index - 8, index).toLowerCase() === "https://") {
    const start = index - 8;
    if (start > 0 && /[A-Za-z0-9_]/.test(text.charAt(start - 1))) {
      return 0;
    }
    return 8;
  }
  if (index >= 7 && text.slice(index - 7, index).toLowerCase() === "http://") {
    const start = index - 7;
    if (start > 0 && /[A-Za-z0-9_]/.test(text.charAt(start - 1))) {
      return 0;
    }
    return 7;
  }
  return 0;
}

function openedDraftUrls(text: string): string[] {
  const source = `${DRAFT_URL}|\\b(?:${DRAFT_IP})\\b${DRAFT_IP_TAIL}`;
  return scanUrls(
    openSchemedScript(
      openSchemedLookalike(
        openPathQuote(
          openPlainTg(
            openBareEnd(
              openSchemeLetter(
                openLookalikeHost(
                  openLongLabel(
                    openLongUserinfo(
                      openHostlessPort(
                        openEmptyHash(
                          openDraftStops(
                            openEncodedBracketHost(
                              openStoppingSpace(
                                openFinishedEncodedDot(
                                  openSchemedPercentHost(
                                    openEncodedSlashBoundary(
                                      openEncodedSlashHost(
                                        openEncodedHyphenHost(
                                          openEncodedPlusHost(
                                            openEncodedHostBody(
                                              openEncodedGapHost(
                                                foldBoundaryMark(text),
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
    source,
    true,
  );
}

/**
 * 带协议的主机名后面，希腊文、西里尔文、亚美尼亚文和非 ASCII 拉丁字母在 `@` 前会被收掉。
 * 点号后面新起的这类标签也一样。主机名中间被地址解析忽略的标记同样先拿掉。
 * 连字符贴在主机名末尾时也一样。收掉之后 `@` 会变成用户信息。
 * 这里先换成空格，前面的短链仍单独打开。
 */
function openSchemedScript(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeAt(text, index);
    if (scheme === 0) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const hostStart = schemedUserinfoEnd(text, index + scheme);
    const hostEnd = schemedMarkedHostEnd(text, hostStart);
    const runEnd = hostEnd === null ? null : schemedScriptBreak(text, hostEnd);
    if (hostEnd === null || runEnd === null) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    out += `${text.slice(index, hostEnd)} `;
    index = runEnd;
  }
  return out;
}

/** 判断主机名时先拿掉忽略标记，结束位置仍指回原文。 */
function schemedMarkedHostEnd(text: string, index: number): number | null {
  let stripped = "";
  const map: number[] = [];
  for (let cursor = index; cursor < text.length; ) {
    const code = text.codePointAt(cursor);
    if (code === undefined) {
      break;
    }
    const char = String.fromCodePoint(code);
    if (!draftIgnoredMark(code)) {
      map.push(cursor);
      stripped += char;
    }
    cursor += char.length;
  }
  const end = schemedStrictHostEnd(stripped, 0);
  if (end === null || end === 0) {
    return null;
  }
  const mapped = map[end];
  if (end < map.length && mapped !== undefined) {
    return mapped;
  }
  const last = map[end - 1];
  if (last === undefined) {
    return null;
  }
  const lastCode = text.codePointAt(last);
  return (
    last + (lastCode === undefined ? 1 : String.fromCodePoint(lastCode).length)
  );
}

function schemedScriptBreak(text: string, hostEnd: number): number | null {
  if (text.charAt(hostEnd) === ".") {
    const afterDot = draftIgnoredMarkEnd(text, hostEnd + 1);
    const dotted = draftScriptRunEnd(text, afterDot);
    if (dotted > afterDot && text.charAt(dotted) === "@") {
      return dotted;
    }
  }
  const hyphen = draftHyphenRunEnd(text, hostEnd);
  if (hyphen > hostEnd) {
    const hyphenated = draftScriptRunEnd(text, hyphen);
    if (hyphenated > hyphen && text.charAt(hyphenated) === "@") {
      return hyphenated;
    }
  }
  const marked = draftIgnoredMarkEnd(text, hostEnd);
  const runEnd = draftScriptRunEnd(text, marked);
  if (runEnd > marked && text.charAt(runEnd) === "@") {
    return runEnd;
  }
  return null;
}

/**
 * 地址解析会忽略、Android 仍算进标签的标记。
 * 制表符、换行和不换行空格不算。
 */
function draftIgnoredMarkEnd(text: string, index: number): number {
  let end = index;
  while (end < text.length) {
    const code = text.codePointAt(end);
    if (code === undefined || !draftIgnoredMark(code)) {
      break;
    }
    end += String.fromCodePoint(code).length;
  }
  return end;
}

function draftIgnoredMark(code: number): boolean {
  if (code === 0x034f) {
    return true;
  }
  if (!draftAndroidLabelCode(code)) {
    return false;
  }
  return foldMatchText(String.fromCodePoint(code)) === "";
}

function draftAndroidLabelCode(code: number): boolean {
  if (
    code === 0x00a0 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x3000
  ) {
    return false;
  }
  if (code >= 0x00a0 && code <= 0xd7ff) {
    return true;
  }
  if (code >= 0xf900 && code <= 0xfdcf) {
    return true;
  }
  if (code >= 0xfdf0 && code <= 0xffef) {
    return true;
  }
  if (code >= 0x20000 && code <= 0xdfffd) {
    return (code & 0xffff) <= 0xfffd;
  }
  if (code >= 0xe1000 && code <= 0xefffd) {
    return (code & 0xffff) <= 0xfffd;
  }
  return false;
}

function draftHyphenRunEnd(text: string, index: number): number {
  let end = index;
  while (text.charAt(end) === "-") {
    end += 1;
  }
  return end;
}

function draftScriptRunEnd(text: string, index: number): number {
  let end = index;
  while (end < text.length) {
    const code = text.codePointAt(end);
    if (code === undefined || !draftScriptLetter(code)) {
      break;
    }
    end += String.fromCodePoint(code).length;
  }
  return end;
}

function draftScriptLetter(code: number): boolean {
  if (code <= 0x7f) {
    return false;
  }
  const char = String.fromCodePoint(code);
  return (
    /^\p{L}$/u.test(char) &&
    /^(?:\p{Script=Greek}|\p{Script=Cyrillic}|\p{Script=Armenian}|\p{Script=Latin})$/u.test(
      char,
    )
  );
}

/**
 * 带协议的主机名后面，点状间隔号在路径、问号、结尾、端口或点号前留在标签里。
 * 后面的解析会把间隔号收成点，所以这里先写成 `x`。
 * `@`、`#`、空格和句号仍打开前面的短链。
 */
function openSchemedLookalike(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeAt(text, index);
    if (scheme === 0) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const hostStart = schemedUserinfoEnd(text, index + scheme);
    const hostEnd = schemedStrictHostEnd(text, hostStart);
    const runEnd =
      hostEnd === null ? hostStart : draftLookalikeRunEnd(text, hostEnd);
    if (
      hostEnd === null ||
      runEnd === hostEnd ||
      !schemedDraftLookalikeTail(text.slice(runEnd))
    ) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    const tail = text.slice(runEnd).search(/\s/);
    const next = tail === -1 ? text.length : runEnd + tail;
    out += `${text.slice(index, hostEnd)}x${text.slice(runEnd, next)}`;
    index = next;
  }
  return out;
}

function schemedUserinfoEnd(text: string, index: number): number {
  const userinfo =
    /^(?:[A-Za-z0-9$_.+!*'(),;?&=-]{1,64}(?::[A-Za-z0-9$_.+!*'(),;?&=-]{1,25})?@)/.exec(
      text.slice(index),
    );
  return userinfo ? index + userinfo[0].length : index;
}

/** 写完的主机名取最长的严格域名，或一段点分 IPv4。中间的短链后缀不停。 */
function schemedStrictHostEnd(text: string, index: number): number | null {
  const address = new RegExp(`^(?:${DRAFT_IP})(?![0-9.])`, "i").exec(
    text.slice(index),
  );
  let cursor = index;
  let end: number | null = null;
  const first = readAsciiHostLabel(text, cursor);
  if (first > 0) {
    cursor += first;
    while (text.charAt(cursor) === ".") {
      const next = readAsciiHostLabel(text, cursor + 1);
      if (next === 0) {
        break;
      }
      const label = text.slice(cursor + 1, cursor + 1 + next);
      cursor += 1 + next;
      if (isStrictTld(label)) {
        end = cursor;
      }
    }
  }
  if (address?.[0] && (end === null || index + address[0].length > end)) {
    return index + address[0].length;
  }
  return end;
}

function readAsciiHostLabel(text: string, index: number): number {
  if (!/[A-Za-z0-9]/.test(text.charAt(index))) {
    return 0;
  }
  let cursor = index + 1;
  const limit = Math.min(text.length, index + 63);
  while (cursor < limit && /[A-Za-z0-9-]/.test(text.charAt(cursor))) {
    cursor += 1;
  }
  while (cursor > index && text.charAt(cursor - 1) === "-") {
    cursor -= 1;
  }
  return cursor - index;
}

function draftLookalikeRunEnd(text: string, index: number): number {
  let end = index;
  while (end < text.length && DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(end))) {
    end += 1;
  }
  return end;
}

function schemedDraftLookalikeTail(rest: string): boolean {
  return (
    rest.length === 0 ||
    rest.startsWith("/") ||
    rest.startsWith("?") ||
    rest.startsWith(".") ||
    /^:\d{1,5}(?!\d)/.test(rest)
  );
}

/** 这些空白会结束网址。U+1680、U+205F 和 U+FEFF 仍留在标签里。 */
const DRAFT_STOP_SPACE = /[\u00A0\u2000-\u200A\u2028\u2029\u202F\u3000]/g;

function openStoppingSpace(text: string): string {
  return text.replace(DRAFT_STOP_SPACE, " ");
}

/** 路径还没开始的单引号，以及双引号，仍结束这一段。路径里的单引号留下。 */
function openPathQuote(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    const split = quoteSplit(text.slice(index, next));
    if (split === null) {
      out += text.slice(index, next);
      index = next;
      if (index < text.length) {
        out += text.charAt(index);
        index += 1;
      }
      continue;
    }
    out += split === 0 ? " " : `${text.slice(index, index + split)} `;
    index += split + 1;
  }
  return out;
}

function quoteSplit(token: string): number | null {
  let index = schemeAt(token, 0);
  while (index < token.length) {
    const current = token.charAt(index);
    if (current === "/" || current === "?") {
      const quote = token.indexOf('"', index);
      if (quote !== -1 && schemeAt(token, quote + 1) > 0) {
        return quote;
      }
      return null;
    }
    if (current === "'") {
      const rest = token.slice(index + 1);
      if (schemeAt(rest, 0) > 0 || bareHostAt(rest)) {
        return index;
      }
      return null;
    }
    if (current === '"' && schemeAt(token, index + 1) > 0) {
      return index;
    }
    index += 1;
  }
  return null;
}

function bareHostAt(rest: string): boolean {
  return bareDomainEnd(rest, 0) !== null || bareIpAt(rest);
}

/** 没有两个斜杠的 `tg:` 不盖住后面的网址。`tg://` 仍是一条。 */
function openPlainTg(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (!plainTgAt(text, index)) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const rest = text.slice(index + 3);
    if (rest.startsWith("//")) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    if (schemeAt(text, index + 3) > 0 || bareIpAt(rest)) {
      out += " ";
      index += 3;
      continue;
    }
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    out += text.slice(index, next);
    index = next;
  }
  return out;
}

function plainTgAt(text: string, index: number): boolean {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return false;
  }
  return text.slice(index, index + 3).toLowerCase() === "tg:";
}

function bareIpAt(rest: string): boolean {
  return new RegExp(`^(?:${DRAFT_IP})(?![A-Za-z0-9_])`, "i").test(rest);
}

/** 用户名超过 64 或密码超过 25 时，Android 从 `@` 后面另开网址。放得下的仍是一条。 */
function openLongUserinfo(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeAt(text, index);
    if (scheme === 0) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const at = userinfoOverflow(text, index + scheme);
    if (at !== null) {
      out += " ";
      index = at + 1;
      continue;
    }
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    out += text.slice(index, next);
    index = next;
  }
  return out;
}

function schemeAt(text: string, index: number): number {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return 0;
  }
  const slice = text.slice(index, index + 8).toLowerCase();
  if (slice.startsWith("https://")) {
    return 8;
  }
  if (slice.startsWith("http://")) {
    return 7;
  }
  return 0;
}

function userinfoOverflow(text: string, start: number): number | null {
  const user = readUserRun(text, start);
  if (text.charAt(user.index) === "@") {
    return user.count > 64 ? user.index : null;
  }
  if (text.charAt(user.index) !== ":" || user.count === 0 || user.count > 64) {
    return null;
  }
  const password = readUserRun(text, user.index + 1);
  if (text.charAt(password.index) === "@" && password.count > 25) {
    return password.index;
  }
  return null;
}

function readUserRun(
  text: string,
  index: number,
): { count: number; index: number } {
  let count = 0;
  while (index < text.length) {
    const size = userCharSize(text, index);
    if (size === 0) {
      break;
    }
    count += 1;
    index += size;
  }
  return { count, index };
}

function userCharSize(text: string, index: number): number {
  if (
    text.charAt(index) === "%" &&
    /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))
  ) {
    return 3;
  }
  if (/[A-Za-z0-9$._+!*'(),;?&=-]/.test(text.charAt(index))) {
    return 1;
  }
  return 0;
}

const DRAFT_LABEL = "(?:[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?)";
const DRAFT_HOST = `(?:${DRAFT_LABEL}(?:\\.${DRAFT_LABEL})*)`;
const DRAFT_HOST_END = new RegExp(`^${DRAFT_HOST}(?![A-Za-z0-9_])`);

/** 标签超过 63，或连字符让标签放不下时，Android 另开后面的网址。放得下的仍是一条。 */
function openLongLabel(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const scheme = schemeAt(text, index);
    if (scheme === 0) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const authority = text.slice(index + scheme);
    const host = draftHostLength(authority);
    if (host === null) {
      const later = schemeAfterHostRun(authority);
      if (later !== null) {
        out += " ";
        index += scheme + later;
        continue;
      }
    } else {
      const rest = authority.slice(host);
      const atMark = lookalikeBeforeAt(rest);
      if (atMark > 0) {
        out += `${text.slice(index, index + scheme + host)} `;
        index += scheme + host + atMark;
        continue;
      }
      if (rest.startsWith("@") && !atCanFinish(rest)) {
        out += `${text.slice(index, index + scheme + host)} `;
        index = skipUnfinishedAt(text, index + scheme + host + 1);
        continue;
      }
      if (labelEndsUrl(authority.slice(0, host), rest) || hostPunctEnds(rest)) {
        out += `${text.slice(index, index + scheme + host)} `;
        index += scheme + host + 1;
        continue;
      }
      const port = /^:\d{1,5}(?!\d)/.exec(rest);
      if (port?.[0]) {
        const after = rest.slice(port[0].length);
        if (
          after.startsWith("-") ||
          (after.startsWith(".") && schemeAt(after, 1) > 0)
        ) {
          out += `${text.slice(index, index + scheme + host + port[0].length)} `;
          index += scheme + host + port[0].length + 1;
          continue;
        }
      }
      const dotted = /^\.:\d{1,5}(?!\d)/.exec(rest);
      if (dotted?.[0] && portTailSplits(rest.slice(dotted[0].length))) {
        out += `${text.slice(index, index + scheme + host + dotted[0].length)} `;
        index += scheme + host + dotted[0].length + 1;
        continue;
      }
    }
    const end = text.slice(index).search(/\s/);
    const next = end === -1 ? text.length : index + end;
    out += text.slice(index, next);
    index = next;
  }
  return out;
}

function draftHostLength(authority: string): number | null {
  const match = DRAFT_HOST_END.exec(authority);
  return match ? match[0].length : null;
}

const HOST_PUNCT = "!#$&()*+,;=~";
const DRAFT_DOT_LOOKALIKE = new Set([
  0x00b7, 0x2022, 0x2027, 0x2219, 0x22c5, 0x30fb, 0xff0e, 0xfe52, 0xff61,
]);

/** 点状字符拼成的裸主机名不盖住后面的网址。带协议的仍是一条。 */
function openLookalikeHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (schemeAt(text, index) > 0) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    const skip = lookalikeHostSkip(text, index);
    if (skip > 0) {
      out += " ";
      index += skip;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function lookalikeHostSkip(text: string, index: number): number {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return 0;
  }
  const first = readDraftLabel(text, index);
  if (first === 0) {
    return 0;
  }
  let cursor = index + first;
  let sawLookalike = false;
  while (cursor < text.length) {
    const lookalike = DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(cursor));
    if (text.charAt(cursor) !== "." && !lookalike) {
      break;
    }
    const next = readDraftLabel(text, cursor + 1);
    if (next === 0) {
      break;
    }
    if (lookalike) {
      sawLookalike = true;
    }
    cursor += 1 + next;
  }
  if (!sawLookalike) {
    return 0;
  }
  if (text.charAt(cursor) !== "/" && text.charAt(cursor) !== "?") {
    return 0;
  }
  const body = text.slice(cursor + 1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return cursor + 1 - index;
  }
  return 0;
}

const DRAFT_SCHEME_LETTER = new Set([
  0x0406, 0x0410, 0x0415, 0x041e, 0x0420, 0x0421, 0x0423, 0x0425, 0x0430,
  0x0435, 0x043e, 0x0440, 0x0441, 0x0443, 0x0445, 0x0456,
]);

function schemeLetter(code: number): boolean {
  return (
    DRAFT_SCHEME_LETTER.has(code) ||
    (code >= 0xff21 && code <= 0xff3a) ||
    (code >= 0xff41 && code <= 0xff5a)
  );
}

/** 形近字母紧挨在协议前面时另开后面的网址。带协议的同一段仍留在一起。 */
function openSchemeLetter(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (schemeAt(text, index) > 0) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    if (schemeLetter(text.charCodeAt(index)) && schemeAt(text, index + 1) > 0) {
      out += " ";
      index += 1;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

/** 点状字符紧挨在 `@` 前面时，带协议的主机名在这里结束。后面的网址另开。 */
function lookalikeBeforeAt(rest: string): number {
  let cursor = 0;
  while (DRAFT_DOT_LOOKALIKE.has(rest.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor === 0 || rest.charAt(cursor) !== "@") {
    return 0;
  }
  if (schemeAt(rest, cursor + 1) === 0) {
    return 0;
  }
  return cursor + 1;
}

function labelEndsUrl(host: string, rest: string): boolean {
  if (rest.startsWith("-")) {
    return !hyphenLabelFits(host, rest);
  }
  if (
    !rest.startsWith(".") ||
    rest.charAt(1) === "@" ||
    DRAFT_DOT_LOOKALIKE.has(rest.charCodeAt(1))
  ) {
    return false;
  }
  const next = rest.codePointAt(1);
  if (next !== undefined && draftLabelCode(next)) {
    return false;
  }
  return !/^[:/?_]/.test(rest.charAt(1));
}

/** 连字符后面的标签字仍放得进 63 个字时，这一段不切开。 */
function hyphenLabelFits(host: string, rest: string): boolean {
  const dot = host.lastIndexOf(".");
  const label = dot === -1 ? host : host.slice(dot + 1);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(label)) {
    return false;
  }
  let units = label.length;
  let index = 0;
  while (index < rest.length && units < 63) {
    const mark = rest.charAt(index);
    if (mark === "-" || mark === "_") {
      let look = index;
      let marks = 0;
      while (
        look < rest.length &&
        (rest.charAt(look) === "-" || rest.charAt(look) === "_")
      ) {
        look += 1;
        marks += 1;
      }
      const after = draftHostUnit(rest, look);
      if (after === 0 || units + marks >= 63) {
        break;
      }
      units += marks + 1;
      index = look + after;
      continue;
    }
    const size = draftHostUnit(rest, index);
    if (size === 0) {
      break;
    }
    units += 1;
    index += size;
  }
  if (index === 0) {
    return false;
  }
  if (
    index < rest.length &&
    (draftHostUnit(rest, index) > 0 ||
      rest.charAt(index) === "-" ||
      rest.charAt(index) === "_")
  ) {
    return false;
  }
  const next = rest.charAt(index);
  return (
    next.length === 0 ||
    next === "/" ||
    next === "?" ||
    next === "." ||
    next === ":" ||
    next === "@" ||
    next === "#" ||
    next === " "
  );
}

function draftHostUnit(text: string, index: number): number {
  const code = text.codePointAt(index);
  if (code === undefined) {
    return 0;
  }
  if (code <= 0x7f) {
    return /[A-Za-z0-9]/.test(text.charAt(index)) ? 1 : 0;
  }
  if (!draftLabelCode(code)) {
    return 0;
  }
  return code > 0xffff ? 2 : 1;
}

/** Android 收进标签的字。带协议的主机名在点号后面仍接着这个字。 */
function draftLabelCode(code: number): boolean {
  if (
    code === 0x00a0 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x3000
  ) {
    return false;
  }
  if (code >= 0x00a0 && code <= 0xd7ff) {
    return true;
  }
  if (code >= 0xf900 && code <= 0xfdcf) {
    return true;
  }
  if (code >= 0xfdf0 && code <= 0xffef) {
    return true;
  }
  if (code >= 0x20000 && code <= 0xdfffd) {
    return (code & 0xffff) <= 0xfffd;
  }
  if (code >= 0xe1000 && code <= 0xefffd) {
    return (code & 0xffff) <= 0xfffd;
  }
  return false;
}

/** 路径还没开始时，这些标点结束主机名。端口和 `user:pass@` 仍属于这一条。 */
function hostPunctEnds(rest: string): boolean {
  if (rest.startsWith("://") || isPort(rest) || passwordUserinfo(rest)) {
    return false;
  }
  if (rest.startsWith(":")) {
    return true;
  }
  return rest.length > 0 && HOST_PUNCT.includes(rest.charAt(0));
}

function isPort(rest: string): boolean {
  return /^:\d{1,5}(?!\d)/.test(rest);
}

/** 点号后面的端口仍属于这一条。端口后再遇标点，才另开后面的网址。 */
function portTailSplits(after: string): boolean {
  return (
    hostPunctEnds(after) ||
    after.startsWith("-") ||
    (after.startsWith(".") && schemeAt(after, 1) > 0)
  );
}

function passwordUserinfo(rest: string): boolean {
  const password =
    /^:(?:%[0-9A-Fa-f]{2}|[A-Za-z0-9$._+!*'(),;?&=-]){1,25}@/.exec(rest);
  if (!password?.[0]) {
    return false;
  }
  return atCanFinish(rest.slice(password[0].length - 1));
}

/** `@` 后面能接上主机名、路径、端口或 `_` 时，用户信息才成立。 */
function atCanFinish(rest: string): boolean {
  const next = rest.charAt(1);
  if (next === "" || next === "/" || next === "?" || next === "_") {
    return true;
  }
  if (/[A-Za-z0-9]/.test(next) || next.charCodeAt(0) > 0x7f) {
    return true;
  }
  if (next !== ":") {
    return false;
  }
  const port = /^:\d{1,5}(?!\d)/.exec(rest.slice(1));
  if (!port?.[0]) {
    return false;
  }
  const after = rest.charAt(1 + port[0].length);
  return after === "" || !/[A-Za-z0-9_]/.test(after);
}

function skipUnfinishedAt(text: string, index: number): number {
  while (index < text.length && !/\s/.test(text.charAt(index))) {
    if (schemeAt(text, index) > 0) {
      return index;
    }
    index += 1;
  }
  return index;
}

/** 裸域名和 `www.` 停在最后一个标签。连字符、点号或标签字符后面的网址另开一条。 */
function openBareEnd(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (schemeAt(text, index) > 0) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    const loose = bareDomainEnd(text, index);
    const strict = strictBareEnd(text, index);
    if (loose !== null && (strict === null || strict < loose)) {
      const inner = urlAfterLoose(text.slice(loose));
      if (inner >= 0) {
        if (strict !== null) {
          out += `${text.slice(index, strict)} `;
        }
        index = loose + inner;
        continue;
      }
    }
    const domain = strict ?? loose;
    if (domain === null) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const rest = text.slice(domain);
    const port = /^:\d{1,5}(?!\d)/.exec(rest);
    if (port?.[0]) {
      const after = rest.slice(port[0].length);
      if (
        after.startsWith("-") ||
        (after.startsWith(".") && schemeAt(after, 1) > 0)
      ) {
        out += `${text.slice(index, domain + port[0].length)} `;
        index = domain + port[0].length + 1;
        continue;
      }
    }
    const dotted = bareDotSkip(rest);
    if (dotted > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + dotted;
      continue;
    }
    const lookalike = bareLookalikeDotSkip(rest);
    if (lookalike > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + lookalike;
      continue;
    }
    const glued = gluedMappedScheme(rest);
    if (glued > 0) {
      const scheme = schemeAt(rest, glued);
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      const schemeAtIndex = domain + glued;
      out += text.slice(index, schemeAtIndex);
      out += `${text.slice(schemeAtIndex, schemeAtIndex + scheme - 3)}:x`;
      out += text.slice(schemeAtIndex + scheme, next);
      index = next;
      continue;
    }
    const letter = bareLetterSkip(rest);
    if (letter > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + letter;
      continue;
    }
    const hyphenScript = bareHyphenScriptSkip(rest);
    if (hyphenScript > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + hyphenScript;
      continue;
    }
    const unicodeTail = unicodeLabelRewrite(rest);
    if (unicodeTail !== null) {
      out += text.slice(index, domain);
      out += unicodeTail.replacement;
      index = domain + unicodeTail.length;
      continue;
    }
    const joinedTail = unicodeJoinRewrite(rest);
    if (joinedTail !== null) {
      out += text.slice(index, domain);
      out += joinedTail.replacement;
      index = domain + joinedTail.length;
      continue;
    }
    const label = bareLabelSkip(rest);
    if (label > 0) {
      out += `${text.slice(index, domain)} `;
      index = domain + label;
      continue;
    }
    if (
      rest.startsWith("/") ||
      rest.startsWith("?") ||
      port?.[0] ||
      !bareTailSplit(rest)
    ) {
      const end = text.slice(index).search(/\s/);
      const next = end === -1 ? text.length : index + end;
      out += text.slice(index, next);
      index = next;
      continue;
    }
    out += `${text.slice(index, domain)} `;
    index = domain + 1;
  }
  return out;
}

function isStrictTld(label: string): boolean {
  return label.length > 0 && STRICT_TLD_LABEL.test(label);
}

/** 裸域名和 `www.` 停在 Android 认的顶级域。认不出的后缀另开后面的网址。 */
function strictBareEnd(text: string, index: number): number | null {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return null;
  }
  const address = new RegExp(`^(?:${DRAFT_IP})`, "i").exec(text.slice(index));
  if (address?.[0] && bareIpAt(text.slice(index))) {
    return index + address[0].length;
  }
  let cursor = index;
  if (text.slice(cursor, cursor + 4).toLowerCase() === "www.") {
    cursor += 4;
  }
  const first = readDraftLabel(text, cursor);
  if (first === 0) {
    return null;
  }
  let labels = 1;
  cursor += first;
  let lastStrict: number | null = null;
  while (text.charAt(cursor) === ".") {
    if (schemeAt(text, cursor + 1) > 0) {
      break;
    }
    const next = readDraftLabel(text, cursor + 1);
    if (next === 0) {
      break;
    }
    const labelStart = cursor + 1;
    cursor += 1 + next;
    labels += 1;
    if (!isStrictTld(text.slice(labelStart, cursor))) {
      break;
    }
    if (labels >= 2) {
      lastStrict = cursor;
    }
  }
  return lastStrict;
}

function urlAfterLoose(rest: string): number {
  let skip = 0;
  const port = /^:\d{1,5}(?!\d)/.exec(rest);
  if (port?.[0]) {
    skip = port[0].length;
  }
  const tail = rest.slice(skip);
  if (!tail.startsWith("/") && !tail.startsWith("?")) {
    return -1;
  }
  const body = tail.slice(1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return skip + 1;
  }
  return -1;
}

function bareDomainEnd(text: string, index: number): number | null {
  if (index > 0 && /[A-Za-z0-9_]/.test(text.charAt(index - 1))) {
    return null;
  }
  let cursor = index;
  const www = text.slice(cursor, cursor + 4).toLowerCase() === "www.";
  if (www) {
    cursor += 4;
  }
  const first = readDraftLabel(text, cursor);
  if (first === 0) {
    return null;
  }
  let labels = 1;
  cursor += first;
  while (text.charAt(cursor) === ".") {
    if (schemeAt(text, cursor + 1) > 0) {
      break;
    }
    const next = readDraftLabel(text, cursor + 1);
    if (next === 0) {
      break;
    }
    cursor += 1 + next;
    labels += 1;
  }
  if (www ? labels < 1 : labels < 2) {
    return null;
  }
  return cursor;
}

function readDraftLabel(text: string, index: number): number {
  if (!/[A-Za-z0-9]/.test(text.charAt(index))) {
    return 0;
  }
  let cursor = index + 1;
  const limit = Math.min(text.length, index + 63);
  while (cursor < limit) {
    const current = text.charAt(cursor);
    if (!/[A-Za-z0-9_-]/.test(current)) {
      break;
    }
    if (
      (current === "-" || current === "_") &&
      schemeAt(text, cursor + 1) > 0
    ) {
      break;
    }
    cursor += 1;
  }
  while (cursor > index && /[-_]/.test(text.charAt(cursor - 1))) {
    cursor -= 1;
  }
  return cursor === index ? 0 : cursor - index;
}

function bareTailSplit(rest: string): boolean {
  const code = rest.codePointAt(0);
  if (code !== undefined && boundaryMark(code)) {
    return false;
  }
  if (rest.startsWith("-") || rest.startsWith(".")) {
    return schemeAt(rest, 1) > 0;
  }
  return (
    rest.length > 0 &&
    schemeAt(rest, 1) > 0 &&
    !/[A-Za-z0-9_./?#:]/.test(rest.charAt(0))
  );
}

/** 裸域名和 `www.` 不把路径前的点号留在这一段。点号后面的网址另开。 */
function bareDotSkip(rest: string): number {
  if (!rest.startsWith(".")) {
    return 0;
  }
  const afterDot = rest.slice(1);
  if (!/^[:/?]/.test(afterDot)) {
    return 0;
  }
  let skip = 1;
  const port = /^:\d{1,5}(?!\d)/.exec(afterDot);
  if (port?.[0]) {
    skip += port[0].length;
  }
  const tail = rest.slice(skip);
  if (tail.startsWith("/") || tail.startsWith("?")) {
    const body = tail.slice(1);
    if (
      schemeAt(body, 0) > 0 ||
      bareDomainEnd(body, 0) !== null ||
      bareIpAt(body)
    ) {
      skip += 1;
    }
  }
  return skip;
}

/** 裸域名和 `www.` 在 ASCII 点后的点状字符前结束。后面的网址另开。 */
function bareLookalikeDotSkip(rest: string): number {
  if (!rest.startsWith(".")) {
    return 0;
  }
  let index = 1;
  while (DRAFT_DOT_LOOKALIKE.has(rest.charCodeAt(index))) {
    index += 1;
  }
  if (index === 1) {
    return 0;
  }
  const after = rest.slice(index);
  if (schemeAt(after, 0) > 0) {
    return index;
  }
  if (!after.startsWith("/") && !after.startsWith("?")) {
    return 0;
  }
  const body = after.slice(1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return index + 1;
  }
  return 0;
}

/** 没有协议的主机名在 Android 留在标签里的字前面结束。后面是严格域名，或点号加严格域名时，标签字、句号和点状间隔号留给主机名扫描。 */
function bareLabelSkip(rest: string): number {
  const code = rest.codePointAt(0);
  if (code === undefined || !draftLabelCode(code) || boundaryMark(code)) {
    return 0;
  }
  if (code === 0x3002 || DRAFT_DOT_LOOKALIKE.has(code)) {
    return joiningDotSkip(rest);
  }
  const run = labelRunLength(rest);
  const tail = rest.slice(run);
  if (strictLabelTail(tail) || dottedStrictTail(tail)) {
    return 0;
  }
  const after = rest.slice(String.fromCodePoint(code).length);
  if (
    draftMappedTail(code) &&
    (draftDomainContinues(after) || schemeAt(after, 0) > 0)
  ) {
    return 0;
  }
  return String.fromCodePoint(code).length;
}

/** 连续的标签字。句号和点状间隔号另外判断。 */
function labelRunLength(rest: string): number {
  let index = 0;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (
      code === undefined ||
      code === 0x3002 ||
      DRAFT_DOT_LOOKALIKE.has(code) ||
      !draftLabelCode(code) ||
      boundaryMark(code)
    ) {
      break;
    }
    index += String.fromCodePoint(code).length;
  }
  return index;
}

/** 标签字后面是 Android 认的域名时，这一段留给主机名扫描收成 x。 */
function strictLabelTail(rest: string): boolean {
  const head = /^[^/?#\s]+/.exec(rest)?.[0] ?? "";
  const labels = head.split(".");
  if (labels.length < 2) {
    return false;
  }
  const tld = labels[labels.length - 1] ?? "";
  if (!isStrictTld(tld)) {
    return false;
  }
  return labels.every((label) => label.length > 0 && label.length <= 63);
}

/** 点号后面含 Android 标签字时，先收成 x 再写成 ASCII，避免后面的短链被单独打开。 */
function unicodeLabelRewrite(
  rest: string,
): { replacement: string; length: number } | null {
  const run = labelRunLength(rest);
  if (run === 0) {
    return null;
  }
  const tail = rest.slice(run);
  if (!tail.startsWith(".") || !dottedStrictTail(tail)) {
    return null;
  }
  const head = /^[^/?#\s]+/.exec(tail)?.[0] ?? "";
  if (!hasDraftNonAscii(head)) {
    return null;
  }
  const encoded = head
    .split(".")
    .map((label) =>
      label.length === 0 || !hasDraftNonAscii(label)
        ? label
        : punycodeLabel(label),
    )
    .join(".");
  return { replacement: `x${encoded}`, length: run + head.length };
}

function hasDraftNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      return true;
    }
  }
  return false;
}

function punycodeLabel(label: string): string {
  const host = new URL(`http://${label}.com`).hostname;
  const encoded = host.endsWith(".com") ? host.slice(0, -4) : host;
  return encoded.length > 0 ? encoded : label;
}

/** 点号后面是严格域名时，前面的标签字留给主机名扫描收成 x。标签可以是 Android 标签字。 */
function dottedStrictTail(rest: string): boolean {
  if (!rest.startsWith(".")) {
    return false;
  }
  const head = /^[^/?#\s]+/.exec(rest)?.[0] ?? "";
  return unicodeDotTail(head);
}

/** 点号后面的域名。ASCII 顶级域紧贴非 ASCII 时结束，两边都不是 ASCII 词字符时不拆开。 */
function unicodeDotTail(rest: string): boolean {
  let index = 1;
  let labelStart = 1;
  let last = 0x2e;
  let units = 0;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (code === undefined) {
      break;
    }
    if (code === 0x2e) {
      if (index === labelStart || units > 63) {
        return false;
      }
      if (isStrictTld(rest.slice(labelStart, index))) {
        return true;
      }
      index += 1;
      labelStart = index;
      last = 0x2e;
      units = 0;
      continue;
    }
    if (!draftDomainLabelCode(code)) {
      break;
    }
    units += 1;
    if (units > 63) {
      return false;
    }
    if (
      index > labelStart &&
      draftWordBoundary(last, code) &&
      isStrictTld(rest.slice(labelStart, index))
    ) {
      return true;
    }
    last = code;
    index += String.fromCodePoint(code).length;
  }
  return units > 0 && units <= 63 && isStrictTld(rest.slice(labelStart, index));
}

function draftDomainLabelCode(code: number): boolean {
  if (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d
  ) {
    return true;
  }
  return (
    code > 0x7f &&
    code !== 0x3002 &&
    !DRAFT_DOT_LOOKALIKE.has(code) &&
    draftLabelCode(code)
  );
}

function draftWordBoundary(prev: number, next: number): boolean {
  return draftAsciiWord(prev) !== draftAsciiWord(next);
}

function draftAsciiWord(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

/** 句号或点状间隔号后面是含标签字的域名时，收成一个点并写成 ASCII。 */
function unicodeJoinRewrite(
  rest: string,
): { replacement: string; length: number } | null {
  const first = rest.codePointAt(0);
  let run = 0;
  if (
    first !== undefined &&
    first !== 0x3002 &&
    !DRAFT_DOT_LOOKALIKE.has(first)
  ) {
    run = labelRunLength(rest);
  }
  let index = run;
  const stopStart = index;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (
      code === undefined ||
      (code !== 0x3002 && !DRAFT_DOT_LOOKALIKE.has(code))
    ) {
      break;
    }
    index += String.fromCodePoint(code).length;
  }
  if (index === stopStart) {
    return null;
  }
  const tail = rest.slice(index);
  if (!hasDraftNonAscii(tail) || !joinUnicodeDomain(tail)) {
    return null;
  }
  const head = /^[^/?#\s]+/.exec(tail)?.[0] ?? "";
  const encoded = head
    .split(".")
    .map((label) =>
      label.length === 0 || !hasDraftNonAscii(label)
        ? label
        : punycodeLabel(label),
    )
    .join(".");
  return {
    replacement: `${run > 0 ? "x." : "."}${encoded}`,
    length: index + head.length,
  };
}

/** 间隔号后面的域名含 Android 标签字，而且中间还有一个点。单独的顶级域不算。 */
function joinUnicodeDomain(rest: string): boolean {
  if (!rest.includes(".")) {
    return false;
  }
  let index = 0;
  let labelStart = 0;
  let last = 0;
  let sawDot = false;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (code === undefined) {
      break;
    }
    if (code === 0x2e) {
      if (index === labelStart) {
        return false;
      }
      if (sawDot && isStrictTld(rest.slice(labelStart, index))) {
        return true;
      }
      sawDot = true;
      index += 1;
      labelStart = index;
      last = 0x2e;
      continue;
    }
    if (!draftDomainLabelCode(code)) {
      break;
    }
    if (
      sawDot &&
      index > labelStart &&
      draftWordBoundary(last, code) &&
      isStrictTld(rest.slice(labelStart, index))
    ) {
      return true;
    }
    last = code;
    index += String.fromCodePoint(code).length;
  }
  return sawDot && isStrictTld(rest.slice(labelStart, index));
}

/** 一段句号或点状间隔号后面是 ASCII 域名时留下。否则在这里结束主机名。 */
function joiningDotSkip(rest: string): number {
  let index = 0;
  while (index < rest.length) {
    const code = rest.codePointAt(index);
    if (
      code === undefined ||
      (code !== 0x3002 && !DRAFT_DOT_LOOKALIKE.has(code))
    ) {
      break;
    }
    index += String.fromCodePoint(code).length;
  }
  if (index === 0 || draftDomainContinues(rest.slice(index))) {
    return 0;
  }
  return index;
}

/** 写完的主机名后面紧挨协议时，映射字母不另开后面的网址。 */
function gluedMappedScheme(rest: string): number {
  const code = rest.codePointAt(0);
  if (code === undefined || !draftMappedTail(code)) {
    return 0;
  }
  const size = String.fromCodePoint(code).length;
  return schemeAt(rest, size) > 0 ? size : 0;
}

function draftDomainContinues(rest: string): boolean {
  return /^[A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}(?![A-Za-z0-9-])/.test(
    rest,
  );
}

function draftMappedTail(code: number): boolean {
  if (code <= 0x7f) {
    return false;
  }
  const sample = `b${String.fromCodePoint(code)}t`;
  return (
    foldMappedLatin(sample) !== sample ||
    foldCyrillicLookalikes(sample) !== sample ||
    foldFullwidthLatin(sample) !== sample
  );
}

/** 没有协议时，连字符后面的文字字母不留在标签里。 */
function bareHyphenScriptSkip(rest: string): number {
  const hyphen = draftHyphenRunEnd(rest, 0);
  if (hyphen === 0) {
    return 0;
  }
  const runEnd = draftScriptRunEnd(rest, hyphen);
  return runEnd > hyphen ? runEnd : 0;
}

function bareLetterSkip(rest: string): number {
  let index = 0;
  while (rest.charAt(index) === "_") {
    index += 1;
  }
  const code = rest.codePointAt(index);
  if (code === undefined || code <= 0x7f || boundaryMark(code)) {
    return 0;
  }
  const after = rest.slice(index + String.fromCodePoint(code).length);
  if (schemeAt(after, 0) > 0) {
    if (draftMappedTail(code)) {
      return 0;
    }
    return rest.length - after.length;
  }
  if (!after.startsWith("/") && !after.startsWith("?")) {
    return 0;
  }
  const body = after.slice(1);
  if (
    schemeAt(body, 0) > 0 ||
    strictBareEnd(body, 0) !== null ||
    bareIpAt(body)
  ) {
    return rest.length - body.length;
  }
  return 0;
}

function schemeAfterHostRun(authority: string): number | null {
  if (!/[A-Za-z0-9.-]/.test(authority.charAt(0))) {
    return null;
  }
  for (let index = 1; index < authority.length; index += 1) {
    if (schemeAt(authority, index) > 0) {
      return index;
    }
    if (!/[A-Za-z0-9.-]/.test(authority.charAt(index))) {
      return null;
    }
  }
  return null;
}

/** 停住的字符改成空格，后面的网址另算一条。紧挨着协议的 `%` 也停住。`%2http` 仍粘住。 */
function openDraftStops(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    if (isPathPair(text, index)) {
      out += text.charAt(index) + text.charAt(index + 1);
      index += 1;
      continue;
    }
    const current = text.charAt(index);
    if (keepLookalikeNewline(text, index)) {
      out += current;
      continue;
    }
    if (DRAFT_STOP_CHAR.test(current) || isSchemePercent(text, index)) {
      out += " ";
      continue;
    }
    out += current;
  }
  return out;
}

/** 点状字符旁边的换行仍交给粘连扫描吃掉，短链才接得上。 */
function keepLookalikeNewline(text: string, index: number): boolean {
  if (text.charAt(index) !== "\n" || schemeAt(text, index + 1) > 0) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(text.charAt(index + 1))) {
    return false;
  }
  if (index > 0 && DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(index - 1))) {
    return true;
  }
  let cursor = index - 1;
  if (cursor < 0 || !/[A-Za-z0-9]/.test(text.charAt(cursor))) {
    return false;
  }
  while (cursor >= 0 && /[A-Za-z0-9_-]/.test(text.charAt(cursor))) {
    cursor -= 1;
  }
  return cursor >= 0 && DRAFT_DOT_LOOKALIKE.has(text.charCodeAt(cursor));
}

function isSchemePercent(text: string, index: number): boolean {
  if (text.charAt(index) !== "%") {
    return false;
  }
  const next = text.slice(index + 1, index + 9).toLowerCase();
  return (
    next.startsWith("http://") ||
    next.startsWith("https://") ||
    next.startsWith("tg://")
  );
}

/** Android 路径类留住的增补字符。高位代理和低位代理成对出现。 */
function isPathPair(text: string, index: number): boolean {
  const high = text.charCodeAt(index);
  const low = text.charCodeAt(index + 1);
  if (!Number.isInteger(low) || low < 0xdc00 || low > 0xdffd) {
    return false;
  }
  return (
    (high >= 0xd840 && high <= 0xd87f) ||
    (high >= 0xd880 && high <= 0xd8ff) ||
    (high >= 0xd900 && high <= 0xdb3f) ||
    (high >= 0xdb44 && high <= 0xdb7f)
  );
}

function sideUrls(message: Record<string, unknown>): string[] {
  const urls: string[] = [];
  pushContactUrls(message, urls);
  const poll = message.poll;
  if (isRecord(poll)) {
    pushPlainUrls(poll.question, urls);
    if (Array.isArray(poll.options)) {
      for (const option of poll.options) {
        if (!isRecord(option)) {
          continue;
        }
        pushPlainUrls(option.text, urls);
        pushTextLinks(option.text_entities, urls);
        pushPollAdderUrls(option, urls);
      }
    }
    pushPlainUrls(poll.explanation, urls);
    pushTextLinks(poll.explanation_entities, urls);
    pushPlainUrls(poll.description, urls);
    pushTextLinks(poll.description_entities, urls);
    pushPollMedia(poll.media, urls);
    pushPollMedia(poll.explanation_media, urls);
    if (Array.isArray(poll.options)) {
      for (const option of poll.options) {
        if (!isRecord(option)) {
          continue;
        }
        pushPollMedia(option.media, urls);
      }
    }
  }
  for (const field of ["giveaway", "giveaway_winners"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.prize_description, urls);
    if (field === "giveaway" && Array.isArray(value.chats)) {
      for (const chat of value.chats) {
        if (isRecord(chat)) {
          pushPlainUrls(chat.title, urls);
        }
      }
    }
    if (field === "giveaway_winners" && isRecord(value.chat)) {
      pushPlainUrls(value.chat.title, urls);
    }
    if (field === "giveaway_winners" && Array.isArray(value.winners)) {
      for (const winner of value.winners) {
        pushVisiblePartyUrls(winner, undefined, urls);
      }
    }
  }
  const checklist = message.checklist;
  if (isRecord(checklist)) {
    pushPlainUrls(checklist.title, urls);
    if (Array.isArray(checklist.tasks)) {
      for (const task of checklist.tasks) {
        if (!isRecord(task)) {
          continue;
        }
        pushPlainUrls(task.text, urls);
        pushTextLinks(task.text_entities, urls);
        pushTaskCompleterUrls(task, urls);
      }
    }
  }
  const game = message.game;
  if (isRecord(game)) {
    pushPlainUrls(game.title, urls);
    pushPlainUrls(game.description, urls);
    if (gameDescriptionOpen(message, game)) {
      pushOpenedSpans(game.description, urls);
    }
    pushPlainUrls(game.text, urls);
    pushTextLinks(game.text_entities, urls);
    if (isRecord(game.animation)) {
      pushPlainUrls(game.animation.file_name, urls);
    }
  }
  const invoice = message.invoice;
  if (isRecord(invoice)) {
    pushPlainUrls(invoice.title, urls);
    pushPlainUrls(invoice.description, urls);
    if (invoiceDescriptionOpen(message)) {
      pushOpenedSpans(invoice.description, urls);
    }
  }
  const venue = message.venue;
  if (isRecord(venue)) {
    pushPlainUrls(venue.title, urls);
    pushPlainUrls(venue.address, urls);
  }
  for (const field of ["animation", "video", "audio", "document"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    if (field === "audio") {
      pushPlainUrls(value.title, urls);
      pushPlainUrls(value.file_name, urls);
      pushPlainUrls(value.performer, urls);
      continue;
    }
    pushPlainUrls(value.file_name, urls);
  }
  const paid = message.paid_media;
  if (isRecord(paid) && Array.isArray(paid.paid_media)) {
    for (const item of paid.paid_media) {
      if (!isRecord(item) || !isRecord(item.video)) {
        continue;
      }
      pushPlainUrls(item.video.file_name, urls);
    }
  }
  const origin = message.forward_origin;
  if (isRecord(origin) && origin.type === "hidden_user") {
    pushPlainUrls(origin.sender_user_name, urls);
  }
  pushPlainUrls(message.forward_sender_name, urls);
  pushForwardPartyUrls(message, urls);
  pushSenderChatUrls(message, urls);
  const quote = message.quote;
  if (isRecord(quote) && quote.is_manual === true) {
    pushPlainUrls(quote.text, urls);
    pushTextLinks(quote.entities, urls);
  }
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.text, urls);
    pushTextLinks(value.entities, urls);
  }
  pushPlainUrls(uniqueGiftLabelSource(message), urls);
  pushPlainUrls(giftPublisherNames(message), urls);
  for (const field of ["forum_topic_created", "forum_topic_edited"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.name, urls);
  }
  for (const field of ["poll_option_added", "poll_option_deleted"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    pushPlainUrls(value.option_text, urls);
    pushTextLinks(value.option_text_entities, urls);
  }
  const addedTasks = message.checklist_tasks_added;
  if (isRecord(addedTasks) && Array.isArray(addedTasks.tasks)) {
    for (const task of addedTasks.tasks) {
      if (!isRecord(task)) {
        continue;
      }
      pushPlainUrls(task.text, urls);
      pushTextLinks(task.text_entities, urls);
      pushTaskCompleterUrls(task, urls);
    }
  }
  const preview = message.link_preview_options;
  if (isRecord(preview) && typeof preview.url === "string") {
    urls.push(preview.url);
  }
  pushPlainUrls(message.author_signature, urls);
  pushPlainUrls(mirrorAuthorSignature(message), urls);
  pushPlainUrls(message.sender_tag, urls);
  pushPlainUrls(businessBotDrawnName(message), urls);
  pushPaymentDrawnUrls(message, urls);
  const declined = message.suggested_post_declined;
  if (isRecord(declined)) {
    pushPlainUrls(declined.comment, urls);
  }
  pushPlainUrls(message.new_chat_title, urls);
  pushBackgroundFilename(message, urls);
  pushPlainUrls(memberNameSource(message), urls);
  pushVisiblePartyUrls(message.left_chat_member, undefined, urls);
  pushBoostSenderUrls(message, urls);
  pushAutoDeleteSenderUrls(message, urls);
  pushPriceSenderUrls(message, urls);
  pushPinSenderUrls(message, urls);
  pushCreatedGroupSenderUrls(message, urls);
  pushCallSenderUrls(message, urls);
  pushForumSenderUrls(message, urls);
  pushGiveawaySenderUrls(message, urls);
  pushPhotoSenderUrls(message, urls);
  pushTitleSenderUrls(message, urls);
  pushBackgroundSenderUrls(message, urls);
  const webApp = message.web_app_data;
  if (isRecord(webApp)) {
    pushPlainUrls(webApp.data, urls);
    pushPlainUrls(webApp.button_text, urls);
  }
  pushPlainUrls(message.connected_website, urls);
  const sharedChat = message.chat_shared;
  if (isRecord(sharedChat)) {
    pushPlainUrls(sharedChat.title, urls);
    pushPlainUrls(sharedChat.username, urls);
  }
  pushPlainUrls(sharedUserNameSource(message), urls);
  pushPlainUrls(managedBotNameSource(message), urls);
  pushPlainUrls(writeAccessNameSource(message), urls);
  for (const field of ["community_chat_added", "community_chat_joined"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    const community = value.community;
    if (isRecord(community)) {
      pushPlainUrls(community.name, urls);
    }
  }
  pushCommunitySenderUrls(message, urls);
  pushOwnerSenderUrls(message, urls);
  pushInviteSenderUrls(message, urls);
  pushProximitySenderUrls(message, urls);
  pushJoinSenderUrls(message, urls);
  pushGiftSenderUrls(message, urls);
  pushDeclineSenderUrls(message, urls);
  pushPostSenderUrls(message, urls);
  pushChecklistSenderUrls(message, urls);
  pushAddedSenderUrls(message, urls);
  pushPollSenderUrls(message, urls);
  pushTopicSenderUrls(message, urls);
  pushLeaveSenderUrls(message, urls);
  pushPlainUrls(storyPosterNames(message), urls);
  pushPlainUrls(guestBotDrawnName(message), urls);
  pushPlainUrls(guestCallerLabel(message), urls);
  pushDirectTopicUrls(message, urls);
  return urls;
}

function pushPollMedia(media: unknown, urls: string[]): void {
  if (!isRecord(media)) {
    return;
  }
  if (isRecord(media.link) && typeof media.link.url === "string") {
    urls.push(media.link.url);
  }
  for (const field of ["animation", "video", "audio", "document"]) {
    const value = media[field];
    if (!isRecord(value)) {
      continue;
    }
    if (field === "audio") {
      pushPlainUrls(value.title, urls);
      pushPlainUrls(value.file_name, urls);
      pushPlainUrls(value.performer, urls);
      continue;
    }
    pushPlainUrls(value.file_name, urls);
  }
  if (isRecord(media.venue)) {
    pushPlainUrls(media.venue.title, urls);
    pushPlainUrls(media.venue.address, urls);
  }
}

/**
 * 投票选项上画出的添加者名字只留主机名。
 * 名的长度大于 0 时不读姓。空白也算有名。用户名不读。
 * 没有用户对象时只读群标题。名字不进正文。
 */
function pushPollAdderUrls(
  option: Record<string, unknown>,
  urls: string[],
): void {
  pushVisiblePartyUrls(option.added_by_user, option.added_by_chat, urls);
}

/**
 * 清单任务上画出的完成者名字只留主机名。
 * 名的长度大于 0 时不读姓。空白也算有名。用户名不读。
 * 没有用户对象时只读群标题。名字不进正文。嵌套原清单不读。
 */
function pushTaskCompleterUrls(
  task: Record<string, unknown>,
  urls: string[],
): void {
  pushVisiblePartyUrls(task.completed_by_user, task.completed_by_chat, urls);
}

function pushVisiblePartyUrls(
  user: unknown,
  chat: unknown,
  urls: string[],
): void {
  if (isRecord(user)) {
    if (typeof user.first_name === "string" && user.first_name.length > 0) {
      pushPlainUrls(user.first_name, urls);
      return;
    }
    if (
      (user.first_name === undefined || user.first_name === "") &&
      typeof user.last_name === "string" &&
      user.last_name.length > 0
    ) {
      pushPlainUrls(user.last_name, urls);
    }
    return;
  }
  if (isRecord(chat)) {
    pushPlainUrls(chat.title, urls);
  }
}

/**
 * 客户端用全名画出的用户。名和姓都去掉两端空白。
 * 名为空时只画姓。空格不截断。用户名不读。
 */
function pushFormattedUserUrls(user: unknown, urls: string[]): void {
  if (!isRecord(user)) {
    return;
  }
  const parts: string[] = [];
  pushTrimmed(user.first_name, parts);
  pushTrimmed(user.last_name, parts);
  if (parts.length === 0) {
    return;
  }
  pushPlainUrls(parts.join(" "), urls);
}

/**
 * 已知用户和群的转发抬头只留主机名。
 * 已知用户画全名。现代来源优先。隐藏显示名旁边的真实姓名不读。
 * 成员转发的频道标题和来源签名只留主机名。群来源签名只留主机名。外部回复不读。
 */
function pushForwardPartyUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  const origin = message.forward_origin;
  if (isRecord(origin)) {
    if (origin.type === "user") {
      pushFormattedUserUrls(origin.sender_user, urls);
    } else if (origin.type === "chat") {
      pushVisiblePartyUrls(undefined, origin.sender_chat, urls);
      pushChatOriginSignature(origin.author_signature, urls);
    } else if (origin.type === "channel") {
      pushManualChannelTitle(message, origin.chat, urls);
      pushManualChannelSignature(message, origin.author_signature, urls);
    }
    return;
  }
  if (
    typeof message.forward_sender_name === "string" &&
    message.forward_sender_name.length > 0
  ) {
    return;
  }
  if (isRecord(message.forward_from)) {
    pushFormattedUserUrls(message.forward_from, urls);
    return;
  }
  const chat = message.forward_from_chat;
  if (!isRecord(chat)) {
    return;
  }
  if (chat.type === "channel") {
    pushManualChannelTitle(message, chat, urls);
    pushManualChannelSignature(message, message.forward_signature, urls);
    return;
  }
  pushVisiblePartyUrls(undefined, chat, urls);
  pushChatOriginSignature(message.forward_signature, urls);
}

/**
 * 成员转发的频道标题只留主机名。
 * 讨论组原帖不读这段标题。用户名不读。来源签名另留主机名。标题不进正文。
 */
function pushManualChannelTitle(
  message: Record<string, unknown>,
  chat: unknown,
  urls: string[],
): void {
  if (message.is_automatic_forward === true || !isRecord(chat)) {
    return;
  }
  if (typeof chat.title === "string" && chat.title.length > 0) {
    pushPlainUrls(chat.title, urls);
  }
}

/**
 * 成员转发的频道签名只留主机名。
 * 讨论组原帖不读这段签名。空白也算有签名。用户名不读。签名不进正文。
 */
function pushManualChannelSignature(
  message: Record<string, unknown>,
  signature: unknown,
  urls: string[],
): void {
  if (message.is_automatic_forward === true) {
    return;
  }
  if (typeof signature === "string" && signature.length > 0) {
    pushPlainUrls(signature, urls);
  }
}

/**
 * 群来源上画出的匿名管理员签名只留主机名。
 * 空白也算有签名。用户名和群标题在旁边另读。签名不进正文。
 */
function pushChatOriginSignature(signature: unknown, urls: string[]): void {
  if (typeof signature === "string" && signature.length > 0) {
    pushPlainUrls(signature, urls);
  }
}

/**
 * 别的聊天代发时，标题只留主机名。
 * 编号和本群相同的身份不读。用户名不读。
 * 成员转发的频道标题在来源里另读。讨论组原帖仍不读来源标题。
 */
function pushSenderChatUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  const sender = message.sender_chat;
  if (!isRecord(sender)) {
    return;
  }
  const chatId = nestedId(message.chat);
  const senderId = nestedId(sender);
  if (chatId === null || senderId === null || chatId === senderId) {
    return;
  }
  pushPlainUrls(sender.title, urls);
}

/**
 * 真实助推提示上的发送者只留主机名。
 * 次数不是正整数时不读。用户名不读。普通消息的发送者不读。
 */
function pushBoostSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!addedBoost(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 改自动删除计时的人只留主机名。
 * 秒数不是大于等于 0 的安全整数时不读。用户名不读。普通消息的发送者不读。
 */
function pushAutoDeleteSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!autoDeleteNotice(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 改价提示上的发送者只留主机名。
 * 不是真实的付费发言或私信开关时不读。星星数量和开关不读。普通消息的发送者不读。
 */
function pushPriceSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (changedPrice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 置顶提示上画出的发送者全名只留主机名。
 * 被置顶的原文不是这条服务消息。消息号不是大于 0 的安全整数时不读。
 * 用户名不读。普通消息的发送者不读。
 */
function pushPinSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!pinnedNotice(message)) {
    return;
  }
  pushFormattedUserUrls(message.from, urls);
}

/**
 * 建群提示上画出的发送者全名只留主机名。
 * 只有普通群的 group_chat_created 正好是 true 时读。
 * 超级群和频道创建不读。用户名不读。普通消息的发送者不读。
 */
function pushCreatedGroupSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!createdGroup(message)) {
    return;
  }
  pushFormattedUserUrls(message.from, urls);
}

/**
 * 视频聊天开始、结束或预约上的发送者只留主机名。
 * 空的结束或预约不读。时长和开始时间不读。只有邀请名单时不读。
 * 用户名不读。普通消息的发送者不读。
 */
function pushCallSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (callNotice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 关掉、重开、隐藏或重新显示话题的人只留主机名。
 * 这四个对象本身没有字段，空对象也读。布尔值不读。
 * 话题名、图标和话题号不读。用户名不读。普通消息的发送者不读。
 */
function pushForumSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (forumService(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 创建抽奖或私下结束上的发送者只留主机名。
 * 空的结束、负数和小数人数不读。星星数量和中奖人数不读。
 * 嵌套的抽奖原文不读。进行中的卡片不读发送者。用户名不读。
 */
function pushGiveawaySenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (scheduledGiveaway(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 换头像或删头像的人只留主机名。
 * 新头像至少有一个尺寸对象时读。删头像正好是 true 时读。
 * 空数组和 false 不读。文件号和尺寸不读。普通图片的发送者不读。
 */
function pushPhotoSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (photoNotice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 改名的人只留主机名。
 * 新群名是非空字符串时读。空字符串不读。
 * 新群名本身仍只留主机名。本群群名不读。用户名不读。
 */
function pushTitleSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!renamedChat(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 换背景的人只留主机名。
 * 壁纸、图案、纯色和内置主题都读。空对象和其它类型不读。
 * 文件名仍只在壁纸和图案上留主机名。文件号和主题名不读。用户名不读。
 */
function pushBackgroundSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (backgroundNotice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 移入、加入或移出社区的人只留主机名。
 * 移入和加入要有社区对象。移出只要是对象，空对象也读。
 * 没有社区对象的移入或加入不读。社区名字仍只在移入和加入上留主机名。
 * 社区编号和移出对象上的其它字段不读。用户名不读。
 */
function pushCommunitySenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (communityNotice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 交群或离开的人只留主机名。
 * 换人要有新群主对象。离开只要是对象，空对象也读。
 * 空的换人对象、布尔值不读。新群主的名字仍按原来的正文。
 * 用户编号不读。用户名不读。
 */
function pushOwnerSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (changedOwner(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 拉进视频聊天的人只留主机名。
 * 邀请名单里至少有一个用户对象时读。空数组、空对象和布尔值不读。
 * 被邀请的名字仍按原来的正文。用户编号不读。用户名不读。
 */
function pushInviteSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!videoInvite(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 靠近提醒上操作的人只留主机名。
 * 距离是大于等于 0 的安全整数时读。0 米也读。
 * 负数、小数、字符串、布尔值和空对象不读。
 * 两个人的名字仍按原来的正文。距离和用户编号不读。用户名不读。
 */
function pushProximitySenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!nearUsers(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 拉人进群的人画出的全名只留主机名。
 * 入群名单里至少有一个用户对象时读。空对象也读。
 * 空数组、非用户对象和布尔值不读。退群不读发送者。
 * 加入的人的名字仍按原来的正文。用户编号不读。用户名不读。
 */
function pushJoinSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (serviceNotice(message) !== "join") {
    return;
  }
  pushFormattedUserUrls(message.from, urls);
}

/**
 * 送礼的人只留主机名。
 * 普通礼物、独特礼物或升级购买里嵌套的礼物是对象时读。空的嵌套对象也读。
 * 空的外层对象、布尔值和只有附言的对象不读。
 * 附言、收藏名和发布者用户名仍按原来的方式。用户名不读。
 */
function pushGiftSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (giftNotice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 拒绝建议帖的人只留主机名。
 * `suggested_post_declined` 是对象时读。空对象也读。
 * 布尔值不读。说明仍按原来的正文。嵌套的原帖不读。用户名不读。
 */
function pushDeclineSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!declinedPost(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 通过、失败、付款或退款建议帖的人只留主机名。
 * 通过要有大于等于 0 的发表时间。失败要有价格对象，空对象也读。
 * 付款只要 `XTR` 或 `TON`。退款只要删帖或退款原因。
 * 空对象、负数、其它币种、其它原因和布尔值不读。
 * 同时出现时先认通过。嵌套的原帖不读。用户名不读。
 */
function pushPostSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (suggestedPost(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 勾完或取消勾完清单的人只留主机名。
 * 完成或取消完成的任务号全是大于 0 的安全整数时读。
 * 同时出现时先认完成。任务号不是正整数时不读。
 * 空对象、空数组、布尔值和新加的任务不读。嵌套原清单不读。用户名不读。
 */
function pushChecklistSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (taskNotice(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 新加清单任务的人只留主机名。
 * `tasks` 里至少有一条长度大于 0 的文字时读。空白也算。
 * 空字符串、空数组和布尔值不读。投票选项不读。
 * 任务文字仍按原来的正文。完成者仍按原来的主机名。
 * 嵌套原清单不读。用户名不读。
 */
function pushAddedSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!addedChecklist(message)) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 加选项或删选项的人只留主机名。
 * 选项文字长度大于 0 时读。空白也算。
 * 同时出现时先认新加。空字符串落到另一种。
 * 空对象和布尔值不读。选项文字仍按原来的正文。
 * 嵌套原投票不读。用户名不读。
 */
function pushPollSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (changedPoll(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 新建或改名话题的人只留主机名。
 * 新建的名字长度大于 0 时读。空白也算。
 * 否则改名的名字长度大于 0，或图标编号是字符串时读。
 * 同时出现时先认新建。空的新建名字落到改名。
 * 空对象和布尔值不读。话题名仍按原来的正文。
 * 图标颜色和自定义表情编号不读。用户名不读。
 */
function pushTopicSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (changedTopic(message) === undefined) {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 把人移出群的人只留主机名。
 * `left_chat_member` 是对象时读。空对象也读。
 * 布尔值不读。离开的人仍按原来的主机名，排在前面。
 * 入群仍按拉人的人。用户名和用户编号不读。
 */
function pushLeaveSenderUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (serviceNotice(message) !== "leave") {
    return;
  }
  pushVisiblePartyUrls(message.from, undefined, urls);
}

/**
 * 频道私信话题上画出的话题用户只留主机名。
 * 发言人的编号和这个用户相同才读。名的长度大于 0 时不读姓。
 * 空白也算有名。用户名、话题号和本群群名不读。
 * 发言人不是这个用户、没有话题、布尔值和空对象不读。
 * 名字不进正文。
 */
function pushDirectTopicUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  const topic = message.direct_messages_topic;
  if (!isRecord(topic) || !isRecord(topic.user)) {
    return;
  }
  const speaker = nestedId(message.from);
  const owner = nestedId(topic.user);
  if (speaker === null || speaker !== owner) {
    return;
  }
  pushVisiblePartyUrls(topic.user, undefined, urls);
}

function pushPlainUrls(value: unknown, urls: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  for (const url of urlsInText(value)) {
    urls.push(url);
  }
}

/** 壁纸和图案的文件名只留主机名。文件 id 和主题名不读。 */
function pushBackgroundFilename(
  message: Record<string, unknown>,
  urls: string[],
): void {
  const background = message.chat_background_set;
  if (!isRecord(background) || !isRecord(background.type)) {
    return;
  }
  const kind = background.type.type;
  if (kind !== "wallpaper" && kind !== "pattern") {
    return;
  }
  const document = background.type.document;
  if (!isRecord(document)) {
    return;
  }
  pushPlainUrls(document.file_name, urls);
}

function pushOpenedSpans(value: unknown, urls: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  for (const url of urlsInText(value)) {
    const span = androidUrlSpan(url);
    if (span !== null) {
      urls.push(span);
    }
  }
}

/** 正文为空时，游戏说明才画出来并按网页链接高亮。 */
function gameDescriptionOpen(
  message: Record<string, unknown>,
  game: Record<string, unknown>,
): boolean {
  if (typeof message.text === "string" && message.text.length > 0) {
    return false;
  }
  if (typeof message.caption === "string" && message.caption.length > 0) {
    return false;
  }
  return typeof game.text !== "string" || game.text.length === 0;
}

/** 账单说明会被当成正文。已有实体时客户端不再自动加链接。 */
function invoiceDescriptionOpen(message: Record<string, unknown>): boolean {
  if (Array.isArray(message.entities) && message.entities.length > 0) {
    return false;
  }
  return !(
    Array.isArray(message.caption_entities) &&
    message.caption_entities.length > 0
  );
}

/**
 * 联系人卡片上的 URL 行、可见名字和公司名只留主机名。
 * 名的长度大于 0 时不读姓。空白也算有名。
 * 姓名去掉空白后都是空的，标题就是原始电话。
 * 已有姓名且没有 vCard 时，只在电话会原样画出时才读。
 * 公司名是气泡副标题里最后一条以 ORG 开头的值。
 * 副标题里会原样画出的电话和邮箱也只留主机名。
 * 用户编号、职务和备注不读。名字和电话不进正文。
 */
function pushContactUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  const contact = message.contact;
  if (!isRecord(contact)) {
    return;
  }
  if (typeof contact.vcard === "string") {
    for (const value of vcardUrlValues(contact.vcard)) {
      urls.push(/^https?:/i.test(value) ? value : `http://${value}`);
    }
  }
  pushVisiblePartyUrls(contact, undefined, urls);
  pushPlainUrls(contactPhoneDrawn(contact), urls);
  if (typeof contact.vcard === "string") {
    for (const value of vcardDrawnContacts(contact.vcard)) {
      pushPlainUrls(value, urls);
    }
    pushPlainUrls(vcardCompany(contact.vcard), urls);
  }
}

/**
 * 气泡副标题里会原样画出的电话和邮箱。
 * 最后一张已结束的名片才算。电话含 # 或 * 时原文照画。
 * 其余电话和全部邮箱先做电话格式化，只有退回原文时才读。
 * 不解开 quoted-printable。职务、备注和小写属性不读。
 */
function vcardDrawnContacts(vcard: string): string[] {
  const raw = vcard.slice(0, 16384).split(/\r\n|\n|\r/);
  let open = false;
  let finished = false;
  let phones: string[] = [];
  let emails: string[] = [];
  let pending: string | undefined;
  for (const originalLine of raw) {
    if (originalLine.startsWith("PHOTO")) {
      continue;
    }
    if (originalLine.includes(":")) {
      if (originalLine.startsWith("BEGIN:VCARD")) {
        open = true;
        phones = [];
        emails = [];
      } else if (originalLine.startsWith("END:VCARD") && open) {
        finished = true;
      }
    }
    let line = originalLine;
    if (pending !== undefined) {
      line = pending + line;
      pending = undefined;
    }
    if (line.includes("=QUOTED-PRINTABLE") && line.endsWith("=")) {
      pending = line.slice(0, -1);
      continue;
    }
    if (!open) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const left = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (value.length === 0) {
      continue;
    }
    if (left.startsWith("TEL")) {
      phones.push(value);
    } else if (left.startsWith("EMAIL")) {
      emails.push(value);
    }
  }
  if (!finished) {
    return [];
  }
  const drawn: string[] = [];
  for (const phone of phones) {
    if (
      phone.includes("#") ||
      phone.includes("*") ||
      phoneFormatKeepsOriginal(phone)
    ) {
      drawn.push(phone);
    }
  }
  for (const email of emails) {
    if (phoneFormatKeepsOriginal(email)) {
      drawn.push(email);
    }
  }
  return drawn;
}

/**
 * 名片上会原样画出的电话。
 * 姓名去掉两端空白后都是空的，标题就是这段原文。
 * 已有姓名时，副标题先走电话格式化。去掉非电话字符后以加号开头、
 * 后面没有数字，格式化才会退回原文。旁边有 vCard 时副标题改走 vCard。
 */
function contactPhoneDrawn(
  contact: Record<string, unknown>,
): string | undefined {
  const phone = contact.phone_number;
  if (typeof phone !== "string" || phone.length === 0) {
    return undefined;
  }
  if (!trimmedName(contact.first_name) && !trimmedName(contact.last_name)) {
    return phone;
  }
  if (typeof contact.vcard === "string" && contact.vcard.trim().length > 0) {
    return undefined;
  }
  if (phoneFormatKeepsOriginal(phone)) {
    return phone;
  }
  return undefined;
}

function trimmedName(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** 只保留 0-9、+、*、#。以加号开头且后面没有数字时，客户端退回原文。 */
function phoneFormatKeepsOriginal(phone: string): boolean {
  let stripped = "";
  for (const char of phone) {
    if ("0123456789+*#".includes(char)) {
      stripped += char;
    }
  }
  if (!stripped.startsWith("+")) {
    return false;
  }
  return !/[0-9]/.test(stripped.slice(1));
}

/**
 * 气泡副标题里最后一张名片的公司名。
 * 属性名以 ORG 开头才算。后写的盖住先写的。空值也盖住。
 * 见到新的 BEGIN 就换一张名片。没有 END 时客户端不画。
 * 职务、分组行和小写 org 不读。折行不拼回公司名。
 */
function vcardCompany(vcard: string): string | undefined {
  const raw = vcard.slice(0, 16384).split(/\r\n|\n|\r/);
  let open = false;
  let finished = false;
  let company: string | undefined;
  let pending: string | undefined;
  for (const originalLine of raw) {
    if (originalLine.startsWith("PHOTO")) {
      continue;
    }
    if (originalLine.includes(":")) {
      if (originalLine.startsWith("BEGIN:VCARD")) {
        open = true;
        company = undefined;
      } else if (originalLine.startsWith("END:VCARD") && open) {
        finished = true;
      }
    }
    let line = originalLine;
    if (pending !== undefined) {
      line = pending + line;
      pending = undefined;
    }
    if (line.includes("=QUOTED-PRINTABLE") && line.endsWith("=")) {
      pending = line.slice(0, -1);
      continue;
    }
    if (!open) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const left = line.slice(0, colon);
    if (!left.startsWith("ORG")) {
      continue;
    }
    let value = line.slice(colon + 1).trim();
    if (/encoding=quoted-printable/i.test(left)) {
      value = decodeQuotedPrintable(value).trim();
    }
    company = value.replace(/;/g, " ");
  }
  if (!finished || company === undefined || company.length === 0) {
    return undefined;
  }
  return company;
}

function vcardUrlValues(vcard: string): string[] {
  const found: string[] = [];
  for (const line of vcardLines(vcard)) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const left = line.slice(0, colon);
    const name = left.split(";")[0]?.trim().toLowerCase();
    if (name !== "url") {
      continue;
    }
    let value = line.slice(colon + 1).trim();
    if (/encoding=quoted-printable/i.test(left)) {
      value = decodeQuotedPrintable(value).trim();
    }
    if (value.length === 0 || value.length > MAX_LINK) {
      continue;
    }
    found.push(value);
    if (found.length >= MAX_HOSTS) {
      break;
    }
  }
  return found;
}

function vcardLines(vcard: string): string[] {
  const raw = vcard.slice(0, 16384).split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const rawLine of raw) {
    const previous = lines[lines.length - 1];
    if (
      previous !== undefined &&
      (rawLine.startsWith(" ") || rawLine.startsWith("\t"))
    ) {
      lines[lines.length - 1] = previous + rawLine.slice(1);
      continue;
    }
    if (
      previous?.endsWith("=") &&
      /encoding=quoted-printable/i.test(previous)
    ) {
      lines[lines.length - 1] = previous.slice(0, -1) + rawLine;
      continue;
    }
    lines.push(rawLine);
  }
  return lines;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const hex = value.slice(index + 1, index + 3);
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    const code = char.charCodeAt(0);
    if (code < 128) {
      bytes.push(code);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function preLanguageUrls(entity: Record<string, unknown>): string[] {
  if (entity.type !== "pre" || typeof entity.language !== "string") {
    return [];
  }
  return urlsInText(entity.language);
}

function pushTextLinks(list: unknown, urls: string[]): void {
  if (!Array.isArray(list)) {
    return;
  }
  for (const entity of list) {
    if (!isRecord(entity)) {
      continue;
    }
    if (entity.type === "text_link" && typeof entity.url === "string") {
      urls.push(entity.url);
    }
    for (const found of preLanguageUrls(entity)) {
      urls.push(found);
    }
  }
}

function buttonUrls(message: Record<string, unknown>): unknown[] {
  const markup = message.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return [];
  }
  const urls: string[] = [];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (!isRecord(button)) {
        continue;
      }
      if (typeof button.text === "string") {
        for (const url of urlsInText(button.text)) {
          urls.push(url);
        }
      }
      if (typeof button.url === "string") {
        urls.push(button.url);
      }
      const copied = button.copy_text;
      if (isRecord(copied) && typeof copied.text === "string") {
        for (const url of urlsInText(copied.text)) {
          urls.push(url);
        }
      }
      const login = button.login_url;
      if (isRecord(login)) {
        if (typeof login.url === "string") {
          urls.push(login.url);
        }
        pushPlainUrls(login.forward_text, urls);
      }
      const app = button.web_app;
      if (isRecord(app) && typeof app.url === "string") {
        urls.push(app.url);
      }
      pushSwitchInlineQueries(button, urls);
    }
  }
  return urls;
}

function pushSwitchInlineQueries(
  button: Record<string, unknown>,
  urls: string[],
): void {
  pushOpenedQuery(button.switch_inline_query, urls);
  pushOpenedQuery(button.switch_inline_query_current_chat, urls);
  const chosen = button.switch_inline_query_chosen_chat;
  if (isRecord(chosen)) {
    pushOpenedQuery(chosen.query, urls);
  }
}

/** 查询会写进输入框。发送预览对这段文字做网页链接高亮。 */
function pushOpenedQuery(value: unknown, urls: string[]): void {
  pushPlainUrls(value, urls);
  pushOpenedSpans(value, urls);
}

/** 普通链接仍停在 2048。分享、私聊预填和 Passport 回调可以到草稿上限。 */
function withinLinkLimit(value: string): boolean {
  if (value.length <= MAX_LINK) {
    return true;
  }
  if (value.length > OPENED_DRAFT) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(/^(?:https?:|tg:)/i.test(value) ? value : `http://${value}`);
  } catch {
    return false;
  }
  return (
    isTelegramShare(url) || isTelegramMsg(url) || isTelegramPassport(value, url)
  );
}

function hostFromUrl(
  value: unknown,
  unwrap = true,
): {
  host: string;
  invite: boolean;
  extras?: { host: string; invite: boolean }[];
} | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !withinLinkLimit(value)
  ) {
    return null;
  }
  const folded = foldBracketDots(
    foldEncodedAlphabet(
      foldEncodedSeparators(
        foldMatchText(
          foldDotLookalikes(
            foldEncodedMiddleDot(
              foldHostInterrupters(
                foldMappedLatin(
                  foldFullwidthLatin(
                    foldCyrillicLookalikes(foldEncodedGaps(value)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  let url: URL;
  try {
    url = new URL(folded);
  } catch {
    return null;
  }
  const deep = telegramDeepInvite(url);
  if (deep) {
    return deep;
  }
  const proxy = proxyServerHost(url);
  const wrapped = unwrap
    ? [
        ...wrappedExtras(folded, url, value),
        ...msgTextExtras(folded, url, value),
        ...usernameDraftExtras(folded, url, value),
        ...passportExtras(folded, url, value),
      ]
    : [];
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    if (proxy !== null) {
      return packHost(proxy, false, wrapped);
    }
    const first = wrapped[0];
    if (!first) {
      return null;
    }
    return packHost(first.host, first.invite, wrapped.slice(1));
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes(":") ||
    host.includes("..") ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    if (proxy !== null) {
      return packHost(proxy, false, wrapped);
    }
    const first = wrapped[0];
    if (!first) {
      return null;
    }
    return packHost(first.host, first.invite, wrapped.slice(1));
  }
  const rawPath = url.pathname || "/";
  const path = rawPath.replace(/\/+$/, "") || "/";
  return packHost(
    host,
    isTelegramInvite(host, path) ||
      isBusinessChatLink(host, rawPath) ||
      isPercentSpaceInvite(folded, host),
    [
      ...(proxy !== null && proxy !== host
        ? [{ host: proxy, invite: false }]
        : []),
      ...wrapped,
    ],
  );
}

function packHost(
  host: string,
  invite: boolean,
  extras: { host: string; invite: boolean }[],
): {
  host: string;
  invite: boolean;
  extras?: { host: string; invite: boolean }[];
} {
  const useful = extras.filter(
    (item) => item.host !== host || (item.invite && !invite),
  );
  return useful.length > 0
    ? { host, invite, extras: useful }
    : { host, invite };
}

function wrappedExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  if (!isTelegramShare(url)) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  const embedded = openedDraft(queryValue(source, "url"));
  if (embedded !== null) {
    for (const raw of queryUrls(embedded)) {
      pushClosedUrl(raw, found);
    }
  }
  const text = openedDraft(queryValue(source, "text"));
  if (text !== null) {
    for (const raw of openedDraftUrls(text)) {
      pushDraftUrl(raw, found, false);
    }
  }
  return found;
}

function msgTextExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  if (!isTelegramMsg(url)) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  const embedded = openedDraft(queryValue(source, "url"));
  if (embedded !== null) {
    for (const raw of queryUrls(embedded)) {
      pushClosedUrl(raw, found);
    }
  }
  const text = openedDraft(queryValue(source, "text"));
  if (text === null) {
    return found;
  }
  for (const raw of openedDraftUrls(text)) {
    pushDraftUrl(raw, found, true);
  }
  return found;
}

function passportExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  const callback = passportCallback(folded, url, source);
  if (callback === null) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  for (const raw of queryUrls(callback)) {
    pushClosedUrl(raw, found);
  }
  return found;
}

/** 桌面端取消 Passport 时打开 `callback_url`。只留主机名。 */
function passportCallback(raw: string, url: URL, source = raw): string | null {
  if (!isTelegramPassport(raw, url)) {
    return null;
  }
  return openedDraft(queryValue(source, "callback_url"));
}

function isTelegramPassport(raw: string, url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    if (command === "passport") {
      return host.length === 0 || path.length === 0;
    }
    if (command !== "resolve") {
      return false;
    }
    return searchParam(url, "domain") === "telegrampassport";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  if (isPassportSubdomain(raw, url)) {
    return true;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isExactDraftHost(host)) {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  return isPassportPath(parts);
}

function isPassportSubdomain(raw: string, url: URL): boolean {
  const shown = /^(?:https?:\/\/)?([^/?#]+)/i.exec(raw)?.[1];
  if (shown === undefined || shown.includes(":") || shown.includes("@")) {
    return false;
  }
  const suffix = ".t.me";
  if (!shown.toLowerCase().endsWith(suffix)) {
    return false;
  }
  const label = shown.slice(0, shown.length - suffix.length);
  if (label !== "telegrampassport") {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length === 0) {
    return true;
  }
  const only = parts[0];
  return parts.length === 1 && only !== undefined && /^\d+$/.test(only);
}

function isPassportPath(parts: readonly string[]): boolean {
  if (parts[0] !== "telegrampassport") {
    return false;
  }
  if (parts.length === 1) {
    return true;
  }
  if (parts.length === 2) {
    return /^[A-Za-z0-9._-]+$/.test(parts[1] ?? "");
  }
  if (parts.length === 3) {
    const mid = (parts[1] ?? "").toLowerCase();
    const last = (parts[2] ?? "").toLowerCase();
    if (mid === "s" && (/^\d+$/.test(last) || last === "live")) {
      return true;
    }
    if ((mid === "a" || mid === "c") && /^\d+$/.test(last)) {
      return true;
    }
    return /^\d+$/.test(parts[1] ?? "") && /^\d+$/.test(parts[2] ?? "");
  }
  return false;
}

function usernameDraftExtras(
  folded: string,
  url: URL,
  source = folded,
): { host: string; invite: boolean }[] {
  if (!isUsernameDraft(url)) {
    return [];
  }
  const text = queryValue(source, "text");
  if (text === null || text.length === 0 || text.length > MAX_TEXT) {
    return [];
  }
  const found: { host: string; invite: boolean }[] = [];
  for (const raw of openedDraftUrls(text)) {
    pushDraftUrl(raw, found, true);
  }
  return found;
}

const DRAFT_URL_GAP = new RegExp(
  `[ \\t\\n\\r${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}\u00A0\u2000-\u200A\u2028\u2029\u202F\u3000]+`,
);

function queryUrls(value: string): string[] {
  return value.split(DRAFT_URL_GAP).filter((part) => part.length > 0);
}

function closedIpUrl(raw: string): string {
  if (!new RegExp(`^(?:${DRAFT_IP})${DRAFT_IP_TAIL}$`, "i").test(raw)) {
    return "";
  }
  return `http://${raw}`;
}

function closedBareUrl(raw: string): string {
  if (!new RegExp(`^${DRAFT_BARE}$`, "i").test(raw)) {
    return "";
  }
  return `http://${raw}`;
}

function pushClosedUrl(
  raw: string,
  found: { host: string; invite: boolean }[],
): void {
  const opened = openPathQuote(
    openPlainTg(
      openBareEnd(
        openSchemeLetter(
          openLookalikeHost(
            openLongLabel(
              openLongUserinfo(
                openStoppingSpace(
                  openFinishedEncodedDot(foldBoundaryMark(raw)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  if (opened !== raw) {
    for (const part of queryUrls(opened)) {
      pushClosedUrl(part, found);
    }
    return;
  }
  const inner =
    hostFromUrl(raw, false) ??
    hostFromUrl(closedIpUrl(raw), false) ??
    hostFromUrl(closedBareUrl(raw), false);
  if (inner) {
    found.push({ host: inner.host, invite: inner.invite });
    for (const extra of inner.extras ?? []) {
      found.push(extra);
    }
  }
  const span = androidUrlSpan(raw);
  if (span === null) {
    return;
  }
  const shortened = hostFromUrl(span, false);
  if (!shortened) {
    return;
  }
  found.push({ host: shortened.host, invite: shortened.invite });
  for (const extra of shortened.extras ?? []) {
    found.push(extra);
  }
}

function pushDraftUrl(
  raw: string,
  found: { host: string; invite: boolean }[],
  nested: boolean,
): void {
  appendParsed(hostFromUrl(raw, false), found, nested);
  const span = androidUrlSpan(raw);
  if (span === null) {
    return;
  }
  appendParsed(hostFromUrl(span, false), found, nested);
}

function appendParsed(
  link: {
    host: string;
    invite: boolean;
    extras?: { host: string; invite: boolean }[];
  } | null,
  found: { host: string; invite: boolean }[],
  nested: boolean,
): void {
  if (!link) {
    return;
  }
  found.push({ host: link.host, invite: link.invite });
  if (!nested) {
    return;
  }
  for (const extra of link.extras ?? []) {
    found.push(extra);
  }
}

function isUsernameDraft(url: URL): boolean {
  if (profileReplacesDraft(url) || resolveMediaReplacesDraft(url)) {
    return false;
  }
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    if (command !== "resolve") {
      return false;
    }
    const domain = searchParam(url, "domain");
    if (domain !== null && domain.length > 0) {
      if (domain === "s") {
        const appname = searchParam(url, "appname");
        return appname !== null && isPublicUsername(appname);
      }
      return isPublicUsername(domain);
    }
    const phone = searchParam(url, "phone");
    return phone !== null && /^\+?\d{1,20}$/.test(phone);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !telegramProxyHosts.some(
      (name) => name === host || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (isGroupCallPath(host, url.pathname)) {
    return false;
  }
  if (host === "call.t.me" && parts.length > 0) {
    return false;
  }
  if (aiStyleReplacesDraft(host, parts)) {
    return false;
  }
  if (invoiceReplacesDraft(host, parts)) {
    return false;
  }
  if (emojiSetReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (stickerSetReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (themeSlugReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (languagePackReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (giftSlugReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (auctionSlugReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (wallPaperReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (contactTokenReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (newBotReplacesDraft(host, parts)) {
    return false;
  }
  if (boostReplacesDraft(host, url, parts)) {
    return false;
  }
  if (folderInviteDropsDraft(host, parts)) {
    return false;
  }
  if (addListReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (joinChatReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (businessChatReplacesDraft(host, url.pathname, parts)) {
    return false;
  }
  if (privatePostDropsDraft(host, parts)) {
    return false;
  }
  if (confirmPhoneDropsDraft(host, parts)) {
    return false;
  }
  if (isUserSubdomain(host) && isUserSubdomainPath(parts)) {
    return true;
  }
  const first = parts[0];
  if (parts.length === 1 && first !== undefined && isExactDraftHost(host)) {
    return isPublicUsername(first) || isTelegramPhoneSegment(host, first);
  }
  const preview = parts[0]?.toLowerCase();
  const name = parts[1];
  if (
    parts.length === 2 &&
    preview === "s" &&
    name !== undefined &&
    isPublicUsername(name)
  ) {
    return true;
  }
  if (host === "s.t.me" && parts.length === 1) {
    const label = parts[0];
    return label !== undefined && isPublicUsername(label);
  }
  if (isAndroidStrippedDraft(host, parts)) {
    return true;
  }
  if (isAppNamePath(host, parts)) {
    return true;
  }
  return isUserPostPath(host, parts);
}

/** Android 先拿掉路径开头的 `s`，剩下的用户名加一段仍会写草稿。 */
function isAndroidStrippedDraft(
  host: string,
  parts: readonly string[],
): boolean {
  const rest = androidDraftRest(host, parts);
  if (rest === null) {
    return false;
  }
  return isAppNamePath("t.me", rest) || isUserPostPath("t.me", rest);
}

function androidDraftRest(
  host: string,
  parts: readonly string[],
): readonly string[] | null {
  if (host === "s.t.me" && parts.length === 2) {
    return parts;
  }
  if (
    (host === "t.me" || host === "telegram.me" || host === "telegram.dog") &&
    parts.length === 3 &&
    parts[0] === "s"
  ) {
    return parts.slice(1);
  }
  return null;
}

/** 查询名正好是 `profile` 且值不是 `0` 或 `false` 时打开资料页。会改掉资料页的参数仍写草稿。 */
function profileReplacesDraft(url: URL): boolean {
  return androidOpensProfile(url) && !desktopOverridesProfile(url);
}

/** `tg://resolve` 上的非零动态、相册或礼物收集打开媒体，不写草稿。网页上的同名查询仍写。 */
function resolveMediaReplacesDraft(url: URL): boolean {
  if (url.protocol !== "tg:") {
    return false;
  }
  return (
    nonzeroClientInt(firstExactParam(url, "story")) ||
    nonzeroClientInt(firstExactParam(url, "album")) ||
    nonzeroClientInt(firstExactParam(url, "collection"))
  );
}

function firstExactParam(url: URL, name: string): string | null {
  for (const [key, value] of url.searchParams) {
    if (key === name) {
      return value;
    }
  }
  return null;
}

function nonzeroClientInt(value: string | null): boolean {
  if (value === null || !/^-?\d+$/.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return (
    Number.isInteger(parsed) &&
    parsed !== 0 &&
    parsed >= -2147483648 &&
    parsed <= 2147483647
  );
}

function androidOpensProfile(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (key !== "profile") {
      continue;
    }
    const flag = value.toLowerCase();
    return flag !== "false" && flag !== "0";
  }
  return false;
}

function desktopOverridesProfile(url: URL): boolean {
  const start = searchParam(url, "start");
  if (start !== null && start.length > 0) {
    return true;
  }
  if (
    searchParam(url, "startgroup") !== null ||
    searchParam(url, "startchannel") !== null ||
    searchParam(url, "direct") !== null
  ) {
    return true;
  }
  const boost = searchParam(url, "boost");
  if (boost !== null && boost.length > 0) {
    return true;
  }
  const game = searchParam(url, "game");
  if (game !== null && game.length > 0 && /^[A-Za-z0-9._]+$/.test(game)) {
    return true;
  }
  const domain = searchParam(url, "domain");
  const appname = searchParam(url, "appname");
  if (appname !== null && appname.length > 0 && domain?.toLowerCase() !== "s") {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  return isAppNamePath(host, parts);
}

/** 第二段是文风短码。没有这段时 `addstyle` 仍是用户名。 */
function aiStyleReplacesDraft(host: string, parts: readonly string[]): boolean {
  if (host === "addstyle.t.me") {
    return parts.length > 0;
  }
  if (!isExactDraftHost(host)) {
    return false;
  }
  return parts[0]?.toLowerCase() === "addstyle" && parts.length >= 2;
}

/** 第二段是账单短码。字符集之外时桌面端仍按应用名写草稿。没有这段时 `invoice` 仍是用户名。 */
function invoiceReplacesDraft(host: string, parts: readonly string[]): boolean {
  if (host === "invoice.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9_-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host)) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0]?.toLowerCase() === "invoice" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9_-]+$/.test(slug)
  );
}

/** 第二段是表情包短名。连字符、末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `addemoji` 仍是用户名。 */
function emojiSetReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "addemoji.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "addemoji" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._]+$/.test(slug)
  );
}

/** 第二段是贴纸包短名。连字符、末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `addstickers` 仍是用户名。 */
function stickerSetReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "addstickers.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "addstickers" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._]+$/.test(slug)
  );
}

/** 第二段是主题短名。连字符、末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `addtheme` 仍是用户名。 */
function themeSlugReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "addtheme.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "addtheme" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._]+$/.test(slug)
  );
}

/** 第二段是语言包短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `setlanguage` 仍是用户名。 */
function languagePackReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "setlanguage.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "setlanguage" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

/** 第二段是礼物短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `nft` 仍是用户名。 */
function giftSlugReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "nft.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "nft" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

/** 第二段是拍卖短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `auction` 仍是用户名。 */
function auctionSlugReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "auction.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "auction" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._-]+$/.test(slug)
  );
}

/** 第二段是壁纸短名。末尾斜杠或命令大小写不同时仍写草稿。没有这段时 `bg` 仍是用户名。 */
function wallPaperReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "bg.t.me") {
    return parts.length === 1 && /^[A-Za-z0-9._~-]+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || pathname.endsWith("/")) {
    return false;
  }
  const slug = parts[1];
  return (
    parts[0] === "bg" &&
    parts.length === 2 &&
    slug !== undefined &&
    /^[A-Za-z0-9._~-]+$/.test(slug)
  );
}

/** 路径里带了联系人令牌。命令大小写不同时仍写草稿。没有这段时 `contact` 仍是用户名。 */
function contactTokenReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  if (host === "contact.t.me") {
    return parts.length > 0;
  }
  if (!isExactDraftHost(host) || parts[0] !== "contact") {
    return false;
  }
  return parts.length > 1 || pathname.endsWith("/");
}

/** 后面一段是机器人管理员用户名。连字符仍写草稿。没有这段时 `newbot` 仍是用户名。 */
function newBotReplacesDraft(host: string, parts: readonly string[]): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._]+$/.test(value);
  if (host === "newbot.t.me") {
    return (
      parts.length >= 1 &&
      parts.length <= 2 &&
      parts.every((part) => slug(part))
    );
  }
  if (!isExactDraftHost(host) || parts[0]?.toLowerCase() !== "newbot") {
    return false;
  }
  if (parts.length < 2 || parts.length > 3) {
    return false;
  }
  return parts.slice(1).every((part) => slug(part));
}

/** 小写 `boost` 后面是频道用户名时打开助推。连字符和没有这段时仍写草稿。 */
function boostReplacesDraft(
  host: string,
  url: URL,
  parts: readonly string[],
): boolean {
  const channel = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._]+$/.test(value);
  if (host === "boost.t.me") {
    return parts.length === 1 && /^\d+$/.test(parts[0] ?? "");
  }
  if (!isExactDraftHost(host) || parts[0] !== "boost") {
    return false;
  }
  if (searchParam(url, "c") !== null) {
    return true;
  }
  return parts.length === 2 && channel(parts[1]);
}

/** 小写 `folder` 后面是邀请码时打开文件夹。带点的短名和没有这段时仍写草稿。 */
function folderInviteDropsDraft(
  host: string,
  parts: readonly string[],
): boolean {
  const code = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (host === "folder.t.me") {
    return parts.length === 1 && code(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "folder") {
    return false;
  }
  return parts.length === 2 && code(parts[1]);
}

/** 小写 `addlist` 后面没有末尾斜杠时打开聊天列表。末尾斜杠和大写命令仍写草稿。 */
function addListReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  if (host === "addlist.t.me") {
    return parts.length === 1 && slug(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "addlist") {
    return false;
  }
  return parts.length === 2 && slug(parts[1]) && !pathname.endsWith("/");
}

/** 小写 `joinchat` 后面没有末尾斜杠时打开邀请。末尾斜杠和大写命令仍写草稿。 */
function joinChatReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  if (host === "joinchat.t.me") {
    return parts.length === 1 && slug(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "joinchat") {
    return false;
  }
  return parts.length === 2 && slug(parts[1]) && !pathname.endsWith("/");
}

/** 小写 `m` 后面没有末尾斜杠时打开业务聊天。末尾斜杠和大写命令仍写草稿。 */
function businessChatReplacesDraft(
  host: string,
  pathname: string,
  parts: readonly string[],
): boolean {
  const slug = (value: string | undefined) =>
    value !== undefined && /^[A-Za-z0-9._-]+$/.test(value);
  if (host === "m.t.me") {
    return parts.length === 1 && slug(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "m") {
    return false;
  }
  return parts.length === 2 && slug(parts[1]) && !pathname.endsWith("/");
}

/** 小写 `c` 后面是频道数字时打开私密帖。其它短名和大写命令仍写草稿。 */
function privatePostDropsDraft(
  host: string,
  parts: readonly string[],
): boolean {
  const channel = (value: string | undefined) =>
    value !== undefined && /^-?\d+$/.test(value);
  if (host === "c.t.me") {
    return parts.length === 1 && channel(parts[0]);
  }
  if (!isExactDraftHost(host) || parts[0] !== "c") {
    return false;
  }
  return parts.length === 2 && channel(parts[1]);
}

/** 小写 `confirmphone` 没有下一段时确认电话。后面的短名和大写命令仍写草稿。 */
function confirmPhoneDropsDraft(
  host: string,
  parts: readonly string[],
): boolean {
  if (host === "confirmphone.t.me") {
    return parts.length === 0;
  }
  if (!isExactDraftHost(host) || parts[0] !== "confirmphone") {
    return false;
  }
  return parts.length === 1;
}

/** 小写 `call/` 打开群通话，不把 `text` 写进输入框。`call.t.me/后面` 先收成同一条。 */
function isGroupCallPath(host: string, pathname: string): boolean {
  return isExactDraftHost(host) && pathname.startsWith("/call/");
}

function isExactDraftHost(host: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return bare === "t.me" || bare === "telegram.me" || bare === "telegram.dog";
}

function isUserSubdomain(host: string): boolean {
  if (!host.endsWith(".t.me")) {
    return false;
  }
  const name = host.slice(0, -".t.me".length);
  return (
    name !== "www" &&
    !name.includes(".") &&
    name.length >= 2 &&
    isPublicUsername(name)
  );
}

function isUserSubdomainPath(parts: readonly string[]): boolean {
  if (parts.length === 0) {
    return true;
  }
  const only = parts[0];
  return parts.length === 1 && only !== undefined && /^\d+$/.test(only);
}

/** 桌面端把用户名后的一段收成 appname。对方不是 bot 时仍写入草稿。 */
function isAppNamePath(host: string, parts: readonly string[]): boolean {
  if (!isExactDraftHost(host) || parts.length !== 2) {
    return false;
  }
  const name = parts[0];
  const app = parts[1];
  return (
    name !== undefined &&
    app !== undefined &&
    isPublicUsername(name) &&
    /^[A-Za-z0-9._-]+$/.test(app) &&
    !/^\d+$/.test(app)
  );
}

function isUserPostPath(host: string, parts: readonly string[]): boolean {
  if (!isExactDraftHost(host) || parts.length !== 2) {
    return false;
  }
  const name = parts[0];
  const post = parts[1];
  return (
    name !== undefined &&
    post !== undefined &&
    isPublicUsername(name) &&
    /^\d+$/.test(post)
  );
}

function isTelegramPhoneSegment(host: string, segment: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  return /^\+\d{1,128}$/.test(segment);
}

/** 小写 `s` 是预览路径。大写 `S` 仍按用户名写草稿。 */
function isPublicUsername(value: string): boolean {
  return (
    /^[A-Za-z0-9_]{1,32}$/.test(value) &&
    value !== "s" &&
    !reservedUsernames.has(value.toLowerCase())
  );
}

const reservedUsernames = new Set(["getpremium", "telegrampassport"]);

function isTelegramMsg(url: URL): boolean {
  if (url.protocol !== "tg:") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const command = host.length > 0 ? host : path;
  return command === "msg";
}

/** 查询名不区分大小写，取第一次出现的值。`+` 是空格。 */
function searchParam(url: URL, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return null;
}

/** Android 把分享草稿截到 4096 × 4。再往后的字不再打开。 */
const OPENED_DRAFT = 4096 * 4;

function openedDraft(value: string | null): string | null {
  if (value === null || value.length === 0) {
    return null;
  }
  return value.length > OPENED_DRAFT ? value.slice(0, OPENED_DRAFT) : value;
}

/** 查询里的 `+` 是空格。不完整的 `%` 留下。非法 UTF-8 换成替换字符。`%2B` 仍是加号。 */
function queryValue(raw: string, name: string): string | null {
  const match = new RegExp(`[?&]${name}=([^&#]*)`, "i").exec(raw);
  const value = match?.[1];
  if (value === undefined || value.length === 0) {
    return null;
  }
  return formDecode(value);
}

function formDecode(value: string): string {
  const source = value.replace(/\+/g, " ");
  const bytes: number[] = [];
  let out = "";
  const flush = (): void => {
    if (bytes.length === 0) {
      return;
    }
    out += new TextDecoder().decode(Uint8Array.from(bytes));
    bytes.length = 0;
  };
  for (let index = 0; index < source.length; index += 1) {
    const current = source.charAt(index);
    const hex = source.slice(index + 1, index + 3);
    if (current === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    flush();
    out += current;
  }
  flush();
  return out;
}

function isTelegramShare(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    return command === "msg_url" || command === "share" || command === "iv";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !telegramProxyHosts.some(
      (name) => name === host || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  return (
    path === "/share/url" ||
    path === "/share" ||
    path === "/iv" ||
    path === "/msg/url" ||
    (host === "share.t.me" && path === "/url") ||
    (host === "msg.t.me" && path === "/url")
  );
}

const telegramProxyHosts = ["t.me", "telegram.me", "telegram.dog"];

function proxyServerHost(url: URL): string | null {
  if (!isTelegramProxy(url)) {
    return null;
  }
  const server = proxyAddress(url);
  if (server === null || server.length === 0 || server.length > MAX_LINK) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(
      /^(?:https?:)?\/\//i.test(server) ? server : `http://${server}`,
    );
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes(":") ||
    host.includes("..") ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    return null;
  }
  return host;
}

function proxyAddress(url: URL): string | null {
  const server = searchParam(url, "server");
  if (server === null || (server.length === 0 && isWebProxy(url))) {
    return searchParam(url, "host");
  }
  return server;
}

function isWebProxy(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    return command === "webproxy";
  }
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  return path === "/webproxy";
}

function isTelegramProxy(url: URL): boolean {
  if (url.protocol === "tg:") {
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    const command = host.length > 0 ? host : path;
    return command === "proxy" || command === "socks" || command === "webproxy";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !telegramProxyHosts.some(
      (name) => host === name || host.endsWith(`.${name}`),
    )
  ) {
    return false;
  }
  const path = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  return path === "/proxy" || path === "/socks" || path === "/webproxy";
}

function telegramDeepInvite(
  url: URL,
): { host: string; invite: boolean } | null {
  if (url.protocol !== "tg:") {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
  const command = host.length > 0 ? host : path;
  const code =
    command === "join"
      ? searchParam(url, "invite")
      : command === "addlist" || command === "message"
        ? searchParam(url, "slug")
        : null;
  const pattern =
    command === "message"
      ? /^[A-Za-z0-9._-]{1,128}$/
      : /^[A-Za-z0-9_-]{1,128}$/;
  if (code === null || !pattern.test(code)) {
    return null;
  }
  return { host: "t.me", invite: true };
}

/** 桌面端把 `t.me/m/短码` 收成 `tg://message`。末尾斜杠不算。 */
function isBusinessChatLink(host: string, path: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (
    (bare === "t.me" || bare === "telegram.me" || bare === "telegram.dog") &&
    /^\/m\/[A-Za-z0-9._-]{1,128}$/i.test(path)
  ) {
    return true;
  }
  return host === "m.t.me" && /^\/[A-Za-z0-9._-]{1,128}$/i.test(path);
}

function isTelegramInvite(host: string, path: string): boolean {
  const telegram =
    host === "t.me" ||
    host.endsWith(".t.me") ||
    host === "telegram.me" ||
    host.endsWith(".telegram.me") ||
    host === "telegram.dog" ||
    host.endsWith(".telegram.dog");
  if (!telegram) {
    return false;
  }
  if (isTelegramPhonePath(host, path)) {
    return false;
  }
  return (
    /^\/\+[A-Za-z0-9_-]{1,128}$/.test(path) ||
    /^\/joinchat\/[A-Za-z0-9_-]{1,128}$/i.test(path) ||
    /^\/addlist\/[A-Za-z0-9_-]{1,128}$/i.test(path) ||
    /^\/folder\/[A-Za-z0-9_-]{1,128}$/.test(path) ||
    isAndroidPrefixInvite(host, path)
  );
}

/** Android 把 `folder.t.me/码` 收成 `t.me/folder/码`。只认这三枚标签。 */
function isAndroidPrefixInvite(host: string, path: string): boolean {
  if (!host.endsWith(".t.me")) {
    return false;
  }
  const label = host.slice(0, -".t.me".length);
  if (label !== "folder" && label !== "addlist" && label !== "joinchat") {
    return false;
  }
  return /^\/[A-Za-z0-9_-]{1,128}$/.test(path);
}

/** 桌面端把 `t.me/%20邀请码` 收成 `tg://join`。末尾斜杠和 `#` 不算。 */
function isPercentSpaceInvite(raw: string, host: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  return /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\/%20[A-Za-z0-9_-]{1,128}(?:\?.*)?$/i.test(
    raw,
  );
}

function isTelegramPhonePath(host: string, path: string): boolean {
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  if (bare !== "t.me" && bare !== "telegram.me" && bare !== "telegram.dog") {
    return false;
  }
  const segment = path.startsWith("/") ? path.slice(1) : path;
  return /^\+\d{1,128}$/.test(segment);
}

const mediaFields = [
  ["sticker", "sticker"],
  ["animation", "animation"],
  ["video", "video"],
  ["video_note", "video_note"],
  ["voice", "voice"],
  ["audio", "audio"],
  ["document", "document"],
  ["photo", "photo"],
] as const;

async function mediaMark(
  message: Record<string, unknown>,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  for (const [field, kind] of mediaFields) {
    const value = message[field];
    if (field === "photo") {
      if (!Array.isArray(value) || value.length === 0) {
        continue;
      }
      const id = uniqueId(value[value.length - 1]);
      return id
        ? { kind, sha256: await sha256Hex(`${kind}\n${id}`) }
        : { kind };
    }
    if (!isRecord(value)) {
      continue;
    }
    const id = uniqueId(value);
    return id ? { kind, sha256: await sha256Hex(`${kind}\n${id}`) } : { kind };
  }
  if (isDice(message.dice)) {
    return { kind: "dice" };
  }
  const rich = message.rich_message;
  if (isRecord(rich)) {
    const found = await firstRichMedia(rich.blocks);
    if (found) {
      return found;
    }
  }
  return firstPaidMedia(message.paid_media);
}

function isDice(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.emoji === "string" &&
    value.emoji.length > 0 &&
    value.emoji.length <= 16
  );
}

async function firstPaidMedia(
  paid: unknown,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  if (!isRecord(paid) || !Array.isArray(paid.paid_media)) {
    return undefined;
  }
  for (const item of paid.paid_media) {
    if (!isRecord(item)) {
      continue;
    }
    if (item.type === "photo") {
      if (!Array.isArray(item.photo) || item.photo.length === 0) {
        continue;
      }
      return marked("photo", uniqueId(item.photo[item.photo.length - 1]));
    }
    if (item.type === "video") {
      if (!isRecord(item.video)) {
        continue;
      }
      return marked("video", uniqueId(item.video));
    }
    if (item.type === "live_photo") {
      if (!isRecord(item.live_photo)) {
        continue;
      }
      return marked("video", uniqueId(item.live_photo));
    }
  }
  return undefined;
}

async function firstRichMedia(
  value: unknown,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const block of value) {
    if (!isRecord(block)) {
      continue;
    }
    const found = await markRichBlock(block);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function markRichBlock(
  block: Record<string, unknown>,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string } | undefined> {
  const type = block.type;
  if (
    type === "animation" ||
    type === "video" ||
    type === "audio" ||
    type === "document"
  ) {
    const value = block[type];
    if (!isRecord(value)) {
      return undefined;
    }
    return marked(type, uniqueId(value));
  }
  if (type === "voice_note") {
    if (!isRecord(block.voice_note)) {
      return undefined;
    }
    return marked("voice", uniqueId(block.voice_note));
  }
  if (type === "photo") {
    if (!Array.isArray(block.photo) || block.photo.length === 0) {
      return undefined;
    }
    return marked("photo", uniqueId(block.photo[block.photo.length - 1]));
  }
  if (type === "list" && Array.isArray(block.items)) {
    for (const item of block.items) {
      if (!isRecord(item)) {
        continue;
      }
      const found = await firstRichMedia(item.blocks);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (
    type === "details" ||
    type === "blockquote" ||
    type === "collage" ||
    type === "slideshow"
  ) {
    return firstRichMedia(block.blocks);
  }
  return undefined;
}

async function marked(
  kind: MediaKind,
  id: string | undefined,
): Promise<{ readonly kind: MediaKind; readonly sha256?: string }> {
  return id ? { kind, sha256: await sha256Hex(`${kind}\n${id}`) } : { kind };
}

function uniqueId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = value.file_unique_id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return undefined;
  }
  return id;
}

function richBody(message: Record<string, unknown>): string {
  const read = readRich(message);
  return read.text;
}

function richUrls(message: Record<string, unknown>): string[] {
  return readRich(message).urls;
}

function readRich(message: Record<string, unknown>): {
  text: string;
  urls: string[];
  source: string;
  labels: string;
} {
  const rich = message.rich_message;
  if (!isRecord(rich)) {
    return { text: "", urls: [], source: "", labels: "" };
  }
  const parts: string[] = [];
  const labels: string[] = [];
  const urls: string[] = [];
  walkBlocks(rich.blocks, parts, labels, urls);
  const body = parts.join(" ");
  const labelText = labels.join(" ");
  const source = body.length > 0 ? body : labelText;
  return {
    text: source.slice(0, MAX_TEXT),
    urls,
    source,
    labels: labelText,
  };
}

function walkBlocks(
  value: unknown,
  parts: string[],
  labels: string[],
  urls: string[],
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const block of value) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "mathematical_expression") {
      pushPlainUrls(block.expression, urls);
      continue;
    }
    if (block.type === "buttons" && Array.isArray(block.buttons)) {
      for (const button of block.buttons) {
        const label = richButton(button, urls);
        if (label.length > 0) {
          labels.push(label);
        }
      }
      continue;
    }
    if (block.type === "list" && Array.isArray(block.items)) {
      for (const item of block.items) {
        if (!isRecord(item)) {
          continue;
        }
        if (typeof item.label === "string" && item.label.length > 0) {
          parts.push(item.label);
          pushPlainUrls(item.label, urls);
        }
        walkBlocks(item.blocks, parts, labels, urls);
      }
      continue;
    }
    if (block.type === "table" && Array.isArray(block.cells)) {
      for (const row of block.cells) {
        if (!Array.isArray(row)) {
          continue;
        }
        for (const cell of row) {
          if (!isRecord(cell)) {
            continue;
          }
          const text = richText(cell.text, urls);
          if (text.length > 0) {
            parts.push(text);
          }
        }
      }
      pushRich(richText(block.caption, urls), parts);
      continue;
    }
    if (block.type === "details") {
      pushRich(richText(block.summary, urls), parts);
      walkBlocks(block.blocks, parts, labels, urls);
      continue;
    }
    if (
      block.type === "blockquote" ||
      block.type === "collage" ||
      block.type === "slideshow"
    ) {
      walkBlocks(block.blocks, parts, labels, urls);
      pushRich(richText(block.credit, urls), parts);
      pushCaption(block.caption, parts, urls);
      continue;
    }
    if (
      block.type === "paragraph" ||
      block.type === "heading" ||
      block.type === "pre" ||
      block.type === "footer" ||
      block.type === "expandable_blockquote" ||
      block.type === "pullquote" ||
      block.type === "thinking"
    ) {
      pushRich(richText(block.text, urls), parts);
      pushRich(richText(block.credit, urls), parts);
      if (block.type === "pre") {
        pushPlainUrls(block.language, urls);
      }
      continue;
    }
    if (
      block.type === "animation" ||
      block.type === "video" ||
      block.type === "audio" ||
      block.type === "document"
    ) {
      pushRichMediaName(block, urls);
    }
    pushCaption(block.caption, parts, urls);
  }
}

function pushRichMediaName(
  block: Record<string, unknown>,
  urls: string[],
): void {
  const value = block[String(block.type)];
  if (!isRecord(value)) {
    return;
  }
  if (block.type === "audio") {
    pushPlainUrls(value.title, urls);
    pushPlainUrls(value.file_name, urls);
    pushPlainUrls(value.performer, urls);
    return;
  }
  pushPlainUrls(value.file_name, urls);
}

function pushRich(text: string, parts: string[]): void {
  if (text.length > 0) {
    parts.push(text);
  }
}

function pushCaption(caption: unknown, parts: string[], urls: string[]): void {
  if (!isRecord(caption)) {
    return;
  }
  pushRich(richText(caption.text, urls), parts);
  pushRich(richText(caption.credit, urls), parts);
}

function richText(value: unknown, urls: string[]): string {
  if (typeof value === "string") {
    for (const url of urlsInText(value)) {
      urls.push(url);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => richText(item, urls)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if (value.type === "url" && typeof value.url === "string") {
    urls.push(value.url);
  }
  if (value.type === "button") {
    return richButton(value.button, urls);
  }
  if (value.type === "mathematical_expression") {
    pushPlainUrls(value.expression, urls);
    return "";
  }
  if (value.type === "custom_emoji") {
    return richText(value.alternative_text, urls);
  }
  if ("text" in value) {
    return richText(value.text, urls);
  }
  return "";
}

function richButton(value: unknown, urls: string[]): string {
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.url === "string") {
    urls.push(value.url);
  }
  const copied = value.copy_text;
  if (isRecord(copied) && typeof copied.text === "string") {
    for (const url of urlsInText(copied.text)) {
      urls.push(url);
    }
  }
  const login = value.login_url;
  if (isRecord(login)) {
    if (typeof login.url === "string") {
      urls.push(login.url);
    }
    pushPlainUrls(login.forward_text, urls);
  }
  const app = value.web_app;
  if (isRecord(app) && typeof app.url === "string") {
    urls.push(app.url);
  }
  pushSwitchInlineQueries(value, urls);
  return richText(value.text, urls);
}

function messageText(
  message: Record<string, unknown>,
  includeQuote = true,
): string {
  if (typeof message.text === "string" && message.text.length > 0) {
    return message.text.slice(0, MAX_TEXT);
  }
  if (typeof message.caption === "string" && message.caption.length > 0) {
    return message.caption.slice(0, MAX_TEXT);
  }
  const rich = richBody(message);
  if (rich.length > 0) {
    return rich;
  }
  const poll = message.poll;
  if (
    isRecord(poll) &&
    typeof poll.question === "string" &&
    poll.question.length > 0
  ) {
    return poll.question.slice(0, MAX_TEXT);
  }
  for (const field of ["giveaway", "giveaway_winners"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.prize_description === "string" &&
      value.prize_description.length > 0
    ) {
      return value.prize_description.slice(0, MAX_TEXT);
    }
  }
  const checklist = message.checklist;
  if (
    isRecord(checklist) &&
    typeof checklist.title === "string" &&
    checklist.title.length > 0
  ) {
    return checklist.title.slice(0, MAX_TEXT);
  }
  for (const field of ["game", "invoice", "venue"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.title === "string" &&
      value.title.length > 0
    ) {
      return value.title.slice(0, MAX_TEXT);
    }
  }
  const label = mediaLabel(message);
  if (label.length > 0) {
    return label;
  }
  const performer = performerName(message);
  if (performer.length > 0) {
    return performer;
  }
  const buttons = buttonLabel(message);
  if (buttons.length > 0) {
    return buttons;
  }
  const webApp = webAppButtonText(message);
  if (webApp.length > 0) {
    return webApp;
  }
  const quote = message.quote;
  if (
    includeQuote &&
    isRecord(quote) &&
    quote.is_manual === true &&
    typeof quote.text === "string" &&
    quote.text.length > 0
  ) {
    return quote.text.slice(0, MAX_TEXT);
  }
  const gift = giftText(message);
  if (gift.length > 0) {
    return gift;
  }
  const uniqueGift = uniqueGiftLabels(message);
  if (uniqueGift.length > 0) {
    return uniqueGift;
  }
  const topic = topicName(message);
  if (topic.length > 0) {
    return topic;
  }
  const comment = declineComment(message);
  if (comment.length > 0) {
    return comment;
  }
  const added = addedServiceText(message);
  if (added.length > 0) {
    return added;
  }
  const hidden = hiddenForwardName(message);
  if (hidden.length > 0) {
    return hidden;
  }
  const signature = authorSignature(message);
  if (signature.length > 0) {
    return signature;
  }
  const mirror = mirrorAuthorSignature(message);
  if (mirror.length > 0) {
    return mirror;
  }
  const tag = senderTag(message);
  if (tag.length > 0) {
    return tag;
  }
  const members = memberNames(message);
  if (members.length > 0) {
    return members;
  }
  const shared = sharedUserNames(message);
  if (shared.length > 0) {
    return shared;
  }
  const managed = managedBotNames(message);
  if (managed.length > 0) {
    return managed;
  }
  const writeAccess = writeAccessName(message);
  if (writeAccess.length > 0) {
    return writeAccess;
  }
  return "";
}

function memberNames(message: Record<string, unknown>): string {
  return memberNameSource(message).slice(0, MAX_TEXT);
}

function memberNameSource(message: Record<string, unknown>): string {
  const parts: string[] = [];
  pushUserLabels(message.new_chat_members, parts);
  const invited = message.video_chat_participants_invited;
  if (isRecord(invited)) {
    pushUserLabels(invited.users, parts);
  }
  for (const field of ["chat_owner_changed", "chat_owner_left"]) {
    const value = message[field];
    if (isRecord(value)) {
      pushUserLabels([value.new_owner], parts);
    }
  }
  const proximity = message.proximity_alert_triggered;
  if (isRecord(proximity)) {
    pushUserLabels([proximity.traveler, proximity.watcher], parts);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ");
}

function sharedUserNames(message: Record<string, unknown>): string {
  return sharedUserNameSource(message).slice(0, MAX_TEXT);
}

function sharedUserNameSource(message: Record<string, unknown>): string {
  const shared = message.users_shared;
  if (!isRecord(shared)) {
    return "";
  }
  const parts: string[] = [];
  pushUserLabels(shared.users, parts);
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ");
}

function managedBotNames(message: Record<string, unknown>): string {
  return managedBotNameSource(message).slice(0, MAX_TEXT);
}

function managedBotNameSource(message: Record<string, unknown>): string {
  const created = message.managed_bot_created;
  if (!isRecord(created)) {
    return "";
  }
  const parts: string[] = [];
  pushUserLabels([created.bot], parts);
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ");
}

/** 用户允许 bot 发消息时带上的小程序名字。来源布尔值不读。 */
function writeAccessName(message: Record<string, unknown>): string {
  return writeAccessNameSource(message).slice(0, MAX_TEXT);
}

function writeAccessNameSource(message: Record<string, unknown>): string {
  const allowed = message.write_access_allowed;
  if (!isRecord(allowed) || typeof allowed.web_app_name !== "string") {
    return "";
  }
  return allowed.web_app_name.trim();
}

function pushUserLabels(value: unknown, parts: string[]): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const member of value) {
    if (!isRecord(member)) {
      continue;
    }
    for (const key of ["first_name", "last_name", "username"]) {
      const label = member[key];
      if (typeof label !== "string") {
        continue;
      }
      const trimmed = label.trim();
      if (trimmed.length > 0) {
        parts.push(trimmed);
      }
    }
  }
}

/** 已有别的正文时，话题名另留最多 128 字。先看新建，再看改名。这段自己就是正文时改看下一种。图标不进这个字段。 */
function besideTopicName(
  message: Record<string, unknown>,
  text: string,
): string {
  for (const field of ["forum_topic_created", "forum_topic_edited"]) {
    const value = message[field];
    if (!isRecord(value) || typeof value.name !== "string") {
      continue;
    }
    const source = value.name;
    if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
      continue;
    }
    const raw = clipped(source, 128);
    if (raw.length === 0) {
      continue;
    }
    return raw;
  }
  return "";
}

/** 已有别的正文时，拒绝说明另留最多 128 字。这段自己就是正文时不重复。嵌套原帖不进这个字段。 */
function besideDeclineComment(
  message: Record<string, unknown>,
  text: string,
): string {
  const declined = message.suggested_post_declined;
  if (!isRecord(declined) || typeof declined.comment !== "string") {
    return "";
  }
  const source = declined.comment;
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, 128);
}

/** 已有别的正文时，后加选项或任务另留。选项最多 100 字，任务拼起来最多 3029 字。先看新选项，再看被删选项，再看新任务。这段自己就是正文时改看下一种。编号、原消息和完成者不进这个字段。 */
function besideAddedText(
  message: Record<string, unknown>,
  text: string,
): string {
  for (const field of ["poll_option_added", "poll_option_deleted"]) {
    const value = message[field];
    if (!isRecord(value) || typeof value.option_text !== "string") {
      continue;
    }
    const source = value.option_text;
    if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
      continue;
    }
    const raw = clipped(source, 100);
    if (raw.length === 0) {
      continue;
    }
    return raw;
  }
  const source = addedTaskSource(message);
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, 3029);
}

/** 已有别的正文时，隐藏转发显示名另留最多 4096 字。先看现代字段，再看旧字段。这段自己就是正文时改看下一种。频道标题、真实用户姓名和外部回复不进这个字段。 */
function besideHiddenName(
  message: Record<string, unknown>,
  text: string,
): string {
  const origin = message.forward_origin;
  if (
    isRecord(origin) &&
    origin.type === "hidden_user" &&
    typeof origin.sender_user_name === "string"
  ) {
    const source = origin.sender_user_name;
    if (source.length > 0 && text !== source.slice(0, MAX_TEXT)) {
      const raw = clipped(source, MAX_TEXT);
      if (raw.length > 0) {
        return raw;
      }
    }
  }
  if (typeof message.forward_sender_name !== "string") {
    return "";
  }
  const source = message.forward_sender_name;
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 已有别的正文时，入群、邀请、换群主和靠近提醒的可见名字另留最多 4096 字。这段自己就是正文时不重复。退群的人、发送者姓名、编号和距离不进这个字段。 */
function besideMemberName(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = memberNameSource(message);
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 已有别的正文时，分享来的用户名字另留最多 4096 字。这段自己就是正文时不重复。请求编号、用户编号、头像、发送者姓名和聊天标题不进这个字段。 */
function besideSharedName(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = sharedUserNameSource(message);
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 已有别的正文时，新建受管 bot 的可见名字另留最多 4096 字。这段自己就是正文时不重复。bot 编号、令牌、创建者姓名和聊天标题不进这个字段。 */
function besideManagedName(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = managedBotNameSource(message);
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 已有别的正文时，允许发消息带上的小程序名字另留最多 4096 字。这段自己就是正文时不重复。来源布尔值、发送者姓名和聊天标题不进这个字段。 */
function besideAccessName(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = writeAccessNameSource(message);
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 已有别的正文时，游戏动图文件名另留最多 4096 字。这段自己就是正文时不重复。封面、文件编号和 MIME 不进这个字段。 */
function besideGameFile(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = gameFileSource(message);
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

function gameFileSource(message: Record<string, unknown>): string {
  const game = message.game;
  if (!isRecord(game) || !isRecord(game.animation)) {
    return "";
  }
  const name = game.animation.file_name;
  if (typeof name !== "string") {
    return "";
  }
  return name;
}

/** 标题已经占住名称时，音频文件名另留最多 4096 字。文件名自己就是名称或正文时不重复。文件编号、MIME 和时长不进这个字段。 */
function besideAudioFile(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = audioFileSource(message);
  if (source.length === 0) {
    return "";
  }
  const slice = source.slice(0, MAX_TEXT);
  if (text === slice || mediaLabel(message) === slice) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

function audioFileSource(message: Record<string, unknown>): string {
  const audio = message.audio;
  if (!isRecord(audio) || typeof audio.file_name !== "string") {
    return "";
  }
  return audio.file_name;
}

/** 已有名称或正文时，后面的付费视频文件名另留最多 4096 字。已经选中的那一段不重复。星星、文件编号、MIME、照片和预览不进这个字段。 */
function besidePaidFile(
  message: Record<string, unknown>,
  text: string,
): string {
  const label = mediaLabel(message);
  const parts: string[] = [];
  for (const name of paidVideoNames(message)) {
    const slice = name.slice(0, MAX_TEXT);
    if (slice.length === 0 || text === slice || label === slice) {
      continue;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    parts.push(trimmed);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function paidVideoNames(message: Record<string, unknown>): string[] {
  const paid = message.paid_media;
  if (!isRecord(paid) || !Array.isArray(paid.paid_media)) {
    return [];
  }
  const names: string[] = [];
  for (const item of paid.paid_media) {
    if (!isRecord(item) || !isRecord(item.video)) {
      continue;
    }
    const name = item.video.file_name;
    if (typeof name !== "string") {
      continue;
    }
    names.push(name);
  }
  return names;
}

/** 富文本里的文件名、音频标题和表演者另留最多 4096 字。这段自己就是正文时不重复。说明、照片、语音和文件编号不进这个字段。 */
function besideRichName(
  message: Record<string, unknown>,
  text: string,
): string {
  const rich = message.rich_message;
  if (!isRecord(rich)) {
    return "";
  }
  const parts: string[] = [];
  walkRichNameBlocks(rich.blocks, text, mediaLabel(message), parts);
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function walkRichNameBlocks(
  blocks: unknown,
  text: string,
  label: string,
  parts: string[],
): void {
  if (!Array.isArray(blocks)) {
    return;
  }
  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "list" && Array.isArray(block.items)) {
      for (const item of block.items) {
        if (isRecord(item)) {
          walkRichNameBlocks(item.blocks, text, label, parts);
        }
      }
      continue;
    }
    if (
      block.type === "blockquote" ||
      block.type === "collage" ||
      block.type === "slideshow" ||
      block.type === "details"
    ) {
      walkRichNameBlocks(block.blocks, text, label, parts);
      continue;
    }
    if (
      block.type !== "animation" &&
      block.type !== "video" &&
      block.type !== "audio" &&
      block.type !== "document"
    ) {
      continue;
    }
    const media = block[block.type];
    if (!isRecord(media)) {
      continue;
    }
    if (block.type === "audio") {
      pushRichName(media.title, text, label, parts);
      pushRichName(media.file_name, text, label, parts);
      pushRichName(media.performer, text, label, parts);
      continue;
    }
    pushRichName(media.file_name, text, label, parts);
  }
}

function pushRichName(
  name: unknown,
  text: string,
  label: string,
  parts: string[],
): void {
  if (typeof name !== "string") {
    return;
  }
  const slice = name.slice(0, MAX_TEXT);
  if (slice.length === 0 || text === slice || label === slice) {
    return;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return;
  }
  parts.push(trimmed);
}

/** 投票媒体上的文件名、音频名和场馆名另留最多 4096 字。这一截自己就是正文时不重复。照片、贴纸、位置和文件编号不进这个字段。 */
function besidePollMedia(
  message: Record<string, unknown>,
  text: string,
): string {
  const poll = message.poll;
  if (!isRecord(poll)) {
    return "";
  }
  const parts: string[] = [];
  const label = mediaLabel(message);
  pushPollMediaNames(poll.media, text, label, parts);
  pushPollMediaNames(poll.explanation_media, text, label, parts);
  if (Array.isArray(poll.options)) {
    for (const option of poll.options) {
      if (isRecord(option)) {
        pushPollMediaNames(option.media, text, label, parts);
      }
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function pushPollMediaNames(
  media: unknown,
  text: string,
  label: string,
  parts: string[],
): void {
  if (!isRecord(media)) {
    return;
  }
  for (const field of ["animation", "video", "audio", "document"] as const) {
    const value = media[field];
    if (!isRecord(value)) {
      continue;
    }
    if (field === "audio") {
      pushPollName(value.title, text, label, parts);
      pushPollName(value.file_name, text, label, parts);
      pushPollName(value.performer, text, label, parts);
      continue;
    }
    pushPollName(value.file_name, text, label, parts);
  }
  if (isRecord(media.venue)) {
    pushPollName(media.venue.title, text, label, parts);
    pushPollName(media.venue.address, text, label, parts);
  }
}

function pushPollName(
  name: unknown,
  text: string,
  label: string,
  parts: string[],
): void {
  if (typeof name !== "string") {
    return;
  }
  const slice = name.slice(0, MAX_TEXT);
  if (slice.length === 0 || text === slice || label === slice) {
    return;
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return;
  }
  parts.push(trimmed);
}

/** 已有别的正文时，投票描述另留最多 1024 字。这段自己就是正文时不重复。投票人数和添加者名字不进这个字段。 */
function besidePollDescription(
  message: Record<string, unknown>,
  text: string,
): string {
  const poll = message.poll;
  if (!isRecord(poll) || typeof poll.description !== "string") {
    return "";
  }
  const source = poll.description;
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, 1024);
}

/** 已有别的正文时，富文本里看得见的字另留最多 4096 字。这段自己就是正文时不重复。公式、语言标签和隐藏标识不进这个字段。 */
function besideRichText(
  message: Record<string, unknown>,
  text: string,
): string {
  const source = readRich(message).source;
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, 4096);
}

/** 已有段落时，富文本按钮上看得见的字另留最多 4096 字。按钮自己就是正文或已经留在富文本里时不重复。复制句子和回调数据不进这个字段。 */
function besideRichButton(
  message: Record<string, unknown>,
  text: string,
): string {
  const read = readRich(message);
  const labels = read.labels;
  if (labels.length === 0 || read.source === labels) {
    return "";
  }
  if (text === labels.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(labels, 4096);
}

/** 选中的名称之后，后面的文件名和被挤开的音频标题另留最多 4096 字。已经选中的那一段、音频文件名和付费后段不重复。文件编号和 MIME 不进这个字段。 */
function besideLaterName(
  message: Record<string, unknown>,
  text: string,
): string {
  const label = mediaLabel(message);
  const parts: string[] = [];
  for (const name of laterMediaNames(message)) {
    const slice = name.slice(0, MAX_TEXT);
    if (slice.length === 0 || text === slice || label === slice) {
      continue;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    parts.push(trimmed);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function laterMediaNames(message: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const field of ["animation", "video"] as const) {
    const value = message[field];
    if (isRecord(value) && typeof value.file_name === "string") {
      names.push(value.file_name);
    }
  }
  const audio = message.audio;
  if (isRecord(audio) && typeof audio.title === "string") {
    const file = typeof audio.file_name === "string" ? audio.file_name : "";
    if (audio.title.trim() !== file.trim()) {
      names.push(audio.title);
    }
  }
  const document = message.document;
  if (isRecord(document) && typeof document.file_name === "string") {
    names.push(document.file_name);
  }
  return names;
}

/** 已有别的正文时，收藏名另留最多 4096 字。这段自己就是正文时不重复。有附言时不读型号、符号和背景。短名和发布者不进这个字段。 */
function besideGiftLabel(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = uniqueGiftLabels(message);
  if (raw.length === 0 || text === raw) {
    return "";
  }
  return raw;
}

/** 已有别的正文时，礼物附言另留最多 128 字。这段自己就是正文时改看下一种。贴纸、星星和收藏名不进这个字段。 */
function besideGiftText(
  message: Record<string, unknown>,
  text: string,
): string {
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const value = message[field];
    if (!isRecord(value) || typeof value.text !== "string") {
      continue;
    }
    const source = value.text;
    if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
      continue;
    }
    const raw = clipped(source, 128);
    if (raw.length === 0) {
      continue;
    }
    return raw;
  }
  return "";
}

/** 已有别的正文时，手动引用另留最多 4096 字。这段自己就是正文时不重复。自动引用和被回复的原消息不进这个字段。 */
function besideManualQuote(
  message: Record<string, unknown>,
  text: string,
): string {
  const quote = message.quote;
  if (
    !isRecord(quote) ||
    quote.is_manual !== true ||
    typeof quote.text !== "string"
  ) {
    return "";
  }
  const source = quote.text;
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 已有别的正文时，小程序按钮文字另留最多 4096 字。这段自己就是正文时不重复。`data` 不进这个字段。 */
function besideWebAppButton(
  message: Record<string, unknown>,
  text: string,
): string {
  const webApp = message.web_app_data;
  if (!isRecord(webApp) || typeof webApp.button_text !== "string") {
    return "";
  }
  const source = webApp.button_text;
  if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(source, MAX_TEXT);
}

/** 小程序回传的按钮文字看得见。`data` 只留主机名，不进正文。 */
function webAppButtonText(message: Record<string, unknown>): string {
  const webApp = message.web_app_data;
  if (!isRecord(webApp) || typeof webApp.button_text !== "string") {
    return "";
  }
  return webApp.button_text.slice(0, MAX_TEXT);
}

function senderTag(message: Record<string, unknown>): string {
  if (typeof message.sender_tag === "string" && message.sender_tag.length > 0) {
    return message.sender_tag.slice(0, MAX_TEXT);
  }
  return "";
}

/** 已有别的正文时，成员标签另留最多 16 字。标签自己就是正文时不重复。 */
function besideSenderTag(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = senderTag(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, 16);
}

/** 已有别的正文时，内联按钮文字另留最多 256 字。按钮自己就是正文时不重复。 */
function besideButtonText(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = buttonLabel(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, 256);
}

/** 已有别的正文时，这条消息自己的作者签名另留最多 256 字。签名自己就是正文时不重复。 */
function besideAuthorSignature(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = authorSignature(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, 256);
}

/** 已有别的正文时，游戏说明和附加文字各自最多 4096 字，中间一个空格。这段文字自己就是正文时不重复。 */
function besideGameText(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = gameCopy(message);
  if (raw.length === 0 || text === raw) {
    return "";
  }
  return raw;
}

/** 已有别的正文时，账单说明另留最多 255 字。说明自己就是正文时不重复。 */
function besideInvoiceText(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = invoiceCopy(message);
  if (raw.length === 0 || text === raw) {
    return "";
  }
  return raw;
}

function gameCopy(message: Record<string, unknown>): string {
  const game = message.game;
  if (!isRecord(game)) {
    return "";
  }
  const parts = [clipped(game.description, 4096), clipped(game.text, 4096)];
  return parts.filter((part) => part.length > 0).join(" ");
}

function invoiceCopy(message: Record<string, unknown>): string {
  const invoice = message.invoice;
  if (!isRecord(invoice)) {
    return "";
  }
  return clipped(invoice.description, 255);
}

/** 已有别的正文时，地点地址另留最多 4096 字。地址自己就是正文时不重复。 */
function besideVenueAddress(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = venueAddressCopy(message);
  if (raw.length === 0 || text === raw) {
    return "";
  }
  return raw;
}

function venueAddressCopy(message: Record<string, unknown>): string {
  const venue = message.venue;
  if (!isRecord(venue)) {
    return "";
  }
  return clipped(venue.address, 4096);
}

/** 已有别的正文时，测验说明另留最多 200 字。说明自己就是正文时不重复。 */
function besidePollExplanation(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = pollExplanationCopy(message);
  if (raw.length === 0 || text === raw) {
    return "";
  }
  return raw;
}

function pollExplanationCopy(message: Record<string, unknown>): string {
  const poll = message.poll;
  if (!isRecord(poll)) {
    return "";
  }
  return clipped(poll.explanation, 200);
}

/** 已有别的正文时，投票题干另留最多 300 字。题干自己就是正文时不重复。 */
function besidePollQuestion(
  message: Record<string, unknown>,
  text: string,
): string {
  const poll = message.poll;
  if (!isRecord(poll) || typeof poll.question !== "string") {
    return "";
  }
  if (poll.question.length === 0 || text === poll.question.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(poll.question, 300);
}

/** 已有别的正文时，奖品说明另留最多 255 字。这段自己就是正文时改看下一种。 */
function besidePrizeText(
  message: Record<string, unknown>,
  text: string,
): string {
  for (const field of ["giveaway", "giveaway_winners"]) {
    const value = message[field];
    if (!isRecord(value) || typeof value.prize_description !== "string") {
      continue;
    }
    const source = value.prize_description;
    if (source.length === 0 || text === source.slice(0, MAX_TEXT)) {
      continue;
    }
    const raw = clipped(source, 255);
    if (raw.length === 0) {
      continue;
    }
    return raw;
  }
  return "";
}

/** 已有别的正文时，卡片标题另留。这段自己就是正文时不重复。 */
function besideCardTitle(
  message: Record<string, unknown>,
  field: "game" | "invoice" | "venue",
  max: number,
  text: string,
): string {
  const value = message[field];
  if (!isRecord(value) || typeof value.title !== "string") {
    return "";
  }
  if (value.title.length === 0 || text === value.title.slice(0, MAX_TEXT)) {
    return "";
  }
  return clipped(value.title, max);
}

/** 已有别的正文时，清单标题另留最多 255 字。标题自己就是正文时不重复。 */
function besideChecklistTitle(
  message: Record<string, unknown>,
  text: string,
): string {
  const checklist = message.checklist;
  if (!isRecord(checklist) || typeof checklist.title !== "string") {
    return "";
  }
  if (
    checklist.title.length === 0 ||
    text === checklist.title.slice(0, MAX_TEXT)
  ) {
    return "";
  }
  return clipped(checklist.title, 255);
}

function clipped(value: unknown, max: number): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.slice(0, max);
}

/** 已有别的正文时，音频表演者另留最多 4096 字。表演者自己就是正文时不重复。 */
function besidePerformer(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = performerName(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, MAX_TEXT);
}

/** 已有别的正文时，文件名或音频标题另留最多 4096 字。这段名称自己就是正文时不重复。 */
function besideMediaName(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = mediaLabel(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, MAX_TEXT);
}

/** 已有别的正文时，清单任务另留最多 3029 字。任务自己就是正文时不重复。 */
function besideChecklistTask(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = checklistTaskText(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, 3029);
}

function checklistTaskText(message: Record<string, unknown>): string {
  const checklist = message.checklist;
  if (!isRecord(checklist) || !Array.isArray(checklist.tasks)) {
    return "";
  }
  const parts: string[] = [];
  for (const task of checklist.tasks) {
    if (
      !isRecord(task) ||
      typeof task.text !== "string" ||
      task.text.length === 0
    ) {
      continue;
    }
    parts.push(task.text);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

/** 已有别的正文时，投票选项另留最多 1211 字。选项自己就是正文时不重复。 */
function besidePollOption(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = pollOptionText(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, 1211);
}

function pollOptionText(message: Record<string, unknown>): string {
  const poll = message.poll;
  if (!isRecord(poll) || !Array.isArray(poll.options)) {
    return "";
  }
  const parts: string[] = [];
  for (const option of poll.options) {
    if (
      !isRecord(option) ||
      typeof option.text !== "string" ||
      option.text.length === 0
    ) {
      continue;
    }
    parts.push(option.text);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

/** 已有别的正文时，讨论组原帖来源上的作者签名另留最多 256 字。签名自己就是正文时不重复。 */
function besideMirrorSignature(
  message: Record<string, unknown>,
  text: string,
): string {
  const raw = mirrorAuthorSignature(message);
  const trimmed = raw.trim();
  if (trimmed.length === 0 || text === raw) {
    return "";
  }
  return trimmed.slice(0, 256);
}

function authorSignature(message: Record<string, unknown>): string {
  if (
    typeof message.author_signature === "string" &&
    message.author_signature.length > 0
  ) {
    return message.author_signature.slice(0, MAX_TEXT);
  }
  return "";
}

/** 讨论组原帖上画出的频道作者签名。成员转发和群来源另留主机名。其它来源不读。 */
function mirrorAuthorSignature(message: Record<string, unknown>): string {
  if (message.is_automatic_forward !== true) {
    return "";
  }
  const origin = message.forward_origin;
  if (!isRecord(origin) || origin.type !== "channel") {
    return "";
  }
  if (
    typeof origin.author_signature !== "string" ||
    origin.author_signature.length === 0
  ) {
    return "";
  }
  return origin.author_signature.slice(0, MAX_TEXT);
}

function hiddenForwardName(message: Record<string, unknown>): string {
  const origin = message.forward_origin;
  if (
    isRecord(origin) &&
    origin.type === "hidden_user" &&
    typeof origin.sender_user_name === "string" &&
    origin.sender_user_name.length > 0
  ) {
    return origin.sender_user_name.slice(0, MAX_TEXT);
  }
  if (
    typeof message.forward_sender_name === "string" &&
    message.forward_sender_name.length > 0
  ) {
    return message.forward_sender_name.slice(0, MAX_TEXT);
  }
  return "";
}

function addedServiceText(message: Record<string, unknown>): string {
  for (const field of ["poll_option_added", "poll_option_deleted"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.option_text === "string" &&
      value.option_text.length > 0
    ) {
      return value.option_text.slice(0, MAX_TEXT);
    }
  }
  return addedTaskSource(message).slice(0, MAX_TEXT);
}

function addedTaskSource(message: Record<string, unknown>): string {
  const added = message.checklist_tasks_added;
  if (!isRecord(added) || !Array.isArray(added.tasks)) {
    return "";
  }
  const parts: string[] = [];
  for (const task of added.tasks) {
    if (!isRecord(task) || typeof task.text !== "string") {
      continue;
    }
    if (task.text.length === 0) {
      continue;
    }
    parts.push(task.text);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ");
}

function declineComment(message: Record<string, unknown>): string {
  const declined = message.suggested_post_declined;
  if (
    isRecord(declined) &&
    typeof declined.comment === "string" &&
    declined.comment.length > 0
  ) {
    return declined.comment.slice(0, MAX_TEXT);
  }
  return "";
}

function topicName(message: Record<string, unknown>): string {
  for (const field of ["forum_topic_created", "forum_topic_edited"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.name === "string" &&
      value.name.length > 0
    ) {
      return value.name.slice(0, MAX_TEXT);
    }
  }
  return "";
}

function giftText(message: Record<string, unknown>): string {
  for (const field of ["gift", "unique_gift", "gift_upgrade_sent"]) {
    const value = message[field];
    if (
      isRecord(value) &&
      typeof value.text === "string" &&
      value.text.length > 0
    ) {
      return value.text.slice(0, MAX_TEXT);
    }
  }
  return "";
}

/** 独特礼物卡片上的收藏名。有附言时型号、符号和背景不出现。 */
function uniqueGiftLabels(message: Record<string, unknown>): string {
  return uniqueGiftLabelSource(message).slice(0, MAX_TEXT);
}

/** 收藏名的整段，供主机名抽取。字段和正文仍截到 4096。 */
function uniqueGiftLabelSource(message: Record<string, unknown>): string {
  const info = message.unique_gift;
  if (!isRecord(info) || !isRecord(info.gift)) {
    return "";
  }
  const parts: string[] = [];
  pushTrimmed(info.gift.base_name, parts);
  const text = info.text;
  if (typeof text !== "string" || text.length === 0) {
    for (const key of ["model", "symbol", "backdrop"]) {
      const attribute = info.gift[key];
      if (isRecord(attribute)) {
        pushTrimmed(attribute.name, parts);
      }
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ");
}

/** 普通礼物上画出的发布者用户名。标题不读。 */
function giftPublisherNames(message: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of ["gift", "gift_upgrade_sent"]) {
    const info = message[field];
    if (!isRecord(info) || !isRecord(info.gift)) {
      continue;
    }
    const chat = info.gift.publisher_chat;
    if (isRecord(chat)) {
      pushTrimmed(chat.username, parts);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

/**
 * 付款成功这行画出的名字和账单标题。
 * 私聊对方的名在前，名为空才用姓。账单标题来自被回复的账单。
 * 载荷、订单和退款不读。
 */
function pushPaymentDrawnUrls(
  message: Record<string, unknown>,
  urls: string[],
): void {
  if (!isRecord(message.successful_payment)) {
    return;
  }
  const chat = message.chat;
  if (isRecord(chat) && chat.type === "private") {
    pushVisiblePartyUrls(chat, undefined, urls);
  }
  const reply = message.reply_to_message;
  if (!isRecord(reply) || !isRecord(reply.invoice)) {
    return;
  }
  pushPlainUrls(reply.invoice.title, urls);
}

/**
 * 商业账号代发时，时间戳旁画出的 bot 全名。名和姓都去掉两端空白。
 * 名为空时只画姓。用户名和电话不读。
 */
function businessBotDrawnName(message: Record<string, unknown>): string {
  const bot = message.sender_business_bot;
  if (!isRecord(bot)) {
    return "";
  }
  const parts: string[] = [];
  pushTrimmed(bot.first_name, parts);
  pushTrimmed(bot.last_name, parts);
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

/**
 * 客座回复抬头上 bot 自己的短名。有名时不读姓。
 * 从下标 2 起的第一个空格后面不画。没有客座召唤者时不读。
 */
function guestBotDrawnName(message: Record<string, unknown>): string {
  if (
    (!isRecord(message.guest_bot_caller_user) &&
      !isRecord(message.guest_bot_caller_chat)) ||
    !isRecord(message.from)
  ) {
    return "";
  }
  const from = message.from;
  let name = "";
  if (typeof from.first_name === "string" && from.first_name.length > 0) {
    name = from.first_name;
  } else if (
    (from.first_name === undefined || from.first_name === "") &&
    typeof from.last_name === "string" &&
    from.last_name.length > 0
  ) {
    name = from.last_name;
  } else {
    return "";
  }
  const split = name.indexOf(" ", 2);
  const drawn = split >= 0 ? name.slice(0, split) : name;
  return drawn.slice(0, MAX_TEXT);
}

/**
 * 客座 bot 回复上画出的召唤者名字。有名时不读姓。用户名和频道用户名不读。
 * 名字不进正文。
 */
function guestCallerLabel(message: Record<string, unknown>): string {
  const user = message.guest_bot_caller_user;
  if (isRecord(user)) {
    if (typeof user.first_name === "string" && user.first_name.length > 0) {
      return user.first_name.slice(0, MAX_TEXT);
    }
    if (
      (user.first_name === undefined || user.first_name === "") &&
      typeof user.last_name === "string" &&
      user.last_name.length > 0
    ) {
      return user.last_name.slice(0, MAX_TEXT);
    }
    return "";
  }
  const chat = message.guest_bot_caller_chat;
  if (
    isRecord(chat) &&
    typeof chat.title === "string" &&
    chat.title.length > 0
  ) {
    return chat.title.slice(0, MAX_TEXT);
  }
  return "";
}

function storyPosterNames(message: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of ["story", "reply_to_story"]) {
    const story = message[field];
    if (!isRecord(story) || !isRecord(story.chat)) {
      continue;
    }
    pushTrimmed(story.chat.title, parts);
    pushTrimmed(story.chat.first_name, parts);
    pushTrimmed(story.chat.last_name, parts);
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function pushTrimmed(value: unknown, parts: string[]): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    parts.push(trimmed);
  }
}

function buttonLabel(message: Record<string, unknown>): string {
  const markup = message.reply_markup;
  if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) {
    return "";
  }
  const parts: string[] = [];
  for (const row of markup.inline_keyboard) {
    if (!Array.isArray(row)) {
      continue;
    }
    for (const button of row) {
      if (!isRecord(button) || typeof button.text !== "string") {
        continue;
      }
      if (button.text.length === 0) {
        continue;
      }
      parts.push(button.text);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return parts.join(" ").slice(0, MAX_TEXT);
}

function performerName(message: Record<string, unknown>): string {
  const audio = message.audio;
  if (
    isRecord(audio) &&
    typeof audio.performer === "string" &&
    audio.performer.length > 0
  ) {
    return audio.performer.slice(0, MAX_TEXT);
  }
  return "";
}

function mediaLabel(message: Record<string, unknown>): string {
  for (const field of ["animation", "video", "audio", "document"]) {
    const value = message[field];
    if (!isRecord(value)) {
      continue;
    }
    if (
      field === "audio" &&
      typeof value.title === "string" &&
      value.title.length > 0
    ) {
      return value.title.slice(0, MAX_TEXT);
    }
    if (typeof value.file_name === "string" && value.file_name.length > 0) {
      return value.file_name.slice(0, MAX_TEXT);
    }
  }
  const paid = message.paid_media;
  if (isRecord(paid) && Array.isArray(paid.paid_media)) {
    for (const item of paid.paid_media) {
      if (!isRecord(item) || !isRecord(item.video)) {
        continue;
      }
      const name = item.video.file_name;
      if (typeof name === "string" && name.length > 0) {
        return name.slice(0, MAX_TEXT);
      }
    }
  }
  return "";
}

function occurredAt(date: unknown, nowIso: string): string {
  if (typeof date !== "number" || !Number.isFinite(date)) {
    return nowIso;
  }
  const iso = new Date(date * 1000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(iso)) {
    return nowIso;
  }
  return iso;
}

function actorIsAdmin(
  message: Record<string, unknown>,
  admins: ReadonlySet<string>,
): boolean {
  const from = nestedId(message.from);
  if (from !== null && admins.has(from)) {
    return true;
  }
  const chat = nestedId(message.chat);
  const sender = nestedId(message.sender_chat);
  return chat !== null && sender !== null && chat === sender;
}

function nestedId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  return idString(value.id);
}

function idString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.length > 0 && value.length <= 128) {
    return value;
  }
  return null;
}

function positiveId(value: unknown): string | null {
  const id = idString(value);
  if (id === null || id === "0" || id.startsWith("-")) {
    return null;
  }
  return id;
}

function safeId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
