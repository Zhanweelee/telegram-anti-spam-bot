import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryLogger, type Event, parseEvent } from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  createLinkDetector,
  type ReputationSource,
  type ReputationVerdict,
} from "./index.js";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/links.json"),
    "utf8",
  ),
) as {
  name: string;
  text: string;
  expect: "hit" | "miss";
  reason?: string;
  denylist?: string[];
  source?: "timeout" | "bad" | "throw";
}[];

const phrase = "请免费领取礼品";
const signal = { aborted: false };
const HASH = "ab".repeat(32);

function eventFor(
  text: string,
  hosts?: readonly string[],
  invites?: readonly string[],
): Event {
  return parseEvent({
    id: "evt_link",
    tenantId: "tenant_demo",
    chatId: "chat_demo",
    kind: "message",
    occurredAt: "2026-11-01T00:00:00.000Z",
    actor: { id: "user_1", isAdmin: false },
    message: {
      id: "msg_1",
      text,
      textSha256: HASH,
      ...(hosts === undefined ? {} : { hosts: [...hosts] }),
      ...(invites === undefined ? {} : { invites: [...invites] }),
    },
  });
}

function sourceFor(
  kind: "timeout" | "bad" | "throw" | undefined,
): ReputationSource | undefined {
  if (kind === undefined) {
    return undefined;
  }
  if (kind === "timeout") {
    return { lookup: () => new Promise<ReputationVerdict>(() => {}) };
  }
  if (kind === "bad") {
    return {
      async lookup() {
        return "bad";
      },
    };
  }
  return {
    async lookup() {
      throw new Error(phrase);
    },
  };
}

describe("link fixtures", () => {
  it("covers short links, plain text, and a timed-out source", async () => {
    for (const fixture of fixtures) {
      const logger = createMemoryLogger();
      const source = sourceFor(fixture.source);
      const detector = createLinkDetector({
        ...(fixture.denylist === undefined
          ? {}
          : { denylist: fixture.denylist }),
        ...(source === undefined ? {} : { source, sourceTimeoutMs: 15 }),
      });
      const hit = await detector.detect({
        event: eventFor(fixture.text),
        logger,
        signal,
      });
      if (fixture.expect === "miss") {
        expect(hit, fixture.name).toBeNull();
      } else {
        expect(hit?.reasons, fixture.name).toContain(fixture.reason);
        expect(hit?.score, fixture.name).toBe(1);
      }
      const dumped = JSON.stringify({ hit, logs: logger.entries });
      expect(dumped, fixture.name).not.toContain(phrase);
      expect(dumped, fixture.name).not.toContain("free-gift");
      expect(dumped, fixture.name).not.toContain("/login");
      expect(dumped, fixture.name).not.toContain("/slow");
      if (fixture.source === "timeout" || fixture.source === "throw") {
        expect(
          logger.entries.some((entry) => entry.message === "reputation_failed"),
          fixture.name,
        ).toBe(true);
      }
    }
  });

  it("does not call a source when a short link already matched", async () => {
    let calls = 0;
    const detector = createLinkDetector({
      source: {
        async lookup() {
          calls += 1;
          return "bad";
        },
      },
    });
    const hit = await detector.detect({
      event: eventFor("https://bit.ly/abc"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["short_link"]);
    expect(calls).toBe(0);
    const plain = await detector.detect({
      event: eventFor("今天站会改到三点"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();
    expect(calls).toBe(0);
  });

  it("scores a hidden short-link host and leaves the path out", async () => {
    const secret = "机密路径";
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor("点这里", ["bit.ly"]),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["short_link"]);
    expect(hit?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hit)).not.toContain(secret);
    const plain = await detector.detect({
      event: eventFor("点这里", ["example.com"]),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();
    const bare = await detector.detect({
      event: eventFor("", ["203.0.113.9"]),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["ip_host"]);
    const visible = Array.from(
      { length: 8 },
      (_, index) => `https://h${index}.example`,
    ).join(" ");
    const capped = await detector.detect({
      event: eventFor(visible, ["bit.ly"]),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capped).toBeNull();
  });

  it("folds gaps before reading a short link or an invite", async () => {
    const code = "INVITEFOLD99";
    const detector = createLinkDetector();
    const logger = createMemoryLogger();
    const broken = await detector.detect({
      event: eventFor("https://bit.\nly/foldsecret"),
      logger,
      signal,
    });
    expect(broken?.reasons).toEqual(["short_link"]);
    expect(broken?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const spaced = await detector.detect({
      event: eventFor("https://bit. ly/foldsecret"),
      logger,
      signal,
    });
    expect(spaced).toBeNull();
    const invite = await detector.detect({
      event: eventFor(`https://t.me/+IN\u200b${code}`),
      logger,
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    const dumped = JSON.stringify({ invite, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("foldsecret");
    expect(dumped).not.toContain("\u200b");
  });

  it("folds percent-encoded gaps before reading a link", async () => {
    const code = "ENCODEFOLD99";
    const detector = createLinkDetector();
    const logger = createMemoryLogger();
    const invite = await detector.detect({
      event: eventFor(`https://t.me/+IN%E2%80%8B${code}`),
      logger,
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    const bare = await detector.detect({
      event: eventFor("bit%E2%80%8B.ly/encoded"),
      logger,
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const spaced = await detector.detect({
      event: eventFor("https://bit.%20ly/encoded"),
      logger,
      signal,
    });
    expect(spaced).toBeNull();
    const doubled = await detector.detect({
      event: eventFor("https://t.me/+IN%25E2%2580%258BDOUBLE99"),
      logger,
      signal,
    });
    expect(doubled?.reasons).toEqual(["invite"]);
    expect(doubled?.evidence[0]?.summary).toBe("invite:t.me");
    const doubledBare = await detector.detect({
      event: eventFor("bit%25E2%2580%258B.ly/encoded"),
      logger,
      signal,
    });
    expect(doubledBare?.reasons).toEqual(["short_link"]);
    const doubledDot = await detector.detect({
      event: eventFor("bit%252Ely/encoded"),
      logger,
      signal,
    });
    expect(doubledDot).toBeNull();
    const dumped = JSON.stringify({
      invite,
      bare,
      doubled,
      doubledBare,
      logs: logger.entries,
    });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("encoded");
    expect(dumped).not.toContain("DOUBLE99");
  });

  it("treats a percent-encoded dot as a host separator", async () => {
    const code = "DOTEDOT99";
    const detector = createLinkDetector();
    const logger = createMemoryLogger();
    const bare = await detector.detect({
      event: eventFor("bit%2Ely/dotpath"),
      logger,
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const lower = await detector.detect({
      event: eventFor("bit%2ely/dotpath"),
      logger,
      signal,
    });
    expect(lower?.reasons).toEqual(["short_link"]);
    const invite = await detector.detect({
      event: eventFor(`t%2Eme/+${code}`),
      logger,
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    const doubled = await detector.detect({
      event: eventFor("bit%252Ely/dotpath"),
      logger,
      signal,
    });
    expect(doubled).toBeNull();
    const spaced = await detector.detect({
      event: eventFor("bit%2E ly/dotpath"),
      logger,
      signal,
    });
    expect(spaced).toBeNull();
    const plain = await detector.detect({
      event: eventFor("example%2Ecom/docs"),
      logger,
      signal,
    });
    expect(plain).toBeNull();
    const dumped = JSON.stringify({ bare, invite, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("dotpath");
  });

  it("treats a percent-encoded slash as a path separator", async () => {
    const code = "SLASHFOLD99";
    const detector = createLinkDetector();
    const logger = createMemoryLogger();
    const invite = await detector.detect({
      event: eventFor(`t.me%2F+${code}`),
      logger,
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    const lower = await detector.detect({
      event: eventFor(`telegram.me%2fjoinchat%2f${code}`),
      logger,
      signal,
    });
    expect(lower?.reasons).toEqual(["invite"]);
    expect(lower?.evidence[0]?.summary).toBe("invite:telegram.me");
    const pub = await detector.detect({
      event: eventFor("t.me%2Fdurov"),
      logger,
      signal,
    });
    expect(pub).toBeNull();
    const doubled = await detector.detect({
      event: eventFor(`t.me%252F+${code}`),
      logger,
      signal,
    });
    expect(doubled).toBeNull();
    const plain = await detector.detect({
      event: eventFor("example.com%2Fdocs"),
      logger,
      signal,
    });
    expect(plain).toBeNull();
    const dumped = JSON.stringify({ invite, lower, logs: logger.entries });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("durov");
  });

  it("treats a percent-encoded plus as an invite marker", async () => {
    const code = "PLUSFOLD99";
    const detector = createLinkDetector();
    const logger = createMemoryLogger();
    const invite = await detector.detect({
      event: eventFor(`t.me/%2B${code}`),
      logger,
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    const lower = await detector.detect({
      event: eventFor(`telegram.me/%2b${code}`),
      logger,
      signal,
    });
    expect(lower?.reasons).toEqual(["invite"]);
    expect(lower?.evidence[0]?.summary).toBe("invite:telegram.me");
    const both = await detector.detect({
      event: eventFor(`t.me%2F%2B${code}`),
      logger,
      signal,
    });
    expect(both?.reasons).toEqual(["invite"]);
    expect(both?.evidence[0]?.summary).toBe("invite:t.me");
    const doubled = await detector.detect({
      event: eventFor(`t.me/%252B${code}`),
      logger,
      signal,
    });
    expect(doubled).toBeNull();
    const pub = await detector.detect({
      event: eventFor("t.me/durov"),
      logger,
      signal,
    });
    expect(pub).toBeNull();
    const plain = await detector.detect({
      event: eventFor("example.com/%2Bdocs"),
      logger,
      signal,
    });
    expect(plain).toBeNull();
    const join = await detector.detect({
      event: eventFor(`telegram.me/joinchat/%2B${code}`),
      logger,
      signal,
    });
    expect(join).toBeNull();
    const dumped = JSON.stringify({
      invite,
      lower,
      both,
      logs: logger.entries,
    });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("durov");
  });

  it("treats a percent-encoded letter as part of the link", async () => {
    const code = "LETTER99";
    const detector = createLinkDetector();
    const logger = createMemoryLogger();
    const short = await detector.detect({
      event: eventFor("b%69t.ly/offer"),
      logger,
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const invite = await detector.detect({
      event: eventFor(`t.me/+OFF%45${code}`),
      logger,
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    const lower = await detector.detect({
      event: eventFor(`telegram.me/joinchat/off%65${code}`),
      logger,
      signal,
    });
    expect(lower?.reasons).toEqual(["invite"]);
    expect(lower?.evidence[0]?.summary).toBe("invite:telegram.me");
    const marked = await detector.detect({
      event: eventFor(`t.me/%2B%5F${code}`),
      logger,
      signal,
    });
    expect(marked?.reasons).toEqual(["invite"]);
    expect(marked?.evidence[0]?.summary).toBe("invite:t.me");
    const doubled = await detector.detect({
      event: eventFor(`t.me/+OFF%2545${code}`),
      logger,
      signal,
    });
    expect(doubled?.reasons).toEqual(["invite"]);
    expect(doubled?.evidence[0]?.summary).toBe("invite:t.me");
    const doubleHost = await detector.detect({
      event: eventFor("b%2569t.ly/offer"),
      logger,
      signal,
    });
    expect(doubleHost?.reasons).toEqual(["short_link"]);
    expect(doubleHost?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const triple = await detector.detect({
      event: eventFor(`t.me/+OFF%252545${code}`),
      logger,
      signal,
    });
    expect(triple).toBeNull();
    const tripleHost = await detector.detect({
      event: eventFor("b%252569t.ly/offer"),
      logger,
      signal,
    });
    expect(tripleHost).toBeNull();
    const doubleDot = await detector.detect({
      event: eventFor("bit%252Ely/offer"),
      logger,
      signal,
    });
    expect(doubleDot).toBeNull();
    const plain = await detector.detect({
      event: eventFor("example%41.com/docs"),
      logger,
      signal,
    });
    expect(plain).toBeNull();
    const hyphen = await detector.detect({
      event: eventFor("bit%2Dly/offer"),
      logger,
      signal,
    });
    expect(hyphen).toBeNull();
    const dotted = await detector.detect({
      event: eventFor(`t.me/+OFF%2E${code}`),
      logger,
      signal,
    });
    expect(dotted).toBeNull();
    const dumped = JSON.stringify({
      short,
      invite,
      lower,
      marked,
      doubled,
      doubleHost,
      logs: logger.entries,
    });
    expect(dumped).not.toContain(code);
    expect(dumped).not.toContain("offer");
    expect(dumped).not.toContain("/docs");
  });

  it("scores a telegram invite and keeps the code out of evidence", async () => {
    const code = "INVITESECRET99";
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor(`打开 https://t.me/+${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["invite"]);
    expect(hit?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(hit)).not.toContain(code);
    const joinchat = await detector.detect({
      event: eventFor(`https://telegram.me/joinchat/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joinchat?.evidence[0]?.summary).toBe("invite:telegram.me");
    const folder = await detector.detect({
      event: eventFor(`https://telegram.dog/addlist/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(folder?.evidence[0]?.summary).toBe("invite:telegram.dog");
    const hidden = await detector.detect({
      event: eventFor("点这里", undefined, ["t.me"]),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hidden?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(hidden)).not.toContain(code);
    const pub = await detector.detect({
      event: eventFor("https://t.me/durov"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(pub).toBeNull();
  });

  it("treats an android folder path as an invite and keeps the code out", async () => {
    const code = "FOLDER108";
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor(`打开 https://t.me/folder/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["invite"]);
    expect(hit?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(hit)).not.toContain(code);
    const me = await detector.detect({
      event: eventFor(`https://telegram.me/folder/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me?.evidence[0]?.summary).toBe("invite:telegram.me");
    const slash = await detector.detect({
      event: eventFor(`https://www.telegram.dog/folder/${code}/`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("invite:www.telegram.dog");
    const capital = await detector.detect({
      event: eventFor(`https://t.me/Folder/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital).toBeNull();
    const bare = await detector.detect({
      event: eventFor("https://t.me/folder"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
    const extra = await detector.detect({
      event: eventFor(`https://t.me/folder/${code}/more`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extra).toBeNull();
    const other = await detector.detect({
      event: eventFor(`https://example.com/folder/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other).toBeNull();
    const deep = await detector.detect({
      event: eventFor(`tg://folder?slug=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep).toBeNull();
  });

  it("treats an android t.me prefix invite and keeps the code out", async () => {
    const code = "PREFIX109";
    const detector = createLinkDetector();
    const folder = await detector.detect({
      event: eventFor(`打开 https://folder.t.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(folder?.reasons).toEqual(["invite"]);
    expect(folder?.evidence[0]?.summary).toBe("invite:folder.t.me");
    expect(JSON.stringify(folder)).not.toContain(code);
    const addlist = await detector.detect({
      event: eventFor(`https://addlist.t.me/${code}/`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addlist?.evidence[0]?.summary).toBe("invite:addlist.t.me");
    const joinchat = await detector.detect({
      event: eventFor(`https://Joinchat.T.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joinchat?.evidence[0]?.summary).toBe("invite:joinchat.t.me");
    const bare = await detector.detect({
      event: eventFor("https://folder.t.me"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
    const extra = await detector.detect({
      event: eventFor(`https://folder.t.me/${code}/more`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extra).toBeNull();
    const me = await detector.detect({
      event: eventFor(`https://folder.telegram.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    const nested = await detector.detect({
      event: eventFor(`https://www.folder.t.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nested).toBeNull();
    const user = await detector.detect({
      event: eventFor(`https://durov.t.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user).toBeNull();
  });

  it("treats a business chat link as an invite and keeps the slug out", async () => {
    const code = "BIZCHAT123";
    const detector = createLinkDetector();
    const path = await detector.detect({
      event: eventFor(`打开 https://t.me/m/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(path?.reasons).toEqual(["invite"]);
    expect(path?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(path)).not.toContain(code);
    const dotted = await detector.detect({
      event: eventFor("https://telegram.dog/M/ab.cd"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.evidence[0]?.summary).toBe("invite:telegram.dog");
    const prefix = await detector.detect({
      event: eventFor(`https://m.t.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefix?.evidence[0]?.summary).toBe("invite:m.t.me");
    const deep = await detector.detect({
      event: eventFor(`tg://message?slug=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("invite:t.me");
    const bare = await detector.detect({
      event: eventFor("https://t.me/m"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
    const slash = await detector.detect({
      event: eventFor(`https://t.me/m/${code}/`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();
    const extra = await detector.detect({
      event: eventFor(`https://t.me/m/${code}/more`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extra).toBeNull();
    const other = await detector.detect({
      event: eventFor(`https://example.com/m/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other).toBeNull();
    const me = await detector.detect({
      event: eventFor(`https://m.telegram.me/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    const query = await detector.detect({
      event: eventFor(
        `https://t.me/m/${code}?text=https%3A%2F%2Fbit.ly%2Fhidden123`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(query)).not.toContain("bit.ly");
    expect(JSON.stringify(query)).not.toContain("hidden123");
  });

  it("treats a capitalized joinchat or addlist path as an invite and keeps the code out", async () => {
    const code = "CASE110";
    const detector = createLinkDetector();
    const joinchat = await detector.detect({
      event: eventFor(`打开 https://t.me/JoinChat/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joinchat?.reasons).toEqual(["invite"]);
    expect(joinchat?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(joinchat)).not.toContain(code);
    const addlist = await detector.detect({
      event: eventFor(`https://www.telegram.dog/ADDLIST/${code}/`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addlist?.evidence[0]?.summary).toBe("invite:www.telegram.dog");
    const folder = await detector.detect({
      event: eventFor(`https://t.me/Folder/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(folder).toBeNull();
    const bare = await detector.detect({
      event: eventFor("https://t.me/JOINCHAT"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
    const extra = await detector.detect({
      event: eventFor(`https://t.me/JoinChat/${code}/more`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extra).toBeNull();
    const other = await detector.detect({
      event: eventFor(`https://example.com/JoinChat/${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other).toBeNull();
  });

  it("treats a percent-encoded space invite as an invite and keeps the code out", async () => {
    const code = "CASE111";
    const digits = "99881101";
    const address = "203.0.113.111";
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor(`打开 https://t.me/%20${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["invite"]);
    expect(hit?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(hit)).not.toContain(code);
    const dog = await detector.detect({
      event: eventFor(`https://www.telegram.dog/%20${code}?x=1`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog?.evidence[0]?.summary).toBe("invite:www.telegram.dog");
    const numeric = await detector.detect({
      event: eventFor(
        `https://t.me/%20${digits}?text=https%3A%2F%2F${address}%2Fhidden`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(numeric)).not.toContain(digits);
    expect(JSON.stringify(numeric)).not.toContain(address);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/%20${code}/`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();
    const hash = await detector.detect({
      event: eventFor(`https://t.me/%20${code}#room`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hash).toBeNull();
    const sub = await detector.detect({
      event: eventFor(`https://durov.t.me/%20${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(sub).toBeNull();
    const dotted = await detector.detect({
      event: eventFor("https://t.me/%20ab.cd"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
  });

  it("reads a passport callback url and keeps the secrets out", async () => {
    const address = "203.0.113.112";
    const path = "hidden112";
    const nonce = "NONCE112";
    const code = "CODE112";
    const nested = "203.0.113.113";
    const callback = encodeURIComponent(`http://${address}/${path}`);
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport?callback_url=${callback}&nonce=${nonce}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["ip_host"]);
    expect(hit?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(hit)).not.toContain(path);
    expect(JSON.stringify(hit)).not.toContain(nonce);
    const command = await detector.detect({
      event: eventFor(`tg://Passport?CALLBACK_URL=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(command?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const plain = await detector.detect({
      event: eventFor(`tg:passport?callback_url=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const resolve = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=telegrampassport&callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(resolve?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/telegrampassport?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const sub = await detector.detect({
      event: eventFor(`https://telegrampassport.T.ME?callback_url=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(sub?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const post = await detector.detect({
      event: eventFor(
        `https://telegrampassport.t.me/123?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const app = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport/app?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(app?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const story = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport/s/live?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(story?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const thread = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport/1/2?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(thread?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const invite = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport?callback_url=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    const other = await detector.detect({
      event: eventFor(
        `https://example.com/telegrampassport?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other).toBeNull();
    const mixed = await detector.detect({
      event: eventFor(`https://t.me/TelegramPassport?callback_url=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(mixed).toBeNull();
    const mixedDomain = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=TelegramPassport&callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(mixedDomain).toBeNull();
    const otherHost = await detector.detect({
      event: eventFor(
        `https://telegrampassport.telegram.me?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(otherHost).toBeNull();
    const junk = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport/a/b/c?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(junk).toBeNull();
    const wwwSub = await detector.detect({
      event: eventFor(
        `https://www.telegrampassport.t.me?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wwwSub).toBeNull();
    const user = await detector.detect({
      event: eventFor(`https://t.me/durov?callback_url=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user).toBeNull();
    const secure = await detector.detect({
      event: eventFor(`tg://secureid?callback_url=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(secure).toBeNull();
    const inner = encodeURIComponent(
      `https://t.me/telegrampassport?callback_url=${encodeURIComponent(`http://${nested}/x`)}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/telegrampassport?callback_url=${inner}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
    expect(JSON.stringify(wrapped)).not.toContain(nested);
    const textOnly = await detector.detect({
      event: eventFor(`tg://resolve?domain=telegrampassport&text=${callback}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(textOnly).toBeNull();
  });

  it("reads the draft on a username app path and keeps the name out", async () => {
    const address = "203.0.113.114";
    const hidden = "hidden114";
    const code = "CODE114";
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor(
        `https://t.me/durov/shop?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["ip_host"]);
    expect(hit?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(hit)).not.toContain(hidden);
    expect(JSON.stringify(hit)).not.toContain("durov");
    expect(JSON.stringify(hit)).not.toContain("shop");
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/durov/Shop/?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const dotted = await detector.detect({
      event: eventFor(
        `https://telegram.me/durov/my.app?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(dotted)).not.toContain("my.app");
    const deep = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=durov&appname=shop&text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const invite = await detector.detect({
      event: eventFor(
        `https://t.me/durov/shop?text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    const sub = await detector.detect({
      event: eventFor(
        `https://durov.t.me/shop?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(sub).toBeNull();
    const extra = await detector.detect({
      event: eventFor(
        `https://t.me/durov/shop/more?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extra).toBeNull();
    const foreign = await detector.detect({
      event: eventFor(
        `https://example.com/durov/shop?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();
    const reserved = await detector.detect({
      event: eventFor(
        `https://t.me/proxy/shop?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();
    const nested = encodeURIComponent(
      `https://t.me/durov/shop?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/spam?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads drafts and passport callbacks on long desktop path segments", async () => {
    const address = "203.0.113.115";
    const hidden = "hidden115";
    const app = "a".repeat(129);
    const post = "9".repeat(17);
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`http://${address}/${hidden}`);
    const hit = await detector.detect({
      event: eventFor(`https://t.me/durov/${app}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["ip_host"]);
    expect(hit?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(hit)).not.toContain(hidden);
    expect(JSON.stringify(hit)).not.toContain(app);
    const sub = await detector.detect({
      event: eventFor(`https://durov.t.me/${post}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(sub?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const callback = encodeURIComponent(`http://${address}/${hidden}`);
    const passport = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport/${app}?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(passport?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(passport)).not.toContain(app);
    const thread = await detector.detect({
      event: eventFor(
        `https://t.me/telegrampassport/${post}/${post}?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(thread?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const subPassport = await detector.detect({
      event: eventFor(
        `https://telegrampassport.t.me/${post}?callback_url=${callback}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(subPassport?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const subApp = await detector.detect({
      event: eventFor(`https://durov.t.me/${app}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(subApp).toBeNull();
    const userThread = await detector.detect({
      event: eventFor(`https://t.me/durov/${post}/${post}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(userThread).toBeNull();
  });

  it("treats a tg deep link as an invite and keeps the code out", async () => {
    const code = "DEEPJOIN69";
    const detector = createLinkDetector();
    const join = await detector.detect({
      event: eventFor(`加入 tg://join?invite=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(join?.reasons).toEqual(["invite"]);
    expect(join?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(join)).not.toContain(code);
    const folder = await detector.detect({
      event: eventFor(`tg://addlist?slug=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(folder?.reasons).toEqual(["invite"]);
    expect(folder?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(folder)).not.toContain(code);
    const upper = await detector.detect({
      event: eventFor(`TG://JOIN?invite=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(upper?.reasons).toEqual(["invite"]);
    const bare = await detector.detect({
      event: eventFor(`tg:join?invite=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["invite"]);
    const encoded = "ZZ%5F69";
    const percent = await detector.detect({
      event: eventFor(`tg://join?invite=${encoded}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(percent?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(percent)).not.toContain("ZZ_69");
    expect(JSON.stringify(percent)).not.toContain(encoded);
    const resolve = await detector.detect({
      event: eventFor("tg://resolve?domain=durov"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(resolve).toBeNull();
    const broken = await detector.detect({
      event: eventFor("tg://join?invite=a/b"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(broken).toBeNull();
    const empty = await detector.detect({
      event: eventFor("tg://join?invite="),
      logger: createMemoryLogger(),
      signal,
    });
    expect(empty).toBeNull();
    const other = createLinkDetector({ inviteHosts: ["telegram.dog"] });
    const skipped = await other.detect({
      event: eventFor(`tg://join?invite=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(skipped).toBeNull();
  });

  it("reads the server host from a telegram proxy link and leaves the secret out", async () => {
    const detector = createLinkDetector();
    const secret = "SECRET98";
    const ip = await detector.detect({
      event: eventFor(
        `https://t.me/proxy?server=203.0.113.9&port=4444&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(ip)).not.toContain(secret);
    expect(JSON.stringify(ip)).not.toContain("4444");

    const socks = await detector.detect({
      event: eventFor(
        "https://t.me/socks?server=bit.ly&port=1080&user=USER98&pass=PASS98",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(socks?.reasons).toEqual(["short_link"]);
    expect(socks?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(socks)).not.toContain("USER98");
    expect(JSON.stringify(socks)).not.toContain("PASS98");

    const deep = await detector.detect({
      event: eventFor(
        `tg://proxy?server=203.0.113.9&port=4444&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.reasons).toEqual(["ip_host"]);
    expect(deep?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(deep)).not.toContain(secret);

    const bare = await detector.detect({
      event: eventFor("tg:socks?server=198.51.100.20&user=USER98&pass=PASS98"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["ip_host"]);
    expect(bare?.evidence[0]?.summary).toBe("ip_host:198.51.100.20");
    expect(JSON.stringify(bare)).not.toContain("USER98");
    expect(JSON.stringify(bare)).not.toContain("PASS98");

    const encoded = await detector.detect({
      event: eventFor(
        "https://T.ME/PROXY?server=203%2E0%2E113%2E8&secret=SECRET98",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encoded?.reasons).toEqual(["ip_host"]);
    expect(encoded?.evidence[0]?.summary).toBe("ip_host:203.0.113.8");

    const wrapped = await detector.detect({
      event: eventFor(
        "https://t.me/proxy?server=https%3A%2F%2Fbit.ly%2Fname98&secret=SECRET98",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped?.reasons).toEqual(["short_link"]);
    expect(wrapped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(wrapped)).not.toContain("name98");

    const ordinary = await detector.detect({
      event: eventFor(
        "https://t.me/proxy?server=proxy.example.com&secret=SECRET98",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const foreign = await detector.detect({
      event: eventFor(
        "https://example.com/proxy?server=203.0.113.9&secret=SECRET98",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const resolve = await detector.detect({
      event: eventFor("tg://resolve?domain=203.0.113.9"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(resolve).toBeNull();

    const nearby = await detector.detect({
      event: eventFor("https://t.me/proxybot?server=203.0.113.9"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nearby).toBeNull();
  });

  it("reads the server host from a telegram web proxy link and leaves the secret out", async () => {
    const detector = createLinkDetector();
    const secret = "SECRET103";
    const ip = await detector.detect({
      event: eventFor(
        `https://t.me/webproxy?server=203.0.113.9&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(ip)).not.toContain(secret);

    const shortened = await detector.detect({
      event: eventFor(`tg://webproxy?server=bit.ly%2Fname103&secret=${secret}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shortened)).not.toContain("name103");
    expect(JSON.stringify(shortened)).not.toContain(secret);

    const bare = await detector.detect({
      event: eventFor("tg:webproxy?server=198.51.100.23"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["ip_host"]);
    expect(bare?.evidence[0]?.summary).toBe("ip_host:198.51.100.23");

    const ordinary = await detector.detect({
      event: eventFor(
        `https://t.me/webproxy?server=proxy.example.com&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const foreign = await detector.detect({
      event: eventFor(
        `https://example.com/webproxy?server=203.0.113.9&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const reserved = await detector.detect({
      event: eventFor("https://t.me/web?server=203.0.113.9"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();
  });

  it("reads the host alias on a telegram proxy link and leaves the secret out", async () => {
    const detector = createLinkDetector();
    const secret = "SECRET104";
    const ip = await detector.detect({
      event: eventFor(
        `https://t.me/proxy?host=203.0.113.9&port=443&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(ip)).not.toContain(secret);

    const shortened = await detector.detect({
      event: eventFor(`tg://webproxy?host=bit.ly%2Fname104&secret=${secret}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shortened)).not.toContain("name104");
    expect(JSON.stringify(shortened)).not.toContain(secret);

    const socks = await detector.detect({
      event: eventFor(
        "tg:socks?host=198.51.100.23&port=1080&user=user104&pass=pass104",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(socks?.reasons).toEqual(["ip_host"]);
    expect(socks?.evidence[0]?.summary).toBe("ip_host:198.51.100.23");
    expect(JSON.stringify(socks)).not.toContain("user104");
    expect(JSON.stringify(socks)).not.toContain("pass104");

    const serverWins = await detector.detect({
      event: eventFor(
        `https://t.me/proxy?server=example.com&host=203.0.113.9&port=443&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(serverWins).toBeNull();

    const emptyServer = await detector.detect({
      event: eventFor(
        `https://t.me/proxy?server=&host=203.0.113.9&port=443&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(emptyServer).toBeNull();

    const ordinary = await detector.detect({
      event: eventFor(
        `https://t.me/socks?host=proxy.example.com&port=1080&user=user104`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const named = await detector.detect({
      event: eventFor(
        `https://t.me/proxy?proxy=203.0.113.9&port=443&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(named).toBeNull();

    const reserved = await detector.detect({
      event: eventFor("https://t.me/web?host=203.0.113.9"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();

    const foreign = await detector.detect({
      event: eventFor(
        `https://example.com/proxy?host=203.0.113.9&port=443&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();
  });

  it("reads the host alias when a web proxy server is empty and leaves the secret out", async () => {
    const detector = createLinkDetector();
    const secret = "SECRET105";
    const ip = await detector.detect({
      event: eventFor(
        `https://t.me/webproxy?server=&host=203.0.113.9&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(ip)).not.toContain(secret);

    const shortened = await detector.detect({
      event: eventFor(
        `tg://webproxy?server=&host=bit.ly%2Fname105&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shortened)).not.toContain("name105");
    expect(JSON.stringify(shortened)).not.toContain(secret);

    const bare = await detector.detect({
      event: eventFor(
        `tg:webproxy?server=&host=198.51.100.24&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["ip_host"]);
    expect(bare?.evidence[0]?.summary).toBe("ip_host:198.51.100.24");
    expect(JSON.stringify(bare)).not.toContain(secret);

    const serverWins = await detector.detect({
      event: eventFor(
        `https://t.me/webproxy?server=example.com&host=203.0.113.9&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(serverWins).toBeNull();

    const socks = await detector.detect({
      event: eventFor(
        `https://t.me/socks?server=&host=203.0.113.9&port=1080&user=user105&pass=pass105`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(socks).toBeNull();

    const spaced = await detector.detect({
      event: eventFor(
        `https://t.me/webproxy?server=%20&host=203.0.113.9&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(spaced).toBeNull();

    const ordinary = await detector.detect({
      event: eventFor(
        `https://t.me/webproxy?server=&host=proxy.example.com&secret=${secret}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();
    expect(JSON.stringify(ordinary)).not.toContain(secret);
  });

  it("reads the url inside a telegram share link and leaves the path out", async () => {
    const detector = createLinkDetector();
    const shared = await detector.detect({
      event: eventFor(
        "https://t.me/share/url?url=https%3A%2F%2Fbit.ly%2Fname99&text=hello",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shared?.reasons).toEqual(["short_link"]);
    expect(shared?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shared)).not.toContain("name99");

    const preview = await detector.detect({
      event: eventFor(
        "https://t.me/iv?url=http%3A%2F%2F203.0.113.9%2Fpath99&rhash=RHASH99",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(preview?.reasons).toEqual(["ip_host"]);
    expect(preview?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(preview)).not.toContain("RHASH99");
    expect(JSON.stringify(preview)).not.toContain("path99");

    const code = "code99";
    const invite = await detector.detect({
      event: eventFor(`tg://msg_url?url=https://t.me/+${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    const encodedInvite = await detector.detect({
      event: eventFor(
        `https://t.me/share/url?url=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encodedInvite?.reasons).toEqual(["invite"]);
    expect(encodedInvite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(encodedInvite)).not.toContain(code);

    const bare = await detector.detect({
      event: eventFor("tg:msg_url?url=https%3A%2F%2Fbit.ly%2Fname99"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain("name99");

    const comment = await detector.detect({
      event: eventFor(
        "https://t.me/share/url?url=https%3A%2F%2Fexample.com%2Fok99&text=see%20https%3A%2F%2Fbit.ly%2Fname99",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(comment?.reasons).toEqual(["short_link"]);
    expect(comment?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(comment)).not.toContain("name99");
    expect(JSON.stringify(comment)).not.toContain("ok99");

    const ordinary = await detector.detect({
      event: eventFor(
        "https://t.me/share/url?url=https%3A%2F%2Fexample.com%2Fok99&text=hello",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const profile = await detector.detect({
      event: eventFor("https://t.me/durov?url=https%3A%2F%2Fbit.ly%2Fname99"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(profile).toBeNull();

    const foreign = await detector.detect({
      event: eventFor(
        "https://example.com/share/url?url=https%3A%2F%2Fbit.ly%2Fname99",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const wrapped = encodeURIComponent(
      `https://t.me/share/url?url=${encodeURIComponent("https://bit.ly/name99")}`,
    );
    const nested = await detector.detect({
      event: eventFor(`https://t.me/share/url?url=${wrapped}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nested).toBeNull();
  });

  it("reads the text inside a telegram msg link and leaves the path out", async () => {
    const detector = createLinkDetector();
    const hidden = await detector.detect({
      event: eventFor(
        "tg://msg?text=https%3A%2F%2F203.0.113.9%2Fpath100&to=durov",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hidden?.reasons).toEqual(["ip_host"]);
    expect(hidden?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(hidden)).not.toContain("path100");
    expect(JSON.stringify(hidden)).not.toContain("durov");

    const code = "code100";
    const invite = await detector.detect({
      event: eventFor(
        `tg:msg?text=${encodeURIComponent(`tg://join?invite=${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);

    const ordinary = await detector.detect({
      event: eventFor(
        "tg://msg?text=https%3A%2F%2Fexample.com%2Fok100&to=198.51.100.20",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const recipient = await detector.detect({
      event: eventFor("tg://msg?to=203.0.113.9&text=hello"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(recipient).toBeNull();

    const search = await detector.detect({
      event: eventFor("tg://search?query=https%3A%2F%2F203.0.113.9%2Fpath100"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(search).toBeNull();

    const profile = await detector.detect({
      event: eventFor(
        "https://t.me/durov?text=https%3A%2F%2F203.0.113.9%2Fpath100",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(profile?.reasons).toEqual(["ip_host"]);
    expect(profile?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(profile)).not.toContain("path100");

    const nested = encodeURIComponent(
      `tg://msg?text=${encodeURIComponent("https://203.0.113.9/path100")}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`tg://msg?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads the draft after Android strips a preview segment", async () => {
    const address = "203.0.113.118";
    const hidden = "hidden118";
    const code = "CODE118";
    const draft = encodeURIComponent(`http://${address}/${hidden}`);
    const detector = createLinkDetector();
    const post = await detector.detect({
      event: eventFor(`https://t.me/s/durov/123?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post?.reasons).toEqual(["ip_host"]);
    expect(post?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(post)).not.toContain(hidden);
    expect(JSON.stringify(post)).not.toContain("durov");
    const app = await detector.detect({
      event: eventFor(`https://telegram.dog/s/durov/shop?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(app?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const label = await detector.detect({
      event: eventFor(`https://s.t.me/durov/my.app?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(label?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(label)).not.toContain("my.app");
    const invite = await detector.detect({
      event: eventFor(
        `https://telegram.me/s/durov/9?text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    const capital = await detector.detect({
      event: eventFor(`https://t.me/S/durov/shop?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital).toBeNull();
    const www = await detector.detect({
      event: eventFor(`https://www.t.me/s/durov/shop?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(www).toBeNull();
    const reserved = await detector.detect({
      event: eventFor(`https://t.me/s/proxy/shop?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();
    const extra = await detector.detect({
      event: eventFor(`https://t.me/s/durov/shop/more?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extra).toBeNull();
    const other = await detector.detect({
      event: eventFor(`https://s.telegram.me/durov/shop?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other).toBeNull();
    const nested = encodeURIComponent(
      `https://t.me/s/durov/123?text=${encodeURIComponent(`http://${address}/x`)}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/s/spam/shop?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads a hostname when Android rewrites a label subdomain", async () => {
    const address = "203.0.113.117";
    const hidden = "hidden117";
    const code = "CODE117";
    const draft = encodeURIComponent(`http://${address}/${hidden}`);
    const detector = createLinkDetector();
    const preview = await detector.detect({
      event: eventFor(`https://s.t.me/durov?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(preview?.reasons).toEqual(["ip_host"]);
    expect(preview?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(preview)).not.toContain(hidden);
    expect(JSON.stringify(preview)).not.toContain("durov");
    const share = await detector.detect({
      event: eventFor(`https://share.t.me/url?url=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(share?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const invite = await detector.detect({
      event: eventFor(
        `https://msg.t.me/url?url=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    const reserved = await detector.detect({
      event: eventFor(`https://s.t.me/proxy?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();
    const otherHost = await detector.detect({
      event: eventFor(`https://s.telegram.me/durov?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(otherHost).toBeNull();
    const otherShare = await detector.detect({
      event: eventFor(`https://share.t.me/other?url=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(otherShare).toBeNull();
    const bareShare = await detector.detect({
      event: eventFor(`https://share.t.me?url=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bareShare).toBeNull();
    const nested = encodeURIComponent(
      `https://s.t.me/durov?text=${encodeURIComponent(`http://${address}/x`)}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://s.t.me/spam?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads the draft when a preview resolve rewrites domain s", async () => {
    const address = "203.0.113.116";
    const hidden = "hidden116";
    const code = "CODE116";
    const draft = encodeURIComponent(`http://${address}/${hidden}`);
    const detector = createLinkDetector();
    const hit = await detector.detect({
      event: eventFor(`tg://resolve?domain=s&appname=durov&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["ip_host"]);
    expect(hit?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(hit)).not.toContain(hidden);
    expect(JSON.stringify(hit)).not.toContain("durov");
    const bare = await detector.detect({
      event: eventFor(`tg:resolve?DOMAIN=s&APPNAME=Durov&TEXT=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    const invite = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=s&appname=durov&text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    const dotted = await detector.detect({
      event: eventFor(`tg://resolve?domain=s&appname=my.bot&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const reserved = await detector.detect({
      event: eventFor(`tg://resolve?domain=s&appname=proxy&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();
    const empty = await detector.detect({
      event: eventFor(`tg://resolve?domain=s&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(empty).toBeNull();
    const nested = encodeURIComponent(
      `tg://resolve?domain=s&appname=durov&text=${encodeURIComponent(`http://${address}/x`)}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`tg://resolve?domain=s&appname=spam&text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads the draft on a telegram username link and leaves the path out", async () => {
    const detector = createLinkDetector();
    const shortened = await detector.detect({
      event: eventFor(
        "tg://resolve?domain=durov&text=https%3A%2F%2Fbit.ly%2Fname106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shortened)).not.toContain("name106");
    expect(JSON.stringify(shortened)).not.toContain("durov");

    const preview = await detector.detect({
      event: eventFor(
        "https://t.me/s/durov?text=http%3A%2F%2F198.51.100.26%2Fpath106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(preview?.reasons).toEqual(["ip_host"]);
    expect(preview?.evidence[0]?.summary).toBe("ip_host:198.51.100.26");
    expect(JSON.stringify(preview)).not.toContain("path106");

    const phone = await detector.detect({
      event: eventFor(
        "tg:resolve?phone=79990001106&text=https%3A%2F%2Fcutt.ly%2Fname106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(phone?.reasons).toEqual(["short_link"]);
    expect(phone?.evidence[0]?.summary).toBe("short_link:cutt.ly");
    expect(JSON.stringify(phone)).not.toContain("name106");
    expect(JSON.stringify(phone)).not.toContain("79990001106");

    const code = "code106";
    const invite = await detector.detect({
      event: eventFor(
        `https://telegram.me/durov?text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);

    const ordinary = await detector.detect({
      event: eventFor(
        "https://t.me/durov?text=https%3A%2F%2Fexample.com%2Fok106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const post = await detector.detect({
      event: eventFor(
        "https://t.me/durov/123?text=https%3A%2F%2Fbit.ly%2Fname106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post?.reasons).toEqual(["short_link"]);
    expect(post?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(post)).not.toContain("name106");
    expect(JSON.stringify(post)).not.toContain("durov");

    const proxy = await detector.detect({
      event: eventFor(
        "https://t.me/proxy?server=example.com&text=https%3A%2F%2Fbit.ly%2Fname106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(proxy).toBeNull();

    const passport = await detector.detect({
      event: eventFor(
        "tg://resolve?domain=telegrampassport&text=tg%3A%2F%2Fjoin%3Finvite%3Dcode106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(passport).toBeNull();
    expect(JSON.stringify(passport)).not.toContain("code106");

    const foreign = await detector.detect({
      event: eventFor(
        "https://example.com/durov?text=https%3A%2F%2Fbit.ly%2Fname106",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const nested = encodeURIComponent(
      "https://t.me/durov?text=https%3A%2F%2Fbit.ly%2Fname106",
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/spam?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads the draft on a user post path and a t.me subdomain", async () => {
    const detector = createLinkDetector();
    const subdomain = await detector.detect({
      event: eventFor(
        "https://durov.t.me/?text=http%3A%2F%2F203.0.113.8%2Fpath108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(subdomain?.reasons).toEqual(["ip_host"]);
    expect(subdomain?.evidence[0]?.summary).toBe("ip_host:203.0.113.8");
    expect(JSON.stringify(subdomain)).not.toContain("path108");

    const shortened = await detector.detect({
      event: eventFor(
        "https://www.telegram.dog/durov/9?text=https%3A%2F%2Fcutt.ly%2Fname108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:cutt.ly");
    expect(JSON.stringify(shortened)).not.toContain("name108");
    expect(JSON.stringify(shortened)).not.toContain("durov");

    const code = "code108";
    const invite = await detector.detect({
      event: eventFor(
        `https://durov.t.me?text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);

    const ordinary = await detector.detect({
      event: eventFor(
        "https://durov.t.me/15?text=https%3A%2F%2Fexample.com%2Fok108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const thread = await detector.detect({
      event: eventFor(
        "https://t.me/durov/12/34?text=https%3A%2F%2Fbit.ly%2Fname108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(thread).toBeNull();

    const app = await detector.detect({
      event: eventFor(
        "https://t.me/durov/app?text=https%3A%2F%2Fbit.ly%2Fname108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(app?.reasons).toEqual(["short_link"]);
    expect(app?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(app)).not.toContain("name108");
    expect(JSON.stringify(app)).not.toContain("durov");

    const reserved = await detector.detect({
      event: eventFor(
        "https://proxy.t.me/?text=https%3A%2F%2Fbit.ly%2Fname108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reserved).toBeNull();

    const single = await detector.detect({
      event: eventFor("https://a.t.me/?text=https%3A%2F%2Fbit.ly%2Fname108"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(single).toBeNull();

    const foreign = await detector.detect({
      event: eventFor(
        "https://durov.example.com/?text=https%3A%2F%2Fbit.ly%2Fname108",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const nested = encodeURIComponent(
      "https://t.me/durov/123?text=https%3A%2F%2Fbit.ly%2Fname108",
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/spam?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads telegram query names without caring about their case", async () => {
    const detector = createLinkDetector();
    const shortened = await detector.detect({
      event: eventFor(
        "tg://resolve?DOMAIN=durov&TEXT=https%3A%2F%2Fbit.ly%2Fname109",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shortened)).not.toContain("name109");
    expect(JSON.stringify(shortened)).not.toContain("durov");

    const address = await detector.detect({
      event: eventFor(
        "tg://resolve?DOMAIN=durov&TEXT=https%3A%2F%2F203.0.113.109%2Fname109",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(address?.reasons).toEqual(["ip_host"]);
    expect(address?.evidence[0]?.summary).toBe("ip_host:203.0.113.109");
    expect(JSON.stringify(address)).not.toContain("name109");
    expect(JSON.stringify(address)).not.toContain("durov");

    const phone = await detector.detect({
      event: eventFor(
        "tg://resolve?PHONE=79990001109&TEXT=https%3A%2F%2F203.0.113.110%2Fphone109",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(phone?.reasons).toEqual(["ip_host"]);
    expect(phone?.evidence[0]?.summary).toBe("ip_host:203.0.113.110");
    expect(JSON.stringify(phone)).not.toContain("phone109");
    expect(JSON.stringify(phone)).not.toContain("79990001109");

    const proxy = await detector.detect({
      event: eventFor("https://t.me/proxy?SERVER=bit.ly&secret=sek109"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(proxy?.reasons).toEqual(["short_link"]);
    expect(proxy?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(proxy)).not.toContain("sek109");

    const web = await detector.detect({
      event: eventFor("tg://webproxy?SERVER=&HOST=203.0.113.109"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(web?.reasons).toEqual(["ip_host"]);
    expect(web?.evidence[0]?.summary).toBe("ip_host:203.0.113.109");

    const code = "AbC109";
    const invite = await detector.detect({
      event: eventFor(`tg://join?INVITE=${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);

    const slug = await detector.detect({
      event: eventFor("tg://addlist?SLUG=list109"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slug?.reasons).toEqual(["invite"]);
    expect(slug?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(slug)).not.toContain("list109");

    const blank = await detector.detect({
      event: eventFor("tg://socks?SERVER=%20&HOST=203.0.113.109"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(blank).toBeNull();

    const passport = await detector.detect({
      event: eventFor(
        "tg://resolve?DOMAIN=telegrampassport&TEXT=https%3A%2F%2F203.0.113.109%2Fname109",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(passport).toBeNull();
    expect(JSON.stringify(passport)).not.toContain("name109");

    const preferred = await detector.detect({
      event: eventFor("tg://proxy?SERVER=example.com&HOST=203.0.113.109"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(preferred).toBeNull();

    const first = await detector.detect({
      event: eventFor("https://t.me/proxy?SERVER=bit.ly&server=example.com"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(first?.reasons).toEqual(["short_link"]);
    expect(first?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const lower = await detector.detect({
      event: eventFor(
        "tg://resolve?domain=durov&text=https%3A%2F%2Fbit.ly%2Fname109",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(lower?.reasons).toEqual(["short_link"]);
    expect(lower?.evidence[0]?.summary).toBe("short_link:bit.ly");
  });

  it("treats a numeric telegram plus link as a phone draft", async () => {
    const detector = createLinkDetector();
    const bare = await detector.detect({
      event: eventFor("https://t.me/+79990001107"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();

    const shortened = await detector.detect({
      event: eventFor(
        "https://t.me/+79990001107?text=https%3A%2F%2Fbit.ly%2Fname107",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(shortened)).not.toContain("name107");
    expect(JSON.stringify(shortened)).not.toContain("79990001107");

    const address = await detector.detect({
      event: eventFor(
        "https://telegram.dog/+79990001107?text=http%3A%2F%2F203.0.113.50%2Fpath107",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(address?.reasons).toEqual(["ip_host"]);
    expect(address?.evidence[0]?.summary).toBe("ip_host:203.0.113.50");
    expect(JSON.stringify(address)).not.toContain("path107");

    const code = "code107";
    const invite = await detector.detect({
      event: eventFor(
        `https://www.telegram.me/+79990001107?text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);
    expect(JSON.stringify(invite)).not.toContain("79990001107");

    const ordinary = await detector.detect({
      event: eventFor(
        "https://t.me/%2B79990001107?text=https%3A%2F%2Fexample.com%2Fok107",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const letters = await detector.detect({
      event: eventFor(
        "https://t.me/+AbC107?text=https%3A%2F%2Fbit.ly%2Fname107",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(letters?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(letters)).not.toContain("bit.ly");
    expect(JSON.stringify(letters)).not.toContain("name107");

    const joined = await detector.detect({
      event: eventFor("https://t.me/joinchat/79990001107"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["invite"]);
    expect(joined?.evidence[0]?.summary).toBe("invite:t.me");

    const deep = await detector.detect({
      event: eventFor("tg://join?invite=79990001107"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.reasons).toEqual(["invite"]);

    const foreign = await detector.detect({
      event: eventFor(
        "https://example.com/+79990001107?text=https%3A%2F%2Fbit.ly%2Fname107",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const other = await detector.detect({
      event: eventFor(
        "https://news.t.me/+79990001107?text=https%3A%2F%2Fbit.ly%2Fname107",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(other)).not.toContain("bit.ly");

    const nested = encodeURIComponent(
      "https://t.me/+79990001107?text=https%3A%2F%2Fbit.ly%2Fname107",
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/spam?text=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("folds dot lookalikes into ascii dots before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("https://bit\u00B7ly/dot62"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("dot62");
    expect(JSON.stringify(short)).not.toContain("xn--");

    const invite = await detector.detect({
      event: eventFor("https://t\u30FBme/+DOT62"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("DOT62");

    const ordinary = await detector.detect({
      event: eventFor("https://example\u00B7com/page62"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const period = await detector.detect({
      event: eventFor("不是免费。领取 https://bit。ly/stop62"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(period?.evidence[0]?.summary).toBe("short_link:bit.ly");
  });

  it("folds fullwidth latin letters before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("\uFF42\uFF49\uFF54.ly/lat63"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("lat63");

    const invite = await detector.detect({
      event: eventFor("\uFF54.\uFF4D\uFF45/+LAT63"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("LAT63");

    const ordinary = await detector.detect({
      event: eventFor("example.\uFF43\uFF4F\uFF4D/page63"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const ip = await detector.detect({
      event: eventFor("http://\uFF12\uFF10\uFF13.0.113.9/ip63"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(ip)).not.toContain("ip63");
  });

  it("folds seven cyrillic lookalikes before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("bit.l\u0443/lat64"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("lat64");

    const invite = await detector.detect({
      event: eventFor("t.m\u0435/+LAT64"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("LAT64");

    const ordinary = await detector.detect({
      event: eventFor("\u0435xample.com/page64"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const ukrainian = await detector.detect({
      event: eventFor("b\u0456t.ly/uk65"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ukrainian?.reasons).toEqual(["short_link"]);
    expect(ukrainian?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(ukrainian)).not.toContain("uk65");

    const capital = await detector.detect({
      event: eventFor("b\u0406t.ly/cap65"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.reasons).toEqual(["short_link"]);
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(capital)).not.toContain("cap65");

    const te = await detector.detect({
      event: eventFor("\u0442.me/+NO65"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(te).toBeNull();
  });

  it("drops letters that split a hostname instead of reading the tail", async () => {
    const detector = createLinkDetector();
    const infix = await detector.detect({
      event: eventFor("b\u0442it.ly/lat66"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(infix?.reasons).toEqual(["short_link"]);
    expect(infix?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(infix)).not.toContain("lat66");

    const cjk = await detector.detect({
      event: eventFor("点击bit.ly/cjk66"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(cjk?.reasons).toEqual(["short_link"]);
    expect(cjk?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(cjk)).not.toContain("cjk66");

    const glued = await detector.detect({
      event: eventFor("x\u0442bit.ly/glue66"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();

    const bareTe = await detector.detect({
      event: eventFor("\u0442.me/+NO66"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bareTe).toBeNull();
  });

  it("folds one encoded middle dot before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("bit%C2%B7ly/lat67"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("lat67");
    expect(JSON.stringify(short)).not.toContain("%C2%B7");

    const invite = await detector.detect({
      event: eventFor("t%c2%b7me/+LAT67"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("LAT67");

    const ordinary = await detector.detect({
      event: eventFor("example%C2%B7com/page67"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const doubled = await detector.detect({
      event: eventFor("bit%25C2%25B7ly/dbl67"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(doubled).toBeNull();
  });

  it("folds encoded dot lookalikes before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("bit%E3%83%BBly/lat68"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("lat68");

    const invite = await detector.detect({
      event: eventFor("t%EF%BC%8Eme/+LAT68"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("LAT68");

    const ordinary = await detector.detect({
      event: eventFor("example%E3%83%BBcom/page68"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const period = await detector.detect({
      event: eventFor("example%E3%80%82com/stop68"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(period).toBeNull();

    const doubled = await detector.detect({
      event: eventFor("bit%25E3%2583%25BBly/dbl68"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(doubled).toBeNull();
  });

  it("drops armenian letters before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("b\u0561it.ly/lat69"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("lat69");

    const cjk = await detector.detect({
      event: eventFor("点击bit.ly/cjk69"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(cjk?.reasons).toEqual(["short_link"]);
    expect(cjk?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const glued = await detector.detect({
      event: eventFor("x\u0561bit.ly/glue69"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();

    const bare = await detector.detect({
      event: eventFor("\u0561.me/+NO69"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
  });

  it("folds a bracketed dot before reading hosts", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor("bit[.]ly/br70"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("br70");

    const paren = await detector.detect({
      event: eventFor("bit(.)ly/br70b"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(paren?.reasons).toEqual(["short_link"]);
    expect(paren?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const invite = await detector.detect({
      event: eventFor("t[.]me/+BR70"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("BR70");

    const wide = await detector.detect({
      event: eventFor("bit\uFF3B.\uFF3Dly/br70w"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wide?.reasons).toEqual(["short_link"]);
    expect(wide?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const middle = await detector.detect({
      event: eventFor("bit[\u00B7]ly/br70m"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(middle?.reasons).toEqual(["short_link"]);
    expect(middle?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const ordinary = await detector.detect({
      event: eventFor("example[.]com/page70"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const pub = await detector.detect({
      event: eventFor("t[.]me/durov"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(pub).toBeNull();

    const spaced = await detector.detect({
      event: eventFor("bit[ . ]ly/sp70"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(spaced).toBeNull();

    const encoded = await detector.detect({
      event: eventFor("bit%5B.%5Dly/enc70"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encoded?.reasons).toEqual(["short_link"]);
    expect(encoded?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(encoded)).not.toContain("enc70");

    const encodedParen = await detector.detect({
      event: eventFor("t%28.%29me/+ENC71"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encodedParen?.reasons).toEqual(["invite"]);
    expect(encodedParen?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(encodedParen)).not.toContain("ENC71");

    const dotted = await detector.detect({
      event: eventFor("bit%5B%2E%5Dly/enc71"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const doubled = await detector.detect({
      event: eventFor("bit%255B.%255Dly/dbl71"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(doubled).toBeNull();

    const ordinaryEncoded = await detector.detect({
      event: eventFor("example%5B.%5Dcom/page71"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinaryEncoded).toBeNull();
  });

  it("reads the url inside the other telegram share links and leaves the path out", async () => {
    const detector = createLinkDetector();
    const short = await detector.detect({
      event: eventFor(
        "https://t.me/share?url=https%3A%2F%2Fbit.ly%2Fname102&text=hello",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain("name102");

    const address = await detector.detect({
      event: eventFor(
        "https://t.me/msg/url?url=http%3A%2F%2F203.0.113.9%2Fpath102",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(address?.reasons).toEqual(["ip_host"]);
    expect(address?.evidence[0]?.summary).toBe("ip_host:203.0.113.9");
    expect(JSON.stringify(address)).not.toContain("path102");

    const code = "code102";
    const invite = await detector.detect({
      event: eventFor(`tg://share?url=https://t.me/+${code}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain(code);

    const preview = await detector.detect({
      event: eventFor(
        "tg://iv?url=https%3A%2F%2Fbit.ly%2Fname102&rhash=RHASH102",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(preview?.reasons).toEqual(["short_link"]);
    expect(preview?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(preview)).not.toContain("name102");
    expect(JSON.stringify(preview)).not.toContain("RHASH102");

    const composed = await detector.detect({
      event: eventFor("tg://msg?url=https%3A%2F%2Fbit.ly%2Fname102&to=durov"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(composed?.reasons).toEqual(["short_link"]);
    expect(composed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(composed)).not.toContain("name102");
    expect(JSON.stringify(composed)).not.toContain("durov");

    const comment = await detector.detect({
      event: eventFor(
        "https://t.me/share?url=https%3A%2F%2Fexample.com%2Fok102&text=see%20https%3A%2F%2Fbit.ly%2Fname102",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(comment?.reasons).toEqual(["short_link"]);
    expect(comment?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(comment)).not.toContain("name102");
    expect(JSON.stringify(comment)).not.toContain("ok102");

    const ordinary = await detector.detect({
      event: eventFor(
        "https://t.me/share?url=https%3A%2F%2Fexample.com%2Fok102&text=hello",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ordinary).toBeNull();

    const username = await detector.detect({
      event: eventFor("https://t.me/msg?url=https%3A%2F%2Fbit.ly%2Fname102"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(username).toBeNull();

    const other = await detector.detect({
      event: eventFor(
        "https://t.me/share/other?url=https%3A%2F%2Fbit.ly%2Fname102",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(other).toBeNull();

    const foreign = await detector.detect({
      event: eventFor(
        "https://example.com/share?url=https%3A%2F%2Fbit.ly%2Fname102",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(foreign).toBeNull();

    const nested = encodeURIComponent(
      `https://t.me/share/url?url=${encodeURIComponent("https://bit.ly/name102")}`,
    );
    const wrapped = await detector.detect({
      event: eventFor(`https://t.me/share?url=${nested}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped).toBeNull();
  });

  it("reads a join request bio when the event has no message", async () => {
    const detector = createLinkDetector();
    const bio = parseEvent({
      id: "evt_link",
      tenantId: "tenant_demo",
      chatId: "chat_demo",
      kind: "join_request",
      occurredAt: "2026-11-01T00:00:00.000Z",
      actor: { id: "user_1", isAdmin: false },
      profile: {
        text: "https://bit.ly/bio83 https://example.com/ok83",
        textSha256: HASH,
      },
    });
    const hit = await detector.detect({
      event: bio,
      logger: createMemoryLogger(),
      signal,
    });
    expect(hit?.reasons).toEqual(["short_link"]);
    expect(hit?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hit)).not.toContain("bio83");

    const clean = parseEvent({
      ...bio,
      profile: { text: "https://example.com/ok83", textSha256: HASH },
    });
    expect(
      await detector.detect({
        event: clean,
        logger: createMemoryLogger(),
        signal,
      }),
    ).toBeNull();
  });

  it("keeps the host Android stops on before a later authority", async () => {
    const detector = createLinkDetector();
    const path = "span119";
    const slash = "\u2215";
    const fraction = "\u2044";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly${slash}@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);

    const fractionHit = await detector.detect({
      event: eventFor(`http://bit.ly${fraction}@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fractionHit?.reasons).toEqual(["short_link"]);
    expect(fractionHit?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const encoded = await detector.detect({
      event: eventFor(`http://bit.ly%E2%88%95@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encoded?.reasons).toEqual(["short_link"]);
    expect(encoded?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(encoded)).not.toContain(path);

    const lower = await detector.detect({
      event: eventFor(`http://bit.ly%e2%88%95@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(lower).toBeNull();

    const address = "203.0.113.119";
    const ip = await detector.detect({
      event: eventFor(`http://${address}${slash}@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(path);

    const desktop = await detector.detect({
      event: eventFor(`http://example.com${slash}@bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(desktop?.reasons).toEqual(["short_link"]);
    expect(desktop?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(desktop)).not.toContain(path);

    const userinfo = await detector.detect({
      event: eventFor("http://bit.ly@example.com/ok119"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(userinfo).toBeNull();

    const docs = await detector.detect({
      event: eventFor(`http://example.com${slash}docs`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(docs).toBeNull();

    const plain = await detector.detect({
      event: eventFor("https://example.com/docs"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();
  });

  it("keeps the host Android stops on before a trailing hyphen", async () => {
    const detector = createLinkDetector();
    const path = "offer125";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly-/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);

    const doubled = await detector.detect({
      event: eventFor("http://bit.ly--/x"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(doubled?.reasons).toEqual(["short_link"]);
    expect(doubled?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const dotted = await detector.detect({
      event: eventFor("http://bit.ly-.com/x"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const address = "203.0.113.125";
    const ip = await detector.detect({
      event: eventFor(`http://${address}-/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain("/x");

    const joined = await detector.detect({
      event: eventFor("http://bit.ly-foo/keep"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined).toBeNull();

    const continued = await detector.detect({
      event: eventFor("http://203.0.113.9-1/x"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(continued).toBeNull();

    const userinfo = await detector.detect({
      event: eventFor("http://bit.ly-@example.com/ok125"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(userinfo).toBeNull();

    const password = await detector.detect({
      event: eventFor("http://bit.ly:x-@example.com/ok125"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(password).toBeNull();

    const authority = await detector.detect({
      event: eventFor("http://example.com-@bit.ly/p"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(authority?.reasons).toEqual(["short_link"]);
    expect(authority?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const invite = await detector.detect({
      event: eventFor("https://t.me-/+CODE125"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE125");
  });

  it("keeps the host Android stops on before an empty label", async () => {
    const detector = createLinkDetector();
    const path = "offer126";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly../${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);

    const tail = await detector.detect({
      event: eventFor("http://bit.ly..evil.com/x"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tail)).not.toContain("evil.com");

    const address = "203.0.113.126";
    const ip = await detector.detect({
      event: eventFor(`http://${address}../x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const joined = await detector.detect({
      event: eventFor("http://bit.ly.evil.com/keep"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined).toBeNull();

    const invite = await detector.detect({
      event: eventFor("https://t.me../+CODE126"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE126");
  });

  it("keeps the host Android stops on before an overlong port", async () => {
    const detector = createLinkDetector();
    const path = "offer127";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly:999999/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);
    expect(JSON.stringify(short)).not.toContain("999999");

    const address = "203.0.113.127";
    const ip = await detector.detect({
      event: eventFor(`http://${address}:999999/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain("999999");

    const plain = await detector.detect({
      event: eventFor("http://example.com:999999/ok"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const port = await detector.detect({
      event: eventFor("http://bit.ly:80/ok127"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(port?.reasons).toEqual(["short_link"]);
    expect(port?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const invite = await detector.detect({
      event: eventFor("https://t.me:999999/+CODE127"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE127");
  });

  it("keeps the host Android stops on before a label longer than 63 characters", async () => {
    const detector = createLinkDetector();
    const over = "a".repeat(64);
    const exact = "a".repeat(63);
    const path = "offer128";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly.${over}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);
    expect(JSON.stringify(short)).not.toContain(over);

    const address = "203.0.113.128";
    const ip = await detector.detect({
      event: eventFor(`http://${address}.${over}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(over);

    const fitted = await detector.detect({
      event: eventFor(`http://bit.ly.${exact}.example/keep`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fitted).toBeNull();

    const hyphen = await detector.detect({
      event: eventFor(`http://bit.ly.${"b".repeat(62)}-foo/keep`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphen).toBeNull();
  });

  it("keeps the host Android stops on before an underscore that cannot finish a label", async () => {
    const detector = createLinkDetector();
    const blocked = "a".repeat(62);
    const path = "offer129";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly.${blocked}_b/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);
    expect(JSON.stringify(short)).not.toContain(blocked);

    const address = "203.0.113.129";
    const ip = await detector.detect({
      event: eventFor(`http://${address}.${blocked}_b/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(blocked);

    const fitted = await detector.detect({
      event: eventFor(`http://bit.ly.${"c".repeat(61)}_b/keep`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fitted).toBeNull();

    const inside = await detector.detect({
      event: eventFor("http://bit.ly_foo/keep"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inside).toBeNull();

    const trailing = await detector.detect({
      event: eventFor("http://bit.ly_/keep"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailing).toBeNull();

    const dotted = await detector.detect({
      event: eventFor("http://203.0.113.9_/x"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["ip_host"]);
    expect(dotted?.evidence[0]?.summary).toBe("ip_host:203.0.0.113");

    const earlier = await detector.detect({
      event: eventFor(`http://bit.ly.${"d".repeat(60)}-${"e".repeat(10)}/keep`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(earlier).toBeNull();

    const invite = await detector.detect({
      event: eventFor(`https://t.me.${blocked}_/+CODE129`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE129");
  });

  it("keeps the host Android opens when a gap ends the link", async () => {
    const detector = createLinkDetector();
    const path = "offer130";
    const tail = "tail130.example";
    const short = await detector.detect({
      event: eventFor(`http://bit.ly\t${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(short)).not.toContain(path);
    expect(JSON.stringify(short)).not.toContain(tail);

    const encoded = await detector.detect({
      event: eventFor(`http://bit.ly%0A${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encoded?.reasons).toEqual(["short_link"]);
    expect(encoded?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(encoded)).not.toContain(path);
    expect(JSON.stringify(encoded)).not.toContain("%0A");

    const address = "203.0.113.130";
    const ip = await detector.detect({
      event: eventFor(`http://${address}\u00A0${tail}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(tail);

    const joined = await detector.detect({
      event: eventFor("https://bit.\nly/foldsecret"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(joined)).not.toContain("foldsecret");

    const plain = await detector.detect({
      event: eventFor(`http://example.com\t${tail}/ok`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const invite = await detector.detect({
      event: eventFor("https://t.me\t/+CODE130"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE130");
  });

  it("keeps the host Android opens when a percent-encoded tail follows", async () => {
    const detector = createLinkDetector();
    const path = "offer131";
    const tail = "tail131.example";
    const dot = await detector.detect({
      event: eventFor(`http://bit.ly%2E${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dot?.reasons).toEqual(["short_link"]);
    expect(dot?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(dot)).not.toContain(path);
    expect(JSON.stringify(dot)).not.toContain(tail);
    expect(JSON.stringify(dot)).not.toContain("%2E");

    const letter = await detector.detect({
      event: eventFor(`http://bit.ly%65${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(letter?.reasons).toEqual(["short_link"]);
    expect(letter?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(letter)).not.toContain("%65");

    const address = "203.0.113.131";
    const ip = await detector.detect({
      event: eventFor(`http://${address}%2E${tail}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(tail);

    const bracket = await detector.detect({
      event: eventFor(`http://bit.ly[.]${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bracket?.reasons).toEqual(["short_link"]);
    expect(bracket?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bracket)).not.toContain(tail);

    const joined = await detector.detect({
      event: eventFor("b%69t.ly/keep"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const plain = await detector.detect({
      event: eventFor(`http://example.com%2E${tail}/ok`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const invite = await detector.detect({
      event: eventFor("https://t.me%2Eevil.example/+CODE131"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE131");
  });

  it("keeps the host Android opens when a supplementary letter follows", async () => {
    const detector = createLinkDetector();
    const path = "offer132";
    const tail = "tail132.example";
    const greek = "\u{10140}";
    const latin = "\u{10780}";
    const marked = await detector.detect({
      event: eventFor(`http://bit.ly${greek}${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked?.reasons).toEqual(["short_link"]);
    expect(marked?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(marked)).not.toContain(path);
    expect(JSON.stringify(marked)).not.toContain(tail);
    expect(JSON.stringify(marked)).not.toContain(greek);

    const extended = await detector.detect({
      event: eventFor(`http://bit.ly${latin}${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(extended?.reasons).toEqual(["short_link"]);
    expect(extended?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(extended)).not.toContain(latin);

    const address = "203.0.113.132";
    const ip = await detector.detect({
      event: eventFor(`http://${address}${greek}${tail}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(tail);
    expect(JSON.stringify(ip)).not.toContain(greek);

    const joined = await detector.detect({
      event: eventFor(`http://b${greek}it.ly/keep`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(joined)).not.toContain(greek);

    const included = await detector.detect({
      event: eventFor(`http://bit.ly\u03B1${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(included).toBeNull();

    const plain = await detector.detect({
      event: eventFor(`http://example.com${greek}${tail}/ok`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const invite = await detector.detect({
      event: eventFor(`https://t.me${greek}/+CODE132`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE132");
    expect(JSON.stringify(invite)).not.toContain(greek);
  });

  it("keeps the host Android opens when @ cannot finish user info", async () => {
    const detector = createLinkDetector();
    const path = "offer133";
    const tail = "tail133.example";
    const marked = await detector.detect({
      event: eventFor(`http://bit.ly@.${tail}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked?.reasons).toEqual(["short_link"]);
    expect(marked?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(marked)).not.toContain(path);
    expect(JSON.stringify(marked)).not.toContain(tail);

    const address = "203.0.113.133";
    const ip = await detector.detect({
      event: eventFor(`http://${address}@.${tail}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain(tail);

    const real = await detector.detect({
      event: eventFor("http://bit.ly@example.com/ok133"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(real).toBeNull();

    const rooted = await detector.detect({
      event: eventFor(`http://bit.ly@/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(rooted).toBeNull();

    const port = await detector.detect({
      event: eventFor(`http://bit.ly@:80/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(port).toBeNull();

    const plain = await detector.detect({
      event: eventFor(`http://example.com@.${tail}/ok`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const invite = await detector.detect({
      event: eventFor(`https://t.me@.evil.example/+CODE133`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE133");
  });

  it("keeps the host Android opens after a character the path cannot include", async () => {
    const detector = createLinkDetector();
    const path = "offer134";
    const piped = await detector.detect({
      event: eventFor(`http://example.com|http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(piped?.reasons).toEqual(["short_link"]);
    expect(piped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(piped)).not.toContain(path);
    expect(JSON.stringify(piped)).not.toContain("example.com");

    const slashed = await detector.detect({
      event: eventFor(`http://example.com\\http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slashed?.reasons).toEqual(["short_link"]);
    expect(slashed?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(slashed)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`http://example.com|bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const address = "203.0.113.134";
    const ip = await detector.detect({
      event: eventFor(`http://news.example|http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const plain = await detector.detect({
      event: eventFor("http://example.com|http://news.example/ok"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const invite = await detector.detect({
      event: eventFor("http://example.com|https://t.me/+CODE134"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE134");

    const glued = await detector.detect({
      event: eventFor("https://t.me|/+CODE134"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("CODE134");
  });

  it("keeps the host Android opens after an unfinished percent", async () => {
    const detector = createLinkDetector();
    const path = "offer135";
    const stuck = await detector.detect({
      event: eventFor(`http://example.com%http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stuck?.reasons).toEqual(["short_link"]);
    expect(stuck?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stuck)).not.toContain(path);
    expect(JSON.stringify(stuck)).not.toContain("example.com");

    const slashed = await detector.detect({
      event: eventFor(`http://example.com/%http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slashed?.reasons).toEqual(["short_link"]);
    expect(slashed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(slashed)).not.toContain(path);

    const address = "203.0.113.135";
    const ip = await detector.detect({
      event: eventFor(`http://news.example%http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const encoded = await detector.detect({
      event: eventFor(`http://example.com/%20http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encoded).toBeNull();

    const bareEncoded = await detector.detect({
      event: eventFor(`http://example.com%20http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bareEncoded).toBeNull();

    const partial = await detector.detect({
      event: eventFor(`http://example.com%2Ghttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(partial).toBeNull();
    expect(JSON.stringify(partial)).not.toContain("bit.ly");

    const partialPath = await detector.detect({
      event: eventFor(`http://example.com/%2Ghttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(partialPath).toBeNull();
    expect(JSON.stringify(partialPath)).not.toContain("bit.ly");

    const nested = await detector.detect({
      event: eventFor(`http://example.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nested).toBeNull();

    const word = await detector.detect({
      event: eventFor(`seehttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(word).toBeNull();

    const underscore = await detector.detect({
      event: eventFor(`foo_http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscore).toBeNull();

    const wrapped = await detector.detect({
      event: eventFor("https://t.me/share/url?url=http%3A%2F%2Fbit.ly"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrapped?.reasons).toEqual(["short_link"]);
    expect(wrapped?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const wrappedTail = await detector.detect({
      event: eventFor(
        `https://t.me/share/url?url=http://bit.ly%http://news.example/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wrappedTail?.reasons).toEqual(["short_link"]);
    expect(wrappedTail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(wrappedTail)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor("http://example.com/%http://t.me/+CODE135"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE135");

    const glued = await detector.detect({
      event: eventFor("https://t.me%/+CODE135"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("CODE135");
  });

  it("keeps the host Android opens after a character the path class omits", async () => {
    const detector = createLinkDetector();
    const path = "offer136";
    const emoji = "\u{1F600}";
    const stuck = await detector.detect({
      event: eventFor(`http://example.com${emoji}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stuck?.reasons).toEqual(["short_link"]);
    expect(stuck?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stuck)).not.toContain(path);
    expect(JSON.stringify(stuck)).not.toContain("example.com");

    const slashed = await detector.detect({
      event: eventFor(`http://example.com/${emoji}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slashed?.reasons).toEqual(["short_link"]);
    expect(slashed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(slashed)).not.toContain(path);

    const control = String.fromCodePoint(0x85);
    const marked = await detector.detect({
      event: eventFor(`http://example.com${control}http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked?.reasons).toEqual(["short_link"]);
    expect(marked?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(marked)).not.toContain(path);

    const letter = "\u{10140}";
    const omitted = await detector.detect({
      event: eventFor(`http://example.com${letter}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(omitted?.reasons).toEqual(["short_link"]);
    expect(omitted?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(omitted)).not.toContain(path);

    const address = "203.0.113.136";
    const ip = await detector.detect({
      event: eventFor(`http://news.example${emoji}http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const han = await detector.detect({
      event: eventFor(`http://example.com/点击http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(han).toBeNull();

    const alpha = await detector.detect({
      event: eventFor(`http://bit.ly\u03B1tail.example/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(alpha).toBeNull();
    expect(JSON.stringify(alpha)).not.toContain("bit.ly");

    const invite = await detector.detect({
      event: eventFor(`http://example.com/${emoji}https://t.me/+CODE136`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE136");

    const glued = await detector.detect({
      event: eventFor(`https://t.me${emoji}/+CODE136`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("CODE136");
  });

  it("keeps the host Android opens after punctuation that ends the host", async () => {
    const detector = createLinkDetector();
    const path = "offer137";
    const bang = await detector.detect({
      event: eventFor(`http://example.com!http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bang?.reasons).toEqual(["short_link"]);
    expect(bang?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bang)).not.toContain(path);
    expect(JSON.stringify(bang)).not.toContain("example.com");

    const hash = await detector.detect({
      event: eventFor(`http://example.com#http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hash?.reasons).toEqual(["short_link"]);
    expect(hash?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(hash)).not.toContain(path);

    const address = "203.0.113.137";
    const colon = await detector.detect({
      event: eventFor(`http://news.example:http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(colon?.reasons).toEqual(["ip_host"]);
    expect(colon?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const inPath = await detector.detect({
      event: eventFor(`http://example.com/!http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inPath).toBeNull();

    const query = await detector.detect({
      event: eventFor(`http://example.com/?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query).toBeNull();

    const user = await detector.detect({
      event: eventFor(`http://user:pass@bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(path);

    const realUser = await detector.detect({
      event: eventFor("http://bit.ly@example.com"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(realUser).toBeNull();

    const invite = await detector.detect({
      event: eventFor("http://example.com!https://t.me/+CODE137"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE137");

    const glued = await detector.detect({
      event: eventFor("https://t.me!/+CODE137"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("CODE137");
  });

  it("keeps the host Android opens after a bare domain ends", async () => {
    const detector = createLinkDetector();
    const path = "offer138";
    const hyphen = await detector.detect({
      event: eventFor(`www.example.com-http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphen?.reasons).toEqual(["short_link"]);
    expect(hyphen?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hyphen)).not.toContain(path);
    expect(JSON.stringify(hyphen)).not.toContain("example.com");

    const dot = await detector.detect({
      event: eventFor(`www.example.com.http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dot?.reasons).toEqual(["short_link"]);
    expect(dot?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(dot)).not.toContain(path);

    const mark = "\u00A1";
    const letter = await detector.detect({
      event: eventFor(`www.example.com${mark}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(letter?.reasons).toEqual(["short_link"]);
    expect(letter?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(letter)).not.toContain(path);

    const address = "203.0.113.138";
    const bare = await detector.detect({
      event: eventFor(`example.com.http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["ip_host"]);
    expect(bare?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const port = await detector.detect({
      event: eventFor(`http://example.com:80-bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(port?.reasons).toEqual(["short_link"]);
    expect(port?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(port)).not.toContain(path);

    const overlong = await detector.detect({
      event: eventFor(`http://news.example:123456.http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(overlong?.reasons).toEqual(["ip_host"]);
    expect(overlong?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const inPath = await detector.detect({
      event: eventFor(`www.example.com/!http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inPath).toBeNull();

    const query = await detector.detect({
      event: eventFor(`www.example.com?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query).toBeNull();

    const schemed = await detector.detect({
      event: eventFor(`http://example.com${mark}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();

    const still = await detector.detect({
      event: eventFor(`www.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(still?.reasons).toEqual(["short_link"]);
    expect(still?.evidence[0]?.summary).toBe("short_link:www.bit.ly");
    expect(JSON.stringify(still)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor("www.example.com-https://t.me/+CODE138"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE138");

    const glued = await detector.detect({
      event: eventFor("www.t.me.evil.example/+CODE138"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("CODE138");
  });

  it("keeps the host Android opens after a dot that does not start a label", async () => {
    const detector = createLinkDetector();
    const path = "offer139";
    const dots = await detector.detect({
      event: eventFor(`http://example.com..http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dots?.reasons).toEqual(["short_link"]);
    expect(dots?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(dots)).not.toContain(path);
    expect(JSON.stringify(dots)).not.toContain("example.com");

    const hyphen = await detector.detect({
      event: eventFor(`http://example.com.-http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphen?.reasons).toEqual(["short_link"]);
    expect(hyphen?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(hyphen)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`http://example.com.-bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const address = "203.0.113.139";
    const ip = await detector.detect({
      event: eventFor(`http://news.example..http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const joined = await detector.detect({
      event: eventFor(`http://example.com.http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined).toBeNull();

    const slash = await detector.detect({
      event: eventFor(`http://example.com./http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();

    const query = await detector.detect({
      event: eventFor(`http://example.com.?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query).toBeNull();

    const interior = await detector.detect({
      event: eventFor(`http://example.com-http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(interior).toBeNull();

    const underscore = await detector.detect({
      event: eventFor(`http://example.com._http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscore).toBeNull();

    const port = await detector.detect({
      event: eventFor(`http://example.com.:80!http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(port?.reasons).toEqual(["short_link"]);
    expect(port?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(port)).not.toContain(path);

    const still = await detector.detect({
      event: eventFor(`http://bit.ly./${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(still?.reasons).toEqual(["short_link"]);
    expect(still?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(still)).not.toContain(path);

    const user = await detector.detect({
      event: eventFor(`http://user:pass@bit.ly./${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(path);

    const emptyHost = await detector.detect({
      event: eventFor(`http://bit.ly@/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(emptyHost).toBeNull();

    const invite = await detector.detect({
      event: eventFor("http://example.com..https://t.me/+CODE139"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE139");

    const glued = await detector.detect({
      event: eventFor("https://t.me../+CODE139"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("CODE139");

    const dottedInvite = await detector.detect({
      event: eventFor("https://t.me./+CODE139"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dottedInvite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(dottedInvite)).not.toContain("CODE139");
  });

  it("keeps the host Android opens after user info that is too long", async () => {
    const detector = createLinkDetector();
    const path = "offer140";
    const user = "a".repeat(65);
    const fitted = "a".repeat(64);
    const longPass = "p".repeat(26);
    const fittedPass = "p".repeat(25);
    const over = await detector.detect({
      event: eventFor(`http://${user}@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(over?.reasons).toEqual(["short_link"]);
    expect(over?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(over)).not.toContain(path);
    expect(JSON.stringify(over)).not.toContain(user);

    const bare = await detector.detect({
      event: eventFor(`http://${user}@bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const password = await detector.detect({
      event: eventFor(`http://user:${longPass}@http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(password?.reasons).toEqual(["short_link"]);
    expect(password?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(password)).not.toContain(path);
    expect(JSON.stringify(password)).not.toContain(longPass);

    const address = "203.0.113.140";
    const ip = await detector.detect({
      event: eventFor(`http://user:${longPass}@http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const within = await detector.detect({
      event: eventFor(`http://${fitted}@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(within).toBeNull();

    const withinPass = await detector.detect({
      event: eventFor(`http://user:${fittedPass}@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(withinPass).toBeNull();

    const glued = await detector.detect({
      event: eventFor(`http://${user}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();

    const still = await detector.detect({
      event: eventFor(`http://${fitted}@bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(still?.reasons).toEqual(["short_link"]);
    expect(still?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(still)).not.toContain(path);

    const normal = await detector.detect({
      event: eventFor(`http://user:pass@bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(normal?.reasons).toEqual(["short_link"]);
    expect(normal?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(normal)).not.toContain(path);

    const realUser = await detector.detect({
      event: eventFor("http://bit.ly@example.com"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(realUser).toBeNull();

    const invite = await detector.detect({
      event: eventFor(`http://${user}@https://t.me/+CODE140`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE140");
    expect(JSON.stringify(invite)).not.toContain(user);

    const stuck = await detector.detect({
      event: eventFor(`https://t.me:${longPass}@/+CODE140`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stuck).toBeNull();
    expect(JSON.stringify(stuck)).not.toContain("CODE140");
  });

  it("keeps the host Android opens after a label that does not fit", async () => {
    const detector = createLinkDetector();
    const path = "offer141";
    const over = await detector.detect({
      event: eventFor(`http://${"a".repeat(59)}-http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(over?.reasons).toEqual(["short_link"]);
    expect(over?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(over)).not.toContain(path);
    expect(JSON.stringify(over)).not.toContain("a".repeat(59));

    const bare = await detector.detect({
      event: eventFor(`http://${"a".repeat(60)}-bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const address = "203.0.113.141";
    const ip = await detector.detect({
      event: eventFor(`http://${"a".repeat(60)}-http://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const dotted = await detector.detect({
      event: eventFor(`http://${"a".repeat(64)}.http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const repeated = await detector.detect({
      event: eventFor(`http://${"a-".repeat(40)}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(repeated?.reasons).toEqual(["short_link"]);
    expect(repeated?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(repeated)).not.toContain(path);

    const fitted = await detector.detect({
      event: eventFor(`http://${"a".repeat(58)}-http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fitted).toBeNull();

    const fittedBare = await detector.detect({
      event: eventFor(`http://${"a".repeat(59)}-bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fittedBare).toBeNull();

    const fittedDot = await detector.detect({
      event: eventFor(`http://${"a".repeat(63)}.http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fittedDot).toBeNull();

    const glued = await detector.detect({
      event: eventFor(`http://${"a".repeat(65)}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();

    const underscored = await detector.detect({
      event: eventFor(`http://${"a".repeat(62)}_http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscored).toBeNull();

    const inPath = await detector.detect({
      event: eventFor(
        `http://example.com/${"a".repeat(70)}-http://bit.ly/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inPath).toBeNull();

    const inside = await detector.detect({
      event: eventFor(`http://bit.ly_foo/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inside).toBeNull();

    const invite = await detector.detect({
      event: eventFor(`http://${"a".repeat(63)}-https://t.me/+CODE141`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE141");

    const stuck = await detector.detect({
      event: eventFor(`https://t.me-${"a".repeat(63)}/+CODE141`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stuck).toBeNull();
    expect(JSON.stringify(stuck)).not.toContain("CODE141");
  });

  it("keeps the bare IPv4 Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer142";
    const address = "203.0.113.142";
    const alone = await detector.detect({
      event: eventFor(`${address}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(alone?.reasons).toEqual(["ip_host"]);
    expect(alone?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(alone)).not.toContain(path);

    const released = await detector.detect({
      event: eventFor(`http://${"a".repeat(60)}-${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(released?.reasons).toEqual(["ip_host"]);
    expect(released?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(released)).not.toContain("a".repeat(60));

    const marked = await detector.detect({
      event: eventFor(`http://example.com!${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked?.reasons).toEqual(["ip_host"]);
    expect(marked?.evidence[0]?.summary).toBe(`ip_host:${address}`);

    const version = await detector.detect({
      event: eventFor("1.2.3.4"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(version?.reasons).toEqual(["ip_host"]);
    expect(version?.evidence[0]?.summary).toBe("ip_host:1.2.3.4");

    const leading = await detector.detect({
      event: eventFor("010.0.0.1"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(leading?.reasons).toEqual(["ip_host"]);
    expect(leading?.evidence[0]?.summary).toBe("ip_host:8.0.0.1");
    expect(JSON.stringify(leading)).not.toContain("010");

    const schemed = await detector.detect({
      event: eventFor(`http://${address}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed?.reasons).toEqual(["ip_host"]);
    expect(schemed?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(schemed)).not.toContain(path);

    const fitted = await detector.detect({
      event: eventFor(`http://${"a".repeat(50)}-${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fitted).toBeNull();

    const domain = await detector.detect({
      event: eventFor(`${address}.example.com`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(domain).toBeNull();

    const zero = await detector.detect({
      event: eventFor("0.0.0.0"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(zero).toBeNull();

    const padded = await detector.detect({
      event: eventFor("1.2.3.00"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(padded).toBeNull();

    const glued = await detector.detect({
      event: eventFor(`v${address}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();

    const inPath = await detector.detect({
      event: eventFor(`http://example.com/${address}/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inPath).toBeNull();
    expect(JSON.stringify(inPath)).not.toContain(path);

    const buried = await detector.detect({
      event: eventFor(
        "tg://msg?text=https%3A%2F%2Fexample.com%2Fok142&to=198.51.100.20",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(buried).toBeNull();
    expect(JSON.stringify(buried)).not.toContain("198.51.100.20");

    const invite = await detector.detect({
      event: eventFor("https://t.me/+CODE142"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE142");
  });

  it("keeps the host Android opens after tg: without slashes", async () => {
    const detector = createLinkDetector();
    const path = "offer143";
    const plain = await detector.detect({
      event: eventFor(`tg:http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain?.reasons).toEqual(["short_link"]);
    expect(plain?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(plain)).not.toContain(path);

    const address = "203.0.113.143";
    const ip = await detector.detect({
      event: eventFor(`tg:${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain("/x");

    const seen = await detector.detect({
      event: eventFor(`see tg:http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(seen?.reasons).toEqual(["short_link"]);
    expect(seen?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(seen)).not.toContain(path);

    const slashed = await detector.detect({
      event: eventFor(`tg://http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slashed).toBeNull();
    expect(JSON.stringify(slashed)).not.toContain("bit.ly");

    const slashedIp = await detector.detect({
      event: eventFor(`tg://${address}/x`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slashedIp).toBeNull();
    expect(JSON.stringify(slashedIp)).not.toContain(address);

    const buried = await detector.detect({
      event: eventFor(
        "tg://msg?text=https%3A%2F%2Fexample.com%2Fok143&to=198.51.100.20",
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(buried).toBeNull();
    expect(JSON.stringify(buried)).not.toContain("198.51.100.20");

    const join = await detector.detect({
      event: eventFor("tg:join?invite=CODE143"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(join?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(join)).not.toContain("CODE143");

    const linked = await detector.detect({
      event: eventFor("tg:https://t.me/+CODE143"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(linked?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(linked)).not.toContain("CODE143");
  });

  it("keeps a question mark on the bare host Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer144";
    const plain = await detector.detect({
      event: eventFor(`example.com?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();
    expect(JSON.stringify(plain)).not.toContain("bit.ly");
    expect(JSON.stringify(plain)).not.toContain(path);

    const ported = await detector.detect({
      event: eventFor(`example.com:80?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ported).toBeNull();
    expect(JSON.stringify(ported)).not.toContain("bit.ly");

    const address = "203.0.113.144";
    const ip = await detector.detect({
      event: eventFor(`${address}?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence[0]?.summary).toBe(`ip_host:${address}`);
    expect(JSON.stringify(ip)).not.toContain("bit.ly");
    expect(JSON.stringify(ip)).not.toContain(path);

    const short = await detector.detect({
      event: eventFor(`bit.ly?http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly",
    ]);
    expect(JSON.stringify(short)).not.toContain("t.co");
    expect(JSON.stringify(short)).not.toContain(path);

    const bang = await detector.detect({
      event: eventFor(`example.com:80!http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bang?.reasons).toEqual(["short_link"]);
    expect(bang?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bang)).not.toContain(path);

    const longPort = await detector.detect({
      event: eventFor(`example.com:123456-http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(longPort?.reasons).toEqual(["short_link"]);
    expect(longPort?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const dotted = await detector.detect({
      event: eventFor(`example.com./http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const invite = await detector.detect({
      event: eventFor(`t.me/+CODE144?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain("CODE144");
    expect(JSON.stringify(invite)).not.toContain("bit.ly");
  });

  it("keeps an apostrophe inside the path Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer145";
    const plain = await detector.detect({
      event: eventFor(`http://example.com/'http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();
    expect(JSON.stringify(plain)).not.toContain("bit.ly");
    expect(JSON.stringify(plain)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`example.com/'http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
    expect(JSON.stringify(bare)).not.toContain("bit.ly");

    const www = await detector.detect({
      event: eventFor(`www.example.com/'http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(www).toBeNull();
    expect(JSON.stringify(www)).not.toContain("bit.ly");

    const query = await detector.detect({
      event: eventFor(`http://example.com?x='http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query).toBeNull();
    expect(JSON.stringify(query)).not.toContain("bit.ly");

    const address = "203.0.113.145";
    const ip = await detector.detect({
      event: eventFor(`${address}/'http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toEqual(["ip_host"]);
    expect(ip?.evidence.map((item) => item.summary)).toEqual([
      `ip_host:${address}`,
    ]);
    expect(JSON.stringify(ip)).not.toContain("bit.ly");
    expect(JSON.stringify(ip)).not.toContain(path);

    const short = await detector.detect({
      event: eventFor(`bit.ly/'http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(short?.reasons).toEqual(["short_link"]);
    expect(short?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly",
    ]);
    expect(JSON.stringify(short)).not.toContain("t.co");
    expect(JSON.stringify(short)).not.toContain(path);

    const before = await detector.detect({
      event: eventFor(`http://example.com'http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(before?.reasons).toEqual(["short_link"]);
    expect(before?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(before)).not.toContain(path);

    const glued = await detector.detect({
      event: eventFor(`example.com'bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued?.reasons).toEqual(["short_link"]);
    expect(glued?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const quoted = await detector.detect({
      event: eventFor(`http://example.com/"http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(quoted?.reasons).toEqual(["short_link"]);
    expect(quoted?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const invite = await detector.detect({
      event: eventFor(`https://t.me/+CODE145'http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE145");
    expect(JSON.stringify(invite)).not.toContain("bit.ly");

    const clean = await detector.detect({
      event: eventFor("https://t.me/+CODE145"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(clean?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(clean)).not.toContain("CODE145");
  });

  it("keeps the spaces Android leaves inside a label", async () => {
    const detector = createLinkDetector();
    const path = "offer146";
    const ogham = "\u1680";
    const math = "\u205F";
    const bom = "\uFEFF";
    const kept = await detector.detect({
      event: eventFor(`http://example.com/${ogham}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(kept).toBeNull();
    expect(JSON.stringify(kept)).not.toContain("bit.ly");
    expect(JSON.stringify(kept)).not.toContain(path);

    const query = await detector.detect({
      event: eventFor(`http://example.com?${math}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query).toBeNull();
    expect(JSON.stringify(query)).not.toContain("bit.ly");

    const marked = await detector.detect({
      event: eventFor(`example.com/${bom}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked).toBeNull();
    expect(JSON.stringify(marked)).not.toContain("bit.ly");

    const glued = await detector.detect({
      event: eventFor(`http://example.com${ogham}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("bit.ly");

    const tail = await detector.detect({
      event: eventFor(`http://bit.ly${ogham}foo`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail).toBeNull();
    expect(JSON.stringify(tail)).not.toContain("bit.ly");

    const joined = await detector.detect({
      event: eventFor(`http://bit${ogham}.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(joined)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`example.com${ogham}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const spaced = await detector.detect({
      event: eventFor(`http://example.com/\u00A0http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(spaced?.reasons).toEqual(["short_link"]);
    expect(spaced?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(spaced)).not.toContain(path);
  });

  it("keeps a label character Android leaves on the host", async () => {
    const detector = createLinkDetector();
    const path = "offer147";
    const comma = await detector.detect({
      event: eventFor("http://bit.ly，广告"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(comma).toBeNull();
    expect(JSON.stringify(comma)).not.toContain("bit.ly");

    const zwsp = await detector.detect({
      event: eventFor("http://bit.ly\u200Bfoo"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(zwsp).toBeNull();
    expect(JSON.stringify(zwsp)).not.toContain("bit.ly");

    const han = await detector.detect({
      event: eventFor("http://bit.ly点击"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(han).toBeNull();
    expect(JSON.stringify(han)).not.toContain("bit.ly");

    const joined = await detector.detect({
      event: eventFor(`http://bit\u200B.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(joined)).not.toContain(path);

    const slash = "\u2215";
    const authority = await detector.detect({
      event: eventFor(`http://bit.ly${slash}@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(authority?.reasons).toEqual(["short_link"]);
    expect(authority?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(authority)).not.toContain(path);
  });

  it("keeps the dot Android drops before a www path", async () => {
    const detector = createLinkDetector();
    const path = "offer148";
    const dotted = await detector.detect({
      event: eventFor(`www.example.com./http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);
    expect(JSON.stringify(dotted)).not.toContain("t.co");

    const query = await detector.detect({
      event: eventFor(`www.example.com.?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query?.reasons).toEqual(["short_link"]);
    expect(query?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(query)).not.toContain(path);

    const ported = await detector.detect({
      event: eventFor(`www.example.com.:80/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ported?.reasons).toEqual(["short_link"]);
    expect(ported?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(ported)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`www.example.com./bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const both = await detector.detect({
      event: eventFor(`www.bit.ly./http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(both?.reasons).toEqual(["short_link"]);
    expect(both?.evidence[0]?.summary).toBe("short_link:www.bit.ly");
    expect(JSON.stringify(both)).not.toContain("t.co");
    expect(JSON.stringify(both)).not.toContain(path);

    const kept = await detector.detect({
      event: eventFor(`www.example.com?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(kept).toBeNull();
    expect(JSON.stringify(kept)).not.toContain("bit.ly");
    expect(JSON.stringify(kept)).not.toContain(path);

    const schemed = await detector.detect({
      event: eventFor(`http://www.example.com./http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const coded = "CODE148";
    const broken = await detector.detect({
      event: eventFor(`www.t.me./+${coded}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(broken).toBeNull();
    expect(JSON.stringify(broken)).not.toContain(coded);

    const invite = await detector.detect({
      event: eventFor(`www.t.me/+${coded}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain(coded);

    const joined = await detector.detect({
      event: eventFor(`https://t.me./+${coded}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(joined)).not.toContain(coded);
  });

  it("keeps a short link Android opens after a suffix it does not treat as a TLD", async () => {
    const detector = createLinkDetector();
    const path = "offer149";
    const plain = await detector.detect({
      event: eventFor(`foo.example/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain?.reasons).toEqual(["short_link"]);
    expect(plain?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(plain)).not.toContain(path);
    expect(JSON.stringify(plain)).not.toContain("example");

    const query = await detector.detect({
      event: eventFor(`foo.example?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(query?.reasons).toEqual(["short_link"]);
    expect(query?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(query)).not.toContain(path);

    const tested = await detector.detect({
      event: eventFor(`foo.test/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tested?.reasons).toEqual(["short_link"]);
    expect(tested?.evidence[0]?.summary).toBe("short_link:bit.ly");

    const nested = await detector.detect({
      event: eventFor(`www.foo.example/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nested?.reasons).toEqual(["short_link"]);
    expect(nested?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(nested)).not.toContain(path);

    const earlier = await detector.detect({
      event: eventFor(`foo.bar.example/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(earlier?.reasons).toEqual(["short_link"]);
    expect(earlier?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(earlier)).not.toContain(path);

    const real = await detector.detect({
      event: eventFor(`example.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(real).toBeNull();
    expect(JSON.stringify(real)).not.toContain("bit.ly");
    expect(JSON.stringify(real)).not.toContain(path);

    const www = await detector.detect({
      event: eventFor(`www.example.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(www).toBeNull();
    expect(JSON.stringify(www)).not.toContain("bit.ly");

    const puny = await detector.detect({
      event: eventFor(`example.xn--p1ai/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(puny).toBeNull();
    expect(JSON.stringify(puny)).not.toContain("bit.ly");
    expect(JSON.stringify(puny)).not.toContain("xn--");

    const shaped = await detector.detect({
      event: eventFor(`foo.xn--a/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shaped).toBeNull();
    expect(JSON.stringify(shaped)).not.toContain("bit.ly");

    const han = await detector.detect({
      event: eventFor(`例子.中国/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(han).toBeNull();
    expect(JSON.stringify(han)).not.toContain("bit.ly");

    const asciiHan = await detector.detect({
      event: eventFor(`example.中国/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(asciiHan).toBeNull();
    expect(JSON.stringify(asciiHan)).not.toContain("bit.ly");

    const spaced = await detector.detect({
      event: eventFor(`见 例子.中国/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(spaced?.reasons).toEqual(["short_link"]);
    expect(spaced?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(spaced)).not.toContain(path);

    const schemed = await detector.detect({
      event: eventFor(`http://foo.example/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const coded = "CODE149";
    const invite = await detector.detect({
      event: eventFor(`foo.example/https://t.me/+${coded}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(invite)).not.toContain(coded);
    expect(JSON.stringify(invite)).not.toContain("bit.ly");

    const clean = await detector.detect({
      event: eventFor(`https://t.me/+${coded}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(clean?.reasons).toEqual(["invite"]);
    expect(JSON.stringify(clean)).not.toContain(coded);

    const scheme = await detector.detect({
      event: eventFor(`example.http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(scheme?.reasons).toEqual(["short_link"]);
    expect(scheme?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(scheme)).not.toContain(path);
  });

  it("keeps an underscore Android leaves inside a bare label", async () => {
    const detector = createLinkDetector();
    const path = "offer150";
    const mixed = await detector.detect({
      event: eventFor(`a例.ly/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(mixed).toBeNull();
    expect(JSON.stringify(mixed)).not.toContain("bit.ly");
    expect(JSON.stringify(mixed)).not.toContain(path);

    const reversed = await detector.detect({
      event: eventFor(`例a.ly/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(reversed).toBeNull();
    expect(JSON.stringify(reversed)).not.toContain("bit.ly");

    const marked = await detector.detect({
      event: eventFor(`www.a例.ly/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked).toBeNull();
    expect(JSON.stringify(marked)).not.toContain("bit.ly");
    expect(JSON.stringify(marked)).not.toContain(path);

    const queried = await detector.detect({
      event: eventFor(`a例.ly?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(queried).toBeNull();
    expect(JSON.stringify(queried)).not.toContain("bit.ly");

    const underscored = await detector.detect({
      event: eventFor(`foo_bar.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscored).toBeNull();
    expect(JSON.stringify(underscored)).not.toContain("bit.ly");
    expect(JSON.stringify(underscored)).not.toContain(path);

    const wwwUnder = await detector.detect({
      event: eventFor(`www.foo_bar.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wwwUnder).toBeNull();
    expect(JSON.stringify(wwwUnder)).not.toContain("bit.ly");

    const tail = await detector.detect({
      event: eventFor(`foo_.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tail)).not.toContain(path);

    const head = await detector.detect({
      event: eventFor(`_foo.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(head?.reasons).toEqual(["short_link"]);
    expect(head?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(head)).not.toContain(path);

    const glued = await detector.detect({
      event: eventFor(`example.com_http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("bit.ly");

    const hyphen = await detector.detect({
      event: eventFor(`foo-.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphen?.reasons).toEqual(["short_link"]);
    expect(hyphen?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hyphen)).not.toContain(path);
  });
});
