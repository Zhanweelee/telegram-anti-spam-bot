import type {
  AdministratorRight,
  BanTarget,
  BotIdentity,
  ChatAdministrator,
  ChatCommunity,
  ChatGuard,
  DefaultAdministratorRights,
  DefaultChatPermissions,
  DefaultRightsSnapshot,
  JoinBot,
  KickResult,
  MemberAdmin,
  MemberAllows,
  MemberStanding,
  MenuButtonState,
  MenuCommandSnapshot,
  ModerationPort,
  MuteTarget,
  ParentChat,
  PermissionState,
  PersonalChat,
  PrivatePrivacy,
  ReactionAllowlist,
  StickerSetRight,
  UnmuteResult,
  WebhookSnapshot,
} from "@tasb/core";
import { telegramId } from "./ids.js";

const silenced = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_react_to_messages: false,
  can_edit_tag: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

const speaking = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_react_to_messages: true,
  can_edit_tag: true,
  can_change_info: true,
  can_invite_users: true,
  can_pin_messages: true,
  can_manage_topics: true,
};

export const captchaPrompt = "请点击按钮，确认你不是机器人。";

export function createTelegramModerator(input: {
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch;
  readonly nowSeconds?: () => number;
}): ModerationPort {
  return {
    async deleteMessage(target) {
      const audienceId = target.audienceId;
      await postTelegram({
        token: input.token,
        method: audienceId ? "deleteEphemeralMessage" : "deleteMessage",
        fetchImpl: input.fetchImpl,
        missing: "delete_unavailable",
        failed: "delete_failed",
        body: audienceId
          ? {
              chat_id: telegramId(target.chatId),
              receiver_user_id: telegramId(audienceId),
              ephemeral_message_id: telegramId(target.messageId),
            }
          : {
              chat_id: telegramId(target.chatId),
              message_id: telegramId(target.messageId),
            },
      });
    },
    async deleteCommandMenu() {
      await postTelegram({
        token: input.token,
        method: "deleteMyCommands",
        fetchImpl: input.fetchImpl,
        missing: "delcommands_unavailable",
        failed: "delcommands_failed",
        body: { scope: { type: "all_private_chats" } },
      });
    },
    async deleteMessages(target) {
      if (target.messageIds.length < 1 || target.messageIds.length > 100) {
        throw new Error("deletes_failed");
      }
      await postTelegram({
        token: input.token,
        method: "deleteMessages",
        fetchImpl: input.fetchImpl,
        missing: "deletes_unavailable",
        failed: "deletes_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_ids: target.messageIds.map((messageId) =>
            telegramId(messageId),
          ),
        },
      });
    },
    async muteActor(target) {
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "mute_unavailable",
        failed: "mute_failed",
        body: silencedUntil(target, input.nowSeconds ?? unixSeconds),
      });
    },
    async approveJoin(target) {
      await postTelegram({
        token: input.token,
        method: "approveChatJoinRequest",
        fetchImpl: input.fetchImpl,
        missing: "approve_unavailable",
        failed: "approve_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
    },
    async setMenuButton(target) {
      await postTelegram({
        token: input.token,
        method: "setChatMenuButton",
        fetchImpl: input.fetchImpl,
        missing: "menubutton_unavailable",
        failed: "menubutton_failed",
        body: { menu_button: { type: target.kind } },
      });
    },
    async setBotName(target) {
      await postTelegram({
        token: input.token,
        method: "setMyName",
        fetchImpl: input.fetchImpl,
        missing: "botname_unavailable",
        failed: "botname_failed",
        body: { name: target.name },
      });
    },
    async setBotDescription(target) {
      await postTelegram({
        token: input.token,
        method: "setMyDescription",
        fetchImpl: input.fetchImpl,
        missing: "botdesc_unavailable",
        failed: "botdesc_failed",
        body: { description: target.description },
      });
    },
    async setBotShortDescription(target) {
      await postTelegram({
        token: input.token,
        method: "setMyShortDescription",
        fetchImpl: input.fetchImpl,
        missing: "botshort_unavailable",
        failed: "botshort_failed",
        body: { short_description: target.shortDescription },
      });
    },
    async setCommandMenu(target) {
      await postTelegram({
        token: input.token,
        method: "setMyCommands",
        fetchImpl: input.fetchImpl,
        missing: "setcommands_unavailable",
        failed: "setcommands_failed",
        body: {
          commands: target.commands.map((item) => ({
            command: item.command,
            description: item.description,
          })),
          scope: { type: "all_private_chats" },
        },
      });
    },
    async setDefaultRights(target) {
      await postTelegram({
        token: input.token,
        method: "setMyDefaultAdministratorRights",
        fetchImpl: input.fetchImpl,
        missing: "myrights_unavailable",
        failed: "myrights_failed",
        body: {
          ...(target.forChannels ? { for_channels: true } : {}),
          ...(target.rights === undefined
            ? {}
            : { rights: telegramDefaultRights(target.rights) }),
        },
      });
    },
    async declinePost(target) {
      await postTelegram({
        token: input.token,
        method: "declineSuggestedPost",
        fetchImpl: input.fetchImpl,
        missing: "declinepost_unavailable",
        failed: "declinepost_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_id: telegramId(target.messageId),
          ...(target.comment === undefined ? {} : { comment: target.comment }),
        },
      });
    },
    async declineJoin(target) {
      if (target.queryId) {
        await answerJoinQuery(input, target.queryId, "decline");
        return;
      }
      await postTelegram({
        token: input.token,
        method: "declineChatJoinRequest",
        fetchImpl: input.fetchImpl,
        missing: "decline_unavailable",
        failed: "decline_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
    },
    async deferJoin(target) {
      await answerJoinQuery(input, target.queryId, "queue");
    },
    async banSenderChat(target) {
      await postTelegram({
        token: input.token,
        method: "banChatSenderChat",
        fetchImpl: input.fetchImpl,
        missing: "sender_unavailable",
        failed: "sender_failed",
        body: {
          chat_id: telegramId(target.chatId),
          sender_chat_id: telegramId(target.senderChatId),
        },
      });
    },
    async unbanSenderChat(target) {
      await postTelegram({
        token: input.token,
        method: "unbanChatSenderChat",
        fetchImpl: input.fetchImpl,
        missing: "unban_sender_unavailable",
        failed: "unban_sender_failed",
        body: {
          chat_id: telegramId(target.chatId),
          sender_chat_id: telegramId(target.senderChatId),
        },
      });
    },
    async banActor(target) {
      await postTelegram({
        token: input.token,
        method: "banChatMember",
        fetchImpl: input.fetchImpl,
        missing: "ban_unavailable",
        failed: "ban_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          revoke_messages: false,
        },
      });
    },
    async banActorFor(target) {
      await postTelegram({
        token: input.token,
        method: "banChatMember",
        fetchImpl: input.fetchImpl,
        missing: "banfor_unavailable",
        failed: "banfor_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          revoke_messages: false,
          until_date:
            (input.nowSeconds ?? unixSeconds)() +
            restrictionSeconds(target.durationSeconds),
        },
      });
    },
    async unbanActor(target) {
      await postTelegram({
        token: input.token,
        method: "unbanChatMember",
        fetchImpl: input.fetchImpl,
        missing: "unban_unavailable",
        failed: "unban_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          only_if_banned: true,
        },
      });
    },
    async kickActor(target): Promise<KickResult> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "kick_unavailable",
        failed: "kick_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      const place = kickPlace(member, target.actorId);
      if (place !== "in") {
        return place;
      }
      await postTelegram({
        token: input.token,
        method: "unbanChatMember",
        fetchImpl: input.fetchImpl,
        missing: "kick_unavailable",
        failed: "kick_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      return "removed";
    },
    async unmuteActor(target): Promise<UnmuteResult> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "unmute_unavailable",
        failed: "unmute_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      if (memberStatus(member) !== "restricted") {
        return "absent";
      }
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "unmute_unavailable",
        failed: "unmute_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          permissions: speaking,
          use_independent_chat_permissions: true,
        },
      });
      return "lifted";
    },
    async readMember(target): Promise<MemberStanding> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "member_unavailable",
        failed: "member_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      return readStanding(member);
    },
    async readMemberAllows(target): Promise<MemberAllows> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "allows_unavailable",
        failed: "allows_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      return readMemberAllowsValue(member, target.actorId);
    },
    async readMemberAdmin(target): Promise<MemberAdmin> {
      const member = await postTelegram({
        token: input.token,
        method: "getChatMember",
        fetchImpl: input.fetchImpl,
        missing: "canadmin_unavailable",
        failed: "canadmin_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      return readMemberAdminValue(member, target.actorId);
    },
    async readPermissions(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "perms_unavailable",
        failed: "perms_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readDefaultPermissions(chat);
    },
    async readChatGuard(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "guard_unavailable",
        failed: "guard_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readChatGuardValue(chat, target.chatId);
    },
    async readJoinBot(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "joinbot_unavailable",
        failed: "joinbot_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readJoinBotValue(chat, target.chatId);
    },
    async readReactions(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "reactions_unavailable",
        failed: "reactions_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readReactionAllowlist(chat, target.chatId);
    },
    async readCommunity(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "community_unavailable",
        failed: "community_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readChatCommunity(chat, target.chatId);
    },
    async readStickerSetRight(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "canstickers_unavailable",
        failed: "canstickers_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readStickerSetRightValue(chat, target.chatId);
    },
    async readParentChat(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "parent_unavailable",
        failed: "parent_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readParentChatValue(chat, target.chatId);
    },
    async readPersonalChat(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "personal_unavailable",
        failed: "personal_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readPersonalChatValue(chat, target.chatId);
    },
    async readPrivatePrivacy(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChat",
        fetchImpl: input.fetchImpl,
        missing: "privacy_unavailable",
        failed: "privacy_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return readPrivatePrivacyValue(chat, target.chatId);
    },
    async readAdministrators(target) {
      const chat = await postTelegram({
        token: input.token,
        method: "getChatAdministrators",
        fetchImpl: input.fetchImpl,
        missing: "admins_unavailable",
        failed: "admins_failed",
        body: {
          chat_id: telegramId(target.chatId),
          return_bots: true,
        },
      });
      return administratorList(chat);
    },
    async clearReactions(target) {
      await postTelegram({
        token: input.token,
        method: "deleteAllMessageReactions",
        fetchImpl: input.fetchImpl,
        missing: "reactions_unavailable",
        failed: "reactions_failed",
        body: {
          chat_id: telegramId(target.chatId),
          ...(target.kind === "user"
            ? { user_id: telegramId(target.actorId) }
            : { actor_chat_id: telegramId(target.actorId) }),
        },
      });
    },
    async revokeInvite(target) {
      if (!acceptedInvite(target.inviteLink)) {
        throw new Error("revoke_failed");
      }
      await postTelegram({
        token: input.token,
        method: "revokeChatInviteLink",
        fetchImpl: input.fetchImpl,
        missing: "revoke_unavailable",
        failed: "revoke_failed",
        body: {
          chat_id: telegramId(target.chatId),
          invite_link: target.inviteLink,
        },
      });
    },
    async restrictActor(target) {
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "restrict_unavailable",
        failed: "restrict_failed",
        body: silencedUntil(target, input.nowSeconds ?? unixSeconds),
      });
    },
    async releaseActor(target) {
      await postTelegram({
        token: input.token,
        method: "restrictChatMember",
        fetchImpl: input.fetchImpl,
        missing: "restrict_unavailable",
        failed: "restrict_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          permissions: speaking,
          use_independent_chat_permissions: true,
        },
      });
    },
    async lockChat(target) {
      await postTelegram({
        token: input.token,
        method: "setChatPermissions",
        fetchImpl: input.fetchImpl,
        missing: "lock_unavailable",
        failed: "lock_failed",
        body: {
          chat_id: telegramId(target.chatId),
          permissions: silenced,
          use_independent_chat_permissions: true,
        },
      });
    },
    async unlockChat(target) {
      await postTelegram({
        token: input.token,
        method: "setChatPermissions",
        fetchImpl: input.fetchImpl,
        missing: "unlock_unavailable",
        failed: "unlock_failed",
        body: {
          chat_id: telegramId(target.chatId),
          permissions: speaking,
          use_independent_chat_permissions: true,
        },
      });
    },
    async unpinChat(target) {
      await postTelegram({
        token: input.token,
        method: "unpinAllChatMessages",
        fetchImpl: input.fetchImpl,
        missing: "unpin_unavailable",
        failed: "unpin_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
    },
    async unpinTopic(target) {
      const threadId = target.threadId;
      await postTelegram({
        token: input.token,
        method:
          threadId === undefined
            ? "unpinAllGeneralForumTopicMessages"
            : "unpinAllForumTopicMessages",
        fetchImpl: input.fetchImpl,
        missing: "untopic_unavailable",
        failed: "untopic_failed",
        body: {
          chat_id: telegramId(target.chatId),
          ...(threadId === undefined
            ? {}
            : { message_thread_id: telegramId(threadId) }),
        },
      });
    },
    async closeTopic(target) {
      const threadId = target.threadId;
      await postTelegram({
        token: input.token,
        method:
          threadId === undefined ? "closeGeneralForumTopic" : "closeForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "closetopic_unavailable",
        failed: "closetopic_failed",
        body: {
          chat_id: telegramId(target.chatId),
          ...(threadId === undefined
            ? {}
            : { message_thread_id: telegramId(threadId) }),
        },
      });
    },
    async openTopic(target) {
      const threadId = target.threadId;
      await postTelegram({
        token: input.token,
        method:
          threadId === undefined
            ? "reopenGeneralForumTopic"
            : "reopenForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "opentopic_unavailable",
        failed: "opentopic_failed",
        body: {
          chat_id: telegramId(target.chatId),
          ...(threadId === undefined
            ? {}
            : { message_thread_id: telegramId(threadId) }),
        },
      });
    },
    async hideGeneral(target) {
      await postTelegram({
        token: input.token,
        method: "hideGeneralForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "hidegeneral_unavailable",
        failed: "hidegeneral_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
    },
    async showGeneral(target) {
      await postTelegram({
        token: input.token,
        method: "unhideGeneralForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "showgeneral_unavailable",
        failed: "showgeneral_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
    },
    async deleteTopic(target) {
      await postTelegram({
        token: input.token,
        method: "deleteForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "deltopic_unavailable",
        failed: "deltopic_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_thread_id: telegramId(target.threadId),
        },
      });
    },
    async readMemberCount(target) {
      const body = await postTelegram({
        token: input.token,
        method: "getChatMemberCount",
        fetchImpl: input.fetchImpl,
        missing: "count_unavailable",
        failed: "count_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
      return memberCount(body);
    },
    async readDefaultRights(query) {
      const rights = await postTelegram({
        token: input.token,
        method: "getMyDefaultAdministratorRights",
        fetchImpl: input.fetchImpl,
        missing: "botrights_unavailable",
        failed: "botrights_failed",
        body: query.forChannels ? { for_channels: true } : {},
      });
      return readDefaultRightsSnapshot(rights);
    },
    async readCommandMenu() {
      const menu = await postTelegram({
        token: input.token,
        method: "getMyCommands",
        fetchImpl: input.fetchImpl,
        missing: "commands_unavailable",
        failed: "commands_failed",
        body: { scope: { type: "all_private_chats" } },
      });
      return readCommandMenuSnapshot(menu);
    },
    async readMenuButton() {
      const button = await postTelegram({
        token: input.token,
        method: "getChatMenuButton",
        fetchImpl: input.fetchImpl,
        missing: "button_unavailable",
        failed: "button_failed",
        body: {},
      });
      return readMenuButtonState(button);
    },
    async readBotName() {
      const named = await postTelegram({
        token: input.token,
        method: "getMyName",
        fetchImpl: input.fetchImpl,
        missing: "myname_unavailable",
        failed: "myname_failed",
        body: {},
      });
      return readBotNameValue(named);
    },
    async readBotDescription() {
      const described = await postTelegram({
        token: input.token,
        method: "getMyDescription",
        fetchImpl: input.fetchImpl,
        missing: "mydesc_unavailable",
        failed: "mydesc_failed",
        body: {},
      });
      return readBotDescriptionValue(described);
    },
    async readBotShortDescription() {
      const described = await postTelegram({
        token: input.token,
        method: "getMyShortDescription",
        fetchImpl: input.fetchImpl,
        missing: "myshort_unavailable",
        failed: "myshort_failed",
        body: {},
      });
      return readBotShortDescriptionValue(described);
    },
    async readBotIdentity() {
      const identity = await postTelegram({
        token: input.token,
        method: "getMe",
        fetchImpl: input.fetchImpl,
        missing: "who_unavailable",
        failed: "who_failed",
        body: {},
      });
      return readBotIdentityValue(identity);
    },
    async readWebhook() {
      const info = await postTelegram({
        token: input.token,
        method: "getWebhookInfo",
        fetchImpl: input.fetchImpl,
        missing: "hook_unavailable",
        failed: "hook_failed",
        body: {},
      });
      return readWebhookSnapshot(info);
    },
    async readBoostCount(target) {
      const body = await postTelegram({
        token: input.token,
        method: "getUserChatBoosts",
        fetchImpl: input.fetchImpl,
        missing: "boosts_unavailable",
        failed: "boosts_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
        },
      });
      return boostCount(body);
    },
    async pinMessage(target) {
      await postTelegram({
        token: input.token,
        method: "pinChatMessage",
        fetchImpl: input.fetchImpl,
        missing: "pin_unavailable",
        failed: "pin_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_id: telegramId(target.messageId),
        },
      });
    },
    async unpinMessage(target) {
      await postTelegram({
        token: input.token,
        method: "unpinChatMessage",
        fetchImpl: input.fetchImpl,
        missing: "unpinmsg_unavailable",
        failed: "unpinmsg_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_id: telegramId(target.messageId),
        },
      });
    },
    async removeReaction(target) {
      await postTelegram({
        token: input.token,
        method: "deleteMessageReaction",
        fetchImpl: input.fetchImpl,
        missing: "unreact_unavailable",
        failed: "unreact_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_id: telegramId(target.messageId),
          ...(target.kind === "user"
            ? { user_id: telegramId(target.actorId) }
            : { actor_chat_id: telegramId(target.actorId) }),
        },
      });
    },
    async deletePhoto(target) {
      await postTelegram({
        token: input.token,
        method: "deleteChatPhoto",
        fetchImpl: input.fetchImpl,
        missing: "delphoto_unavailable",
        failed: "delphoto_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
    },
    async leaveChat(target) {
      await postTelegram({
        token: input.token,
        method: "leaveChat",
        fetchImpl: input.fetchImpl,
        missing: "leave_unavailable",
        failed: "leave_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
    },
    async setAdminTitle(target) {
      await postTelegram({
        token: input.token,
        method: "setChatAdministratorCustomTitle",
        fetchImpl: input.fetchImpl,
        missing: "admintitle_unavailable",
        failed: "admintitle_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          custom_title: target.title,
        },
      });
    },
    async setMemberTag(target) {
      await postTelegram({
        token: input.token,
        method: "setChatMemberTag",
        fetchImpl: input.fetchImpl,
        missing: "tag_unavailable",
        failed: "tag_failed",
        body: {
          chat_id: telegramId(target.chatId),
          user_id: telegramId(target.actorId),
          tag: target.tag,
        },
      });
    },
    async deleteStickerSet(target) {
      await postTelegram({
        token: input.token,
        method: "deleteChatStickerSet",
        fetchImpl: input.fetchImpl,
        missing: "delstickers_unavailable",
        failed: "delstickers_failed",
        body: {
          chat_id: telegramId(target.chatId),
        },
      });
    },
    async setStickerSet(target) {
      await postTelegram({
        token: input.token,
        method: "setChatStickerSet",
        fetchImpl: input.fetchImpl,
        missing: "stickers_unavailable",
        failed: "stickers_failed",
        body: {
          chat_id: telegramId(target.chatId),
          sticker_set_name: target.name,
        },
      });
    },
    async setReaction(target) {
      await postTelegram({
        token: input.token,
        method: "setMessageReaction",
        fetchImpl: input.fetchImpl,
        missing: "react_unavailable",
        failed: "react_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_id: telegramId(target.messageId),
          reaction: [{ type: "emoji", emoji: target.emoji }],
        },
      });
    },
    async setTitle(target) {
      await postTelegram({
        token: input.token,
        method: "setChatTitle",
        fetchImpl: input.fetchImpl,
        missing: "title_unavailable",
        failed: "title_failed",
        body: {
          chat_id: telegramId(target.chatId),
          title: target.title,
        },
      });
    },
    async setDescription(target) {
      await postTelegram({
        token: input.token,
        method: "setChatDescription",
        fetchImpl: input.fetchImpl,
        missing: "desc_unavailable",
        failed: "desc_failed",
        body: {
          chat_id: telegramId(target.chatId),
          description: target.description,
        },
      });
    },
    async createTopic(target) {
      const body = await postTelegram({
        token: input.token,
        method: "createForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "newtopic_unavailable",
        failed: "newtopic_failed",
        body: {
          chat_id: telegramId(target.chatId),
          name: target.name,
        },
      });
      return createdTopicId(body);
    },
    async renameTopic(target) {
      await postTelegram({
        token: input.token,
        method: "editForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "rentopic_unavailable",
        failed: "rentopic_failed",
        body: {
          chat_id: telegramId(target.chatId),
          message_thread_id: telegramId(target.threadId),
          name: target.name,
        },
      });
    },
    async renameGeneral(target) {
      await postTelegram({
        token: input.token,
        method: "editGeneralForumTopic",
        fetchImpl: input.fetchImpl,
        missing: "rengeneral_unavailable",
        failed: "rengeneral_failed",
        body: {
          chat_id: telegramId(target.chatId),
          name: target.name,
        },
      });
    },
  };
}

export async function sendCaptchaButton(input: {
  readonly token: string | undefined;
  readonly chatId: string;
  readonly nonce: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (!/^[a-f0-9]{16}$/.test(input.nonce)) {
    throw new Error("captcha_prompt_failed");
  }
  const body = await postTelegram({
    token: input.token,
    method: "sendMessage",
    fetchImpl: input.fetchImpl,
    missing: "captcha_prompt_failed",
    failed: "captcha_prompt_failed",
    body: {
      chat_id: telegramId(input.chatId),
      text: captchaPrompt,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [{ text: "我不是机器人", callback_data: `c:${input.nonce}` }],
        ],
      },
    },
  });
  return readTelegramMessageId(body);
}

function readTelegramMessageId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    return null;
  }
  const result = body.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("message_id" in result)
  ) {
    return null;
  }
  const id = result.message_id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  const text = String(id);
  return /^[1-9][0-9]{0,15}$/.test(text) ? text : null;
}

export async function answerCallbackQuery(input: {
  readonly token: string | undefined;
  readonly callbackId: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<void> {
  await postTelegram({
    token: input.token,
    method: "answerCallbackQuery",
    fetchImpl: input.fetchImpl,
    missing: "callback_unavailable",
    failed: "callback_failed",
    body: { callback_query_id: input.callbackId },
  });
}

async function answerJoinQuery(
  input: {
    readonly token: string | undefined;
    readonly fetchImpl?: typeof fetch;
  },
  queryId: string,
  result: "decline" | "queue",
): Promise<void> {
  await postTelegram({
    token: input.token,
    method: "answerChatJoinRequestQuery",
    fetchImpl: input.fetchImpl,
    missing: "decline_unavailable",
    failed: "decline_failed",
    body: {
      chat_join_request_query_id: queryId,
      result,
    },
  });
}

function acceptedInvite(value: string): boolean {
  const match =
    /^https:\/\/(t\.me|telegram\.me|telegram\.dog)\/(?:\+([A-Za-z0-9_-]{16,128})|joinchat\/([A-Za-z0-9_-]{16,128}))$/.exec(
      value,
    );
  const code = match?.[2] ?? match?.[3];
  return code !== undefined && !/^\d+$/.test(code);
}

async function postTelegram(input: {
  readonly token: string | undefined;
  readonly method: string;
  readonly body: unknown;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly missing: string;
  readonly failed: string;
}): Promise<unknown> {
  const token = input.token?.trim() ?? "";
  if (token.length === 0) {
    throw new Error(input.missing);
  }
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(
      `https://api.telegram.org/bot${token}/${input.method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.body),
      },
    );
  } catch {
    throw new Error(input.failed);
  }
  if (!response.ok) {
    throw new Error(input.failed);
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const minimumRestrictionSeconds = 30;
const maximumRestrictionSeconds = 366 * 24 * 60 * 60;

function restrictionSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds)) {
    return minimumRestrictionSeconds;
  }
  const seconds = Math.floor(durationSeconds);
  if (seconds < minimumRestrictionSeconds) {
    return minimumRestrictionSeconds;
  }
  if (seconds > maximumRestrictionSeconds) {
    return maximumRestrictionSeconds;
  }
  return seconds;
}

function silencedUntil(
  target: MuteTarget,
  nowSeconds: () => number,
): {
  readonly chat_id: string | number;
  readonly user_id: string | number;
  readonly permissions: typeof silenced;
  readonly until_date: number;
  readonly use_independent_chat_permissions: true;
} {
  return {
    chat_id: telegramId(target.chatId),
    user_id: telegramId(target.actorId),
    permissions: silenced,
    until_date: nowSeconds() + restrictionSeconds(target.durationSeconds),
    use_independent_chat_permissions: true,
  };
}

function readChatGuardValue(body: unknown, chatId: string): ChatGuard {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("guard_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("guard_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("guard_failed");
  }
  const type = record.type;
  if (
    type !== "private" &&
    type !== "group" &&
    type !== "supergroup" &&
    type !== "channel"
  ) {
    throw new Error("guard_failed");
  }
  return {
    type,
    forum: readGuardFlag(record.is_forum),
    directMessages: readGuardFlag(record.is_direct_messages),
    joinByRequest: readGuardFlag(record.join_by_request),
    joinToSend: readGuardFlag(record.join_to_send_messages),
    nativeAntiSpam: readGuardFlag(record.has_aggressive_anti_spam_enabled),
    slowModeSeconds: readGuardCount(record.slow_mode_delay),
    autoDeleteSeconds: readGuardCount(record.message_auto_delete_time),
    boostExemption: readGuardCount(record.unrestrict_boost_count),
    protectedContent: readGuardFlag(record.has_protected_content),
    hiddenMembers: readGuardFlag(record.has_hidden_members),
    visibleHistory: readGuardFlag(record.has_visible_history),
    maxReactions: readGuardRequiredCount(record.max_reaction_count),
    linkedChatId: readLinkedChat(record.linked_chat_id),
  };
}

function readGuardFlag(value: unknown): PermissionState {
  if (value === undefined) {
    return "unknown";
  }
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  throw new Error("guard_failed");
}

function readGuardCount(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("guard_failed");
  }
  return value;
}

function readGuardRequiredCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("guard_failed");
  }
  return value;
}

function readLinkedChat(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("guard_failed");
  }
  const id = String(value);
  if (!/^-?\d{1,20}$/.test(id)) {
    throw new Error("guard_failed");
  }
  return id;
}

function readJoinBotValue(body: unknown, chatId: string): JoinBot {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("joinbot_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("joinbot_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("joinbot_failed");
  }
  return readGuardBot(record.guard_bot);
}

function readGuardBot(value: unknown): JoinBot {
  if (value === undefined) {
    return { id: null, username: null };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("joinbot_failed");
  }
  const user = value as Record<string, unknown>;
  if (user.is_bot !== true) {
    throw new Error("joinbot_failed");
  }
  const id = user.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("joinbot_failed");
  }
  return {
    id: String(id),
    username: readJoinBotUsername(user.username),
  };
}

const chatKinds = new Set(["private", "group", "supergroup", "channel"]);

function readParentChatValue(body: unknown, chatId: string): ParentChat {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("parent_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("parent_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("parent_failed");
  }
  return { id: readParentChatId(record.parent_chat) };
}

function readPersonalChatValue(body: unknown, chatId: string): PersonalChat {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("personal_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("personal_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("personal_failed");
  }
  return { id: readPersonalChatId(record.personal_chat) };
}

function readPersonalChatId(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("personal_failed");
  }
  const chat = value as Record<string, unknown>;
  if (typeof chat.type !== "string" || !chatKinds.has(chat.type)) {
    throw new Error("personal_failed");
  }
  const id = chat.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new Error("personal_failed");
  }
  const text = String(id);
  if (!/^-?\d{1,20}$/.test(text)) {
    throw new Error("personal_failed");
  }
  return text;
}

function readParentChatId(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("parent_failed");
  }
  const chat = value as Record<string, unknown>;
  if (typeof chat.type !== "string" || !chatKinds.has(chat.type)) {
    throw new Error("parent_failed");
  }
  const id = chat.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new Error("parent_failed");
  }
  const text = String(id);
  if (!/^-?\d{1,20}$/.test(text)) {
    throw new Error("parent_failed");
  }
  return text;
}

function readPrivatePrivacyValue(
  body: unknown,
  chatId: string,
): PrivatePrivacy {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("privacy_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("privacy_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("privacy_failed");
  }
  return {
    privateForwards: readPrivacyFlag(record.has_private_forwards),
    restrictedVoice: readPrivacyFlag(
      record.has_restricted_voice_and_video_messages,
    ),
  };
}

function readPrivacyFlag(value: unknown): PermissionState {
  if (value === undefined) {
    return "unknown";
  }
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  throw new Error("privacy_failed");
}

function readStickerSetRightValue(
  body: unknown,
  chatId: string,
): StickerSetRight {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("canstickers_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("canstickers_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("canstickers_failed");
  }
  return { canSet: readCanSetStickerSet(record.can_set_sticker_set) };
}

function readCanSetStickerSet(value: unknown): PermissionState {
  if (value === undefined) {
    return "unknown";
  }
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  throw new Error("canstickers_failed");
}

function readChatCommunity(body: unknown, chatId: string): ChatCommunity {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("community_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("community_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("community_failed");
  }
  return { id: readCommunityId(record.community) };
}

function readCommunityId(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("community_failed");
  }
  const community = value as Record<string, unknown>;
  if (typeof community.name !== "string") {
    throw new Error("community_failed");
  }
  const id = community.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("community_failed");
  }
  const text = String(id);
  if (!/^[1-9]\d{0,15}$/.test(text)) {
    throw new Error("community_failed");
  }
  return text;
}

function readReactionAllowlist(
  body: unknown,
  chatId: string,
): ReactionAllowlist {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("reactions_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("reactions_failed");
  }
  const record = result as Record<string, unknown>;
  const id = record.id;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    String(id) !== chatId
  ) {
    throw new Error("reactions_failed");
  }
  return { count: readAvailableReactions(record.available_reactions) };
}

function readAvailableReactions(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw new Error("reactions_failed");
  }
  for (const item of value) {
    readReactionType(item);
  }
  return value.length;
}

function readReactionType(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("reactions_failed");
  }
  const record = value as Record<string, unknown>;
  if (record.type === "emoji") {
    if (typeof record.emoji !== "string") {
      throw new Error("reactions_failed");
    }
    return;
  }
  if (record.type === "custom_emoji") {
    if (
      typeof record.custom_emoji_id !== "string" ||
      record.custom_emoji_id.length === 0
    ) {
      throw new Error("reactions_failed");
    }
    return;
  }
  if (record.type === "paid") {
    return;
  }
  throw new Error("reactions_failed");
}

function readJoinBotUsername(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(value)) {
    throw new Error("joinbot_failed");
  }
  return value;
}

function readDefaultPermissions(body: unknown): DefaultChatPermissions {
  const permissions = chatResult(body).permissions;
  if (
    typeof permissions !== "object" ||
    permissions === null ||
    Array.isArray(permissions)
  ) {
    throw new Error("perms_failed");
  }
  const raw = permissions as Record<string, unknown>;
  const flag = (key: string): boolean | undefined => {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) {
      return undefined;
    }
    const value = raw[key];
    if (typeof value !== "boolean") {
      throw new Error("perms_failed");
    }
    return value;
  };
  const state = (
    value: boolean | undefined,
    fallback?: boolean,
  ): PermissionState => {
    const chosen = value ?? fallback;
    if (chosen === undefined) {
      return "unknown";
    }
    return chosen ? "on" : "off";
  };
  const messages = flag("can_send_messages");
  const pin = flag("can_pin_messages");
  return {
    sendMessages: state(messages),
    sendAudios: state(flag("can_send_audios")),
    sendDocuments: state(flag("can_send_documents")),
    sendPhotos: state(flag("can_send_photos")),
    sendVideos: state(flag("can_send_videos")),
    sendVideoNotes: state(flag("can_send_video_notes")),
    sendVoiceNotes: state(flag("can_send_voice_notes")),
    sendPolls: state(flag("can_send_polls")),
    sendOtherMessages: state(flag("can_send_other_messages")),
    addWebPagePreviews: state(flag("can_add_web_page_previews")),
    reactToMessages: state(flag("can_react_to_messages"), messages),
    editTag: state(flag("can_edit_tag"), pin),
    changeInfo: state(flag("can_change_info")),
    inviteUsers: state(flag("can_invite_users")),
    pinMessages: state(pin),
    manageTopics: state(flag("can_manage_topics"), pin),
  };
}

function telegramDefaultRights(
  rights: DefaultAdministratorRights,
): Record<string, boolean> {
  return {
    is_anonymous: rights.anonymous,
    can_manage_chat: rights.manageChat,
    can_delete_messages: rights.deleteMessages,
    can_manage_video_chats: rights.manageVideoChats,
    can_restrict_members: rights.restrictMembers,
    can_promote_members: rights.promoteMembers,
    can_change_info: rights.changeInfo,
    can_invite_users: rights.inviteUsers,
    can_post_stories: rights.postStories,
    can_edit_stories: rights.editStories,
    can_delete_stories: rights.deleteStories,
    can_post_messages: rights.postMessages,
    can_edit_messages: rights.editMessages,
    can_pin_messages: rights.pinMessages,
    can_manage_topics: rights.manageTopics,
    can_manage_direct_messages: rights.manageDirectMessages,
    can_manage_tags: rights.manageTags,
    can_send_welcome_messages: rights.sendWelcomeMessages,
  };
}

function readBotIdentityValue(body: unknown): BotIdentity {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("who_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("who_failed");
  }
  const record = result as Record<string, unknown>;
  if (record.is_bot !== true) {
    throw new Error("who_failed");
  }
  const id = record.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error("who_failed");
  }
  const username = readBotUsername(record.username);
  return {
    id: String(id),
    username,
    joinGroups: readBotFlag(record.can_join_groups),
    readAllGroupMessages: readBotFlag(record.can_read_all_group_messages),
    guestQueries: readBotFlag(record.supports_guest_queries),
    joinRequestQueries: readBotFlag(record.supports_join_request_queries),
  };
}

function readBotUsername(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,32}$/.test(value)) {
    throw new Error("who_failed");
  }
  return value;
}

function readBotFlag(value: unknown): PermissionState {
  if (value === undefined) {
    return "unknown";
  }
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  throw new Error("who_failed");
}

function readWebhookSnapshot(body: unknown): WebhookSnapshot {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("hook_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("hook_failed");
  }
  const record = result as Record<string, unknown>;
  return {
    pendingUpdateCount: readPendingCount(record.pending_update_count),
    customCertificate: readWebhookFlag(record.has_custom_certificate),
    maxConnections: readMaxConnections(record.max_connections),
    lastErrorDate: readLastErrorDate(record.last_error_date),
  };
}

function readPendingCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("hook_failed");
  }
  return value;
}

function readWebhookFlag(value: unknown): PermissionState {
  if (value === undefined) {
    return "unknown";
  }
  if (value === true) {
    return "on";
  }
  if (value === false) {
    return "off";
  }
  throw new Error("hook_failed");
}

function readMaxConnections(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 100
  ) {
    throw new Error("hook_failed");
  }
  return value;
}

function readLastErrorDate(value: unknown): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("hook_failed");
  }
  return value;
}

function readBotShortDescriptionValue(body: unknown): string {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("myshort_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("myshort_failed");
  }
  const shortDescription = (result as Record<string, unknown>)
    .short_description;
  if (
    typeof shortDescription !== "string" ||
    shortDescription.length > 120 ||
    /[\r\n]/.test(shortDescription)
  ) {
    throw new Error("myshort_failed");
  }
  return shortDescription;
}

function readBotDescriptionValue(body: unknown): string {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("mydesc_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("mydesc_failed");
  }
  const description = (result as Record<string, unknown>).description;
  if (
    typeof description !== "string" ||
    description.length > 512 ||
    /[\r\n]/.test(description)
  ) {
    throw new Error("mydesc_failed");
  }
  return description;
}

function readBotNameValue(body: unknown): string {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("myname_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("myname_failed");
  }
  const name = (result as Record<string, unknown>).name;
  if (typeof name !== "string" || name.length > 64 || /[\r\n]/.test(name)) {
    throw new Error("myname_failed");
  }
  return name;
}

function readMenuButtonState(body: unknown): MenuButtonState {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("button_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("button_failed");
  }
  const type = (result as Record<string, unknown>).type;
  if (type === "commands" || type === "default" || type === "web_app") {
    return type;
  }
  throw new Error("button_failed");
}

function readCommandMenuSnapshot(
  body: unknown,
): readonly MenuCommandSnapshot[] {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("commands_failed");
  }
  const result = body.result;
  if (!Array.isArray(result) || result.length > 100) {
    throw new Error("commands_failed");
  }
  const seen = new Set<string>();
  const commands: MenuCommandSnapshot[] = [];
  for (const item of result) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("commands_failed");
    }
    const raw = item as Record<string, unknown>;
    const command = raw.command;
    const description = raw.description;
    if (
      typeof command !== "string" ||
      !/^[a-z0-9_]{1,32}$/.test(command) ||
      seen.has(command)
    ) {
      throw new Error("commands_failed");
    }
    if (
      typeof description !== "string" ||
      description.length < 1 ||
      description.length > 256 ||
      /[\n\r]/.test(description)
    ) {
      throw new Error("commands_failed");
    }
    let ephemeral: MenuCommandSnapshot["ephemeral"];
    if (!Object.hasOwn(raw, "is_ephemeral") || raw.is_ephemeral === undefined) {
      ephemeral = "unknown";
    } else if (typeof raw.is_ephemeral !== "boolean") {
      throw new Error("commands_failed");
    } else {
      ephemeral = raw.is_ephemeral ? "on" : "off";
    }
    seen.add(command);
    commands.push({ command, description, ephemeral });
  }
  return commands;
}

function readDefaultRightsSnapshot(body: unknown): DefaultRightsSnapshot {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("botrights_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("botrights_failed");
  }
  const raw = result as Record<string, unknown>;
  const flag = (key: string): PermissionState => {
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) {
      return "unknown";
    }
    const value = raw[key];
    if (typeof value !== "boolean") {
      throw new Error("botrights_failed");
    }
    return value ? "on" : "off";
  };
  return {
    anonymous: flag("is_anonymous"),
    manageChat: flag("can_manage_chat"),
    deleteMessages: flag("can_delete_messages"),
    manageVideoChats: flag("can_manage_video_chats"),
    restrictMembers: flag("can_restrict_members"),
    promoteMembers: flag("can_promote_members"),
    changeInfo: flag("can_change_info"),
    inviteUsers: flag("can_invite_users"),
    postStories: flag("can_post_stories"),
    editStories: flag("can_edit_stories"),
    deleteStories: flag("can_delete_stories"),
    postMessages: flag("can_post_messages"),
    editMessages: flag("can_edit_messages"),
    pinMessages: flag("can_pin_messages"),
    manageTopics: flag("can_manage_topics"),
    manageDirectMessages: flag("can_manage_direct_messages"),
    manageTags: flag("can_manage_tags"),
    sendWelcomeMessages: flag("can_send_welcome_messages"),
  };
}

const administratorFields = [
  ["can_manage_chat", "manageChat"],
  ["can_delete_messages", "deleteMessages"],
  ["can_manage_video_chats", "manageVideoChats"],
  ["can_restrict_members", "restrictMembers"],
  ["can_promote_members", "promoteMembers"],
  ["can_change_info", "changeInfo"],
  ["can_invite_users", "inviteUsers"],
  ["can_post_stories", "postStories"],
  ["can_edit_stories", "editStories"],
  ["can_delete_stories", "deleteStories"],
  ["can_post_messages", "postMessages"],
  ["can_edit_messages", "editMessages"],
  ["can_pin_messages", "pinMessages"],
  ["can_manage_topics", "manageTopics"],
  ["can_manage_direct_messages", "manageDirectMessages"],
  ["can_manage_tags", "manageTags"],
  ["can_send_welcome_messages", "sendWelcomeMessages"],
] as const satisfies ReadonlyArray<readonly [string, AdministratorRight]>;

function administratorList(body: unknown): ChatAdministrator[] {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("admins_failed");
  }
  const result = body.result;
  if (!Array.isArray(result)) {
    throw new Error("admins_failed");
  }
  return result.map((item) => oneAdministrator(item));
}

function memberCount(body: unknown): number {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("count_failed");
  }
  const result = body.result;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < 0
  ) {
    throw new Error("count_failed");
  }
  return result;
}

function createdTopicId(body: unknown): string {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("newtopic_failed");
  }
  const result = body.result;
  if (
    typeof result !== "object" ||
    result === null ||
    !("message_thread_id" in result)
  ) {
    throw new Error("newtopic_failed");
  }
  const threadId = result.message_thread_id;
  if (
    typeof threadId !== "number" ||
    !Number.isSafeInteger(threadId) ||
    threadId <= 0
  ) {
    throw new Error("newtopic_failed");
  }
  return String(threadId);
}

function boostCount(body: unknown): number {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("boosts_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || !("boosts" in result)) {
    throw new Error("boosts_failed");
  }
  const boosts = result.boosts;
  if (!Array.isArray(boosts)) {
    throw new Error("boosts_failed");
  }
  return boosts.length;
}

function oneAdministrator(item: unknown): ChatAdministrator {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw new Error("admins_failed");
  }
  const record = item as Record<string, unknown>;
  const role = record.status;
  if (role !== "creator" && role !== "administrator") {
    throw new Error("admins_failed");
  }
  const user = record.user;
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    throw new Error("admins_failed");
  }
  const profile = user as Record<string, unknown>;
  const actorId = administratorId(profile.id);
  if (actorId === undefined) {
    throw new Error("admins_failed");
  }
  return {
    actorId,
    bot: profile.is_bot === true,
    role,
    anonymous: record.is_anonymous === true,
    rights: role === "creator" ? [] : turnedOnRights(record),
  };
}

function administratorId(id: unknown): string | undefined {
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
    return String(id);
  }
  if (typeof id === "string" && /^[1-9]\d{0,15}$/.test(id)) {
    return id;
  }
  return undefined;
}

function turnedOnRights(
  record: Record<string, unknown>,
): readonly AdministratorRight[] {
  const rights: AdministratorRight[] = [];
  for (const [field, right] of administratorFields) {
    if (record[field] === true) {
      rights.push(right);
    }
  }
  return rights;
}

function chatResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("perms_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("perms_failed");
  }
  return result as Record<string, unknown>;
}

const allowsFlagKeys = [
  ["can_send_messages", "sendMessages"],
  ["can_send_audios", "sendAudios"],
  ["can_send_documents", "sendDocuments"],
  ["can_send_photos", "sendPhotos"],
  ["can_send_videos", "sendVideos"],
  ["can_send_video_notes", "sendVideoNotes"],
  ["can_send_voice_notes", "sendVoiceNotes"],
  ["can_send_polls", "sendPolls"],
  ["can_send_other_messages", "sendOtherMessages"],
  ["can_add_web_page_previews", "addWebPagePreviews"],
  ["can_react_to_messages", "reactToMessages"],
  ["can_edit_tag", "editTag"],
  ["can_change_info", "changeInfo"],
  ["can_invite_users", "inviteUsers"],
  ["can_pin_messages", "pinMessages"],
  ["can_manage_topics", "manageTopics"],
] as const satisfies ReadonlyArray<
  readonly [string, keyof DefaultChatPermissions]
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const requiredAdministratorFields = new Set<string>([
  "can_manage_chat",
  "can_delete_messages",
  "can_manage_video_chats",
  "can_restrict_members",
  "can_promote_members",
  "can_change_info",
  "can_invite_users",
  "can_post_stories",
  "can_edit_stories",
  "can_delete_stories",
  "can_send_welcome_messages",
]);

function kickPlace(body: unknown, actorId: string): "in" | "absent" | "admin" {
  const result = kickMemberResult(body);
  const user = result.user;
  if (
    !isRecord(user) ||
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    String(user.id) !== actorId
  ) {
    throw new Error("kick_failed");
  }
  if (result.status === "creator" || result.status === "administrator") {
    return "admin";
  }
  if (result.status === "left" || result.status === "kicked") {
    return "absent";
  }
  if (result.status === "member") {
    return "in";
  }
  if (result.status === "restricted") {
    return kickStillInChat(result) ? "in" : "absent";
  }
  throw new Error("kick_failed");
}

function kickMemberResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("kick_failed");
  }
  const result = body.result;
  if (!isRecord(result) || typeof result.status !== "string") {
    throw new Error("kick_failed");
  }
  return result;
}

function kickStillInChat(result: Record<string, unknown>): boolean {
  if (!("is_member" in result) || result.is_member === undefined) {
    return true;
  }
  if (typeof result.is_member !== "boolean") {
    throw new Error("kick_failed");
  }
  return result.is_member;
}

function readMemberAdminValue(body: unknown, actorId: string): MemberAdmin {
  const result = memberAdminResult(body);
  const user = result.user;
  if (
    !isRecord(user) ||
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    String(user.id) !== actorId
  ) {
    throw new Error("canadmin_failed");
  }
  if (result.status === "creator") {
    return {
      kind: "admin",
      editable: null,
      admin: {
        actorId,
        bot: user.is_bot === true,
        role: "creator",
        anonymous: requiredAdminFlag(result, "is_anonymous"),
        rights: [],
      },
    };
  }
  if (result.status === "administrator") {
    return {
      kind: "admin",
      editable: requiredAdminFlag(result, "can_be_edited") ? "on" : "off",
      admin: {
        actorId,
        bot: user.is_bot === true,
        role: "administrator",
        anonymous: requiredAdminFlag(result, "is_anonymous"),
        rights: memberAdminRights(result),
      },
    };
  }
  if (
    result.status === "member" ||
    result.status === "restricted" ||
    result.status === "left" ||
    result.status === "kicked"
  ) {
    return { kind: "none" };
  }
  throw new Error("canadmin_failed");
}

function memberAdminResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("canadmin_failed");
  }
  const result = body.result;
  if (!isRecord(result) || typeof result.status !== "string") {
    throw new Error("canadmin_failed");
  }
  return result;
}

function requiredAdminFlag(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error("canadmin_failed");
  }
  return value;
}

function memberAdminRights(
  record: Record<string, unknown>,
): readonly AdministratorRight[] {
  const rights: AdministratorRight[] = [];
  for (const [field, right] of administratorFields) {
    const value = record[field];
    if (value === undefined) {
      if (requiredAdministratorFields.has(field)) {
        throw new Error("canadmin_failed");
      }
      continue;
    }
    if (typeof value !== "boolean") {
      throw new Error("canadmin_failed");
    }
    if (value) {
      rights.push(right);
    }
  }
  return rights;
}

function readMemberAllowsValue(body: unknown, actorId: string): MemberAllows {
  const result = allowsResult(body);
  const user = result.user;
  if (
    !isRecord(user) ||
    typeof user.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    String(user.id) !== actorId
  ) {
    throw new Error("allows_failed");
  }
  if (result.status === "restricted") {
    return {
      kind: "restricted",
      inChat: allowsInChat(result),
      untilDate: allowsExpiry(result),
      permissions: allowsPermissions(result),
    };
  }
  if (
    result.status === "creator" ||
    result.status === "administrator" ||
    result.status === "member" ||
    result.status === "left" ||
    result.status === "kicked"
  ) {
    return { kind: "none" };
  }
  throw new Error("allows_failed");
}

function allowsResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("allows_failed");
  }
  const result = body.result;
  if (!isRecord(result) || typeof result.status !== "string") {
    throw new Error("allows_failed");
  }
  return result;
}

function allowsInChat(result: Record<string, unknown>): boolean {
  if (!("is_member" in result) || result.is_member === undefined) {
    return true;
  }
  if (typeof result.is_member !== "boolean") {
    throw new Error("allows_failed");
  }
  return result.is_member;
}

function allowsExpiry(result: Record<string, unknown>): number | null {
  if (!("until_date" in result) || result.until_date === undefined) {
    return null;
  }
  const value = result.until_date;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("allows_failed");
  }
  return value === 0 ? null : value;
}

function allowsPermissions(
  result: Record<string, unknown>,
): DefaultChatPermissions {
  const permissions = {} as Record<
    keyof DefaultChatPermissions,
    PermissionState
  >;
  for (const [key, field] of allowsFlagKeys) {
    const value = result[key];
    if (typeof value !== "boolean") {
      throw new Error("allows_failed");
    }
    permissions[field] = value ? "on" : "off";
  }
  return permissions;
}

function readStanding(body: unknown): MemberStanding {
  const result = memberResult(body);
  const status = result.status;
  if (
    status === "creator" ||
    status === "administrator" ||
    status === "member" ||
    status === "left"
  ) {
    return { status };
  }
  if (status === "kicked") {
    return { status, untilDate: expiry(result) };
  }
  if (status === "restricted") {
    return {
      status,
      inChat: stillInChat(result),
      untilDate: expiry(result),
    };
  }
  throw new Error("member_failed");
}

function memberResult(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("member_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new Error("member_failed");
  }
  if (typeof result.status !== "string" || result.status.length === 0) {
    throw new Error("member_failed");
  }
  return result;
}

function expiry(result: Record<string, unknown>): number | null {
  if (!("until_date" in result) || result.until_date === undefined) {
    return null;
  }
  const value = result.until_date;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("member_failed");
  }
  return value === 0 ? null : value;
}

function stillInChat(result: Record<string, unknown>): boolean {
  if (!("is_member" in result) || result.is_member === undefined) {
    return true;
  }
  if (typeof result.is_member !== "boolean") {
    throw new Error("member_failed");
  }
  return result.is_member;
}

function memberStatus(body: unknown): "restricted" | "open" {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("unmute_failed");
  }
  const result = body.result;
  if (typeof result !== "object" || result === null || !("status" in result)) {
    throw new Error("unmute_failed");
  }
  if (result.status === "restricted") {
    return "restricted";
  }
  if (typeof result.status === "string" && result.status.length > 0) {
    return "open";
  }
  throw new Error("unmute_failed");
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export type { BanTarget, MuteTarget };
