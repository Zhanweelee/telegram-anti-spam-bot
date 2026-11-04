import type { Event, Logger, ModerationPort, PipelineResult } from "@tasb/core";

/** Telegram albums hold at most ten messages. */
const maxSlots = 10;
/** Same isolate cap as other in-memory windows. A full map fails open. */
const maxAlbums = 256;
const albumIdPattern = /^[0-9]{1,20}$/;
const messageIdPattern = /^[1-9][0-9]{0,19}$/;

export interface AlbumSlot {
  readonly messageId: string;
  readonly audienceId?: string;
  readonly paid?: true;
  readonly removed?: true;
}

export interface AlbumNote {
  readonly tenantId: string;
  readonly chatId: string;
  readonly albumId: string;
  readonly messageId: string;
  readonly audienceId?: string;
  readonly paid?: true;
}

export interface AlbumKey {
  readonly tenantId: string;
  readonly chatId: string;
  readonly albumId: string;
}

interface MutableSlot {
  messageId: string;
  audienceId?: string;
  paid?: true;
  removed?: true;
}

interface AlbumRecord {
  readonly slots: MutableSlot[];
  condemned: boolean;
}

export interface AlbumWatch {
  note(input: AlbumNote): readonly AlbumSlot[];
  condemn(input: AlbumKey): void;
  markRemoved(input: AlbumKey & { readonly messageId: string }): void;
  condemned(input: AlbumKey): boolean;
}

function albumKey(input: AlbumKey): string {
  return `${input.tenantId}\n${input.chatId}\n${input.albumId}`;
}

function publish(slot: MutableSlot): AlbumSlot {
  return {
    messageId: slot.messageId,
    ...(slot.audienceId ? { audienceId: slot.audienceId } : {}),
    ...(slot.paid ? { paid: true as const } : {}),
    ...(slot.removed ? { removed: true as const } : {}),
  };
}

/**
 * Message ids seen in one album on this isolate. Ids only.
 * A restart, or a full map, leaves later photos in the chat.
 */
export function createAlbumWatch(): AlbumWatch {
  const albums = new Map<string, AlbumRecord>();

  function record(input: AlbumKey): AlbumRecord | undefined {
    if (!albumIdPattern.test(input.albumId)) {
      return undefined;
    }
    return albums.get(albumKey(input));
  }

  return {
    note(input) {
      if (
        !albumIdPattern.test(input.albumId) ||
        !messageIdPattern.test(input.messageId)
      ) {
        return [];
      }
      const key = albumKey(input);
      let album = albums.get(key);
      if (!album) {
        if (albums.size >= maxAlbums) {
          return [];
        }
        album = { slots: [], condemned: false };
        albums.set(key, album);
      }
      const existing = album.slots.find(
        (slot) => slot.messageId === input.messageId,
      );
      if (!existing && album.slots.length < maxSlots) {
        album.slots.push({
          messageId: input.messageId,
          ...(input.audienceId ? { audienceId: input.audienceId } : {}),
          ...(input.paid ? { paid: true as const } : {}),
        });
      }
      return album.slots.map(publish);
    },
    condemn(input) {
      const album = record(input);
      if (album) {
        album.condemned = true;
      }
    },
    markRemoved(input) {
      const album = record(input);
      const slot = album?.slots.find(
        (item) => item.messageId === input.messageId,
      );
      if (slot) {
        slot.removed = true;
      }
    },
    condemned(input) {
      return record(input)?.condemned === true;
    },
  };
}

export const workerAlbumWatch = createAlbumWatch();

function deleteExecuted(result: PipelineResult): boolean {
  return result.actionResults.some(
    (item) => item.actionId === "delete" && item.status === "executed",
  );
}

/**
 * After one non-paid delete, remove the other known messages in that album.
 * Public ids share one deleteMessages call. A receiver still uses deleteMessage.
 * Later arrivals are removed even when their own text would be kept.
 */
export async function sweepAlbum(input: {
  readonly event: Event;
  readonly result: PipelineResult;
  readonly dryRun: boolean;
  readonly moderator: ModerationPort;
  readonly logger: Logger;
  readonly watch: AlbumWatch;
}): Promise<void> {
  const message = input.event.message;
  const albumId = message?.albumId;
  const messageId = message?.id;
  if (!albumId || !messageId || !messageIdPattern.test(messageId)) {
    return;
  }
  const key = {
    tenantId: input.event.tenantId,
    chatId: input.event.chatId,
    albumId,
  };
  const paid = message.paid === true;
  const audienceId = message.audienceId;
  input.watch.note({
    ...key,
    messageId,
    ...(audienceId ? { audienceId } : {}),
    ...(paid ? { paid: true as const } : {}),
  });
  if (input.dryRun || input.result.dryRun) {
    return;
  }
  if (deleteExecuted(input.result) && !paid) {
    input.watch.markRemoved({ ...key, messageId });
    input.watch.condemn(key);
  }
  if (!input.watch.condemned(key)) {
    return;
  }
  const slots = input.watch.note({
    ...key,
    messageId,
    ...(audienceId ? { audienceId } : {}),
    ...(paid ? { paid: true as const } : {}),
  });
  const current = slots.find((slot) => slot.messageId === messageId);
  const targets: AlbumSlot[] = [];
  if (!paid && current?.removed !== true) {
    targets.push(
      current ?? {
        messageId,
        ...(audienceId ? { audienceId } : {}),
      },
    );
  }
  for (const slot of slots) {
    if (slot.messageId === messageId || slot.removed || slot.paid) {
      continue;
    }
    targets.push(slot);
  }
  const publicIds: string[] = [];
  const privateSlots: AlbumSlot[] = [];
  for (const slot of targets) {
    if (slot.audienceId) {
      privateSlots.push(slot);
    } else {
      publicIds.push(slot.messageId);
    }
  }
  if (publicIds.length > 0) {
    try {
      await input.moderator.deleteMessages({
        tenantId: input.event.tenantId,
        chatId: input.event.chatId,
        messageIds: publicIds,
      });
      for (const messageId of publicIds) {
        input.watch.markRemoved({ ...key, messageId });
      }
    } catch {
      input.logger.warn("album_delete_failed", {
        eventId: input.event.id,
        chatId: input.event.chatId,
      });
    }
  }
  for (const slot of privateSlots) {
    try {
      await input.moderator.deleteMessage({
        tenantId: input.event.tenantId,
        chatId: input.event.chatId,
        messageId: slot.messageId,
        ...(slot.audienceId ? { audienceId: slot.audienceId } : {}),
      });
      input.watch.markRemoved({ ...key, messageId: slot.messageId });
    } catch {
      input.logger.warn("album_delete_failed", {
        eventId: input.event.id,
        chatId: input.event.chatId,
      });
    }
  }
}
