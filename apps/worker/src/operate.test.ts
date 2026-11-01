import {
  createMemoryCache,
  createMemoryPolicyStore,
  createMemoryReply,
  createMemoryRuntimeStore,
  createMemoryStorage,
} from "@tasb/adapter-memory";
import { createMemoryLogger, parseEvent } from "@tasb/core";
import { sha256Hex } from "@tasb/platform-telegram";
import { describe, expect, it } from "vitest";
import { handleIncomingEvent } from "./operate.js";

const phrase = "请免费领取礼品";

async function incoming(input: {
  readonly text: string;
  readonly direct?: boolean;
  readonly chatId?: string;
  readonly actorId?: string;
}) {
  return parseEvent({
    id: "evt_op",
    tenantId: "local",
    chatId: input.chatId ?? "42",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: input.actorId ?? "42", isAdmin: false },
    ...(input.direct ? { direct: true } : {}),
    message: {
      id: "1",
      text: input.text,
      textSha256: await sha256Hex(input.text),
    },
  });
}

function deps() {
  return {
    logger: createMemoryLogger(),
    cache: createMemoryCache(),
    storage: createMemoryStorage(),
    policyStore: createMemoryPolicyStore(),
    runtime: createMemoryRuntimeStore(),
    reply: createMemoryReply(),
    adminActorIds: ["42"],
  };
}

describe("handleIncomingEvent", () => {
  it("screens a group command and leaves config unchanged", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({
        text: `/whitelist -100 add 9 ${phrase}`,
        chatId: "-100",
      }),
      kit,
    );
    expect(kit.reply.sent).toHaveLength(0);
    expect(await kit.policyStore.get("local", "-100")).toBeNull();
    expect(
      kit.logger.entries.some((entry) => entry.fields.action === "delete"),
    ).toBe(true);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });

  it("lets a configured admin manage one chat from a private command", async () => {
    const kit = deps();
    await handleIncomingEvent(
      await incoming({ text: `/help ${phrase}`, direct: true }),
      kit,
    );
    expect(kit.reply.sent[0]?.text).toContain("/whitelist");
    expect(kit.reply.sent[0]?.text).not.toContain(phrase);

    const denied = deps();
    await handleIncomingEvent(
      await incoming({
        text: `/dryrun -100 on ${phrase}`,
        direct: true,
        actorId: "7",
      }),
      denied,
    );
    expect(denied.reply.sent[0]?.text).toBe("没有权限");
    expect(await denied.runtime.getDryRun("local", "-100")).toBe(false);

    await handleIncomingEvent(
      await incoming({ text: "/dryrun -100 on", direct: true }),
      kit,
    );
    await handleIncomingEvent(
      await incoming({
        text: "/dryrun -100 off",
        chatId: "-100",
        actorId: "42",
      }),
      kit,
    );
    expect(await kit.runtime.getDryRun("local", "-100")).toBe(true);

    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100", actorId: "5" }),
      kit,
    );
    expect(kit.storage.records).toHaveLength(0);
    expect(
      kit.logger.entries.some((entry) => entry.fields.dryRun === true),
    ).toBe(true);

    await handleIncomingEvent(
      await incoming({ text: "/dryrun -100 off", direct: true }),
      kit,
    );
    await handleIncomingEvent(
      await incoming({ text: phrase, chatId: "-100", actorId: "5" }),
      kit,
    );
    expect(kit.storage.records).toHaveLength(1);
    const logs = await handleIncomingEvent(
      await incoming({ text: "/logs -100", direct: true }),
      kit,
    );
    expect(logs).toBeUndefined();
    const logReply = kit.reply.sent.at(-1)?.text ?? "";
    expect(logReply).toContain("delete");
    expect(logReply).not.toContain(phrase);
    expect(JSON.stringify(kit.logger.entries)).not.toContain(phrase);
  });
});
