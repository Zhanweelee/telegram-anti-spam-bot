import { createMemoryModerator } from "@tasb/adapter-memory";
import type { ModerationPort } from "@tasb/core";
import { createTelegramModerator } from "@tasb/platform-telegram";

export function moderatorFor(input: {
  readonly token?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): ModerationPort {
  const token = input.token?.trim() ?? "";
  if (token.length === 0) {
    return createOpenModerator();
  }
  return createTelegramModerator({
    token,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
}

function createOpenModerator(): ModerationPort {
  const memory = createMemoryModerator();
  return {
    deleteMessage: (target) => memory.deleteMessage(target),
    deleteMessages: (target) => memory.deleteMessages(target),
    deleteCommandMenu: (query) => memory.deleteCommandMenu(query),
    muteActor: (target) => memory.muteActor(target),
    banActor: (target) => memory.banActor(target),
    banSenderChat: (target) => memory.banSenderChat(target),
    unbanSenderChat: (target) => memory.unbanSenderChat(target),
    declineJoin: (target) => memory.declineJoin(target),
    declinePost: (target) => memory.declinePost(target),
    setDefaultRights: (target) => memory.setDefaultRights(target),
    setCommandMenu: (target) => memory.setCommandMenu(target),
    setMenuButton: (target) => memory.setMenuButton(target),
    setBotName: (target) => memory.setBotName(target),
    setBotDescription: (target) => memory.setBotDescription(target),
    approveJoin: (target) => memory.approveJoin(target),
    deferJoin: (target) => memory.deferJoin(target),
    async restrictActor() {
      throw new Error("restrict_unavailable");
    },
    async releaseActor() {
      throw new Error("restrict_unavailable");
    },
    lockChat: (target) => memory.lockChat(target),
    unlockChat: (target) => memory.unlockChat(target),
    async unbanActor() {
      throw new Error("unban_unavailable");
    },
    async unmuteActor() {
      throw new Error("unmute_unavailable");
    },
    async readMember() {
      throw new Error("member_unavailable");
    },
    async readPermissions() {
      throw new Error("perms_unavailable");
    },
    async readAdministrators() {
      throw new Error("admins_unavailable");
    },
    async readMemberCount() {
      throw new Error("count_unavailable");
    },
    async readBoostCount() {
      throw new Error("boosts_unavailable");
    },
    async readDefaultRights() {
      throw new Error("botrights_unavailable");
    },
    async readCommandMenu() {
      throw new Error("commands_unavailable");
    },
    async readMenuButton() {
      throw new Error("button_unavailable");
    },
    async readBotName() {
      throw new Error("myname_unavailable");
    },
    async readBotDescription() {
      throw new Error("mydesc_unavailable");
    },
    async createTopic() {
      throw new Error("newtopic_unavailable");
    },
    clearReactions: (target) => memory.clearReactions(target),
    revokeInvite: (target) => memory.revokeInvite(target),
    unpinChat: (target) => memory.unpinChat(target),
    pinMessage: (target) => memory.pinMessage(target),
    unpinMessage: (target) => memory.unpinMessage(target),
    removeReaction: (target) => memory.removeReaction(target),
    deletePhoto: (target) => memory.deletePhoto(target),
    leaveChat: (target) => memory.leaveChat(target),
    setMemberTag: (target) => memory.setMemberTag(target),
    setAdminTitle: (target) => memory.setAdminTitle(target),
    deleteStickerSet: (target) => memory.deleteStickerSet(target),
    setStickerSet: (target) => memory.setStickerSet(target),
    setReaction: (target) => memory.setReaction(target),
    setTitle: (target) => memory.setTitle(target),
    setDescription: (target) => memory.setDescription(target),
    renameTopic: (target) => memory.renameTopic(target),
    renameGeneral: (target) => memory.renameGeneral(target),
    unpinTopic: (target) => memory.unpinTopic(target),
    closeTopic: (target) => memory.closeTopic(target),
    openTopic: (target) => memory.openTopic(target),
    hideGeneral: (target) => memory.hideGeneral(target),
    showGeneral: (target) => memory.showGeneral(target),
    deleteTopic: (target) => memory.deleteTopic(target),
  };
}
