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

  it("reads a call username draft and leaves a group call slug", async () => {
    const hidden = "offer198";
    const slug = "room198";
    const code = "CODE198";
    const address = "203.0.113.198";
    const detector = createLinkDetector();
    const user = await detector.detect({
      event: eventFor(
        `https://t.me/call?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const deep = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=call&text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(
        `https://call.t.me?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const capital = await detector.detect({
      event: eventFor(
        `https://t.me/Call/${slug}?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(capital)).not.toContain(slug);
    const call = await detector.detect({
      event: eventFor(
        `https://t.me/call/${slug}?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(call).toBeNull();
    expect(JSON.stringify(call)).not.toContain(hidden);
    expect(JSON.stringify(call)).not.toContain(slug);
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/call/${slug}/?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/call/${slug}?text=${encodeURIComponent(`https://t.me/+${code}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(code);
    const slash = await detector.detect({
      event: eventFor(
        `https://t.me/call/?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();
    expect(JSON.stringify(slash)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(
        `https://t.me/call/123?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    const sub = await detector.detect({
      event: eventFor(
        `https://call.t.me/${slug}?text=${encodeURIComponent(`https://bit.ly/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(sub).toBeNull();
    const digits = await detector.detect({
      event: eventFor(
        `https://call.t.me/123?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(digits).toBeNull();
    expect(JSON.stringify(digits)).not.toContain(address);
  });

  it("skips a profile link and still reads an overridden draft", async () => {
    const hidden = "offer199";
    const address = "203.0.113.199";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const profile = await detector.detect({
      event: eventFor(`https://t.me/durov?profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(profile).toBeNull();
    expect(JSON.stringify(profile)).not.toContain(hidden);
    const empty = await detector.detect({
      event: eventFor(`https://www.telegram.dog/durov?profile&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(empty).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/durov/123?profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const sub = await detector.detect({
      event: eventFor(`https://durov.t.me?profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(sub).toBeNull();
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep).toBeNull();
    const preview = await detector.detect({
      event: eventFor(`https://t.me/s/durov?profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(preview).toBeNull();
    const phone = await detector.detect({
      event: eventFor(
        `https://t.me/+79990001199?profile=1&text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(phone).toBeNull();
    expect(JSON.stringify(phone)).not.toContain(address);
    const zero = await detector.detect({
      event: eventFor(`https://t.me/durov?profile=0&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(zero?.reasons).toEqual(["short_link"]);
    expect(zero?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(zero)).not.toContain(hidden);
    const capital = await detector.detect({
      event: eventFor(`https://t.me/durov?Profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const started = await detector.detect({
      event: eventFor(`https://t.me/durov?profile=1&start=hi&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(started?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const game = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=durov&profile=1&game=game1&text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(game?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const plainGame = await detector.detect({
      event: eventFor(
        `tg://resolve?domain=durov&profile=1&game=a+b&text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plainGame).toBeNull();
    const grouped = await detector.detect({
      event: eventFor(`https://t.me/durov?profile=1&startgroup=&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(grouped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const app = await detector.detect({
      event: eventFor(`https://telegram.me/durov/shop?profile=1&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(app?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(app)).not.toContain("shop");
    expect(JSON.stringify(app)).not.toContain("durov");
  });

  it("skips a resolve story and still reads a web story query", async () => {
    const hidden = "offer200";
    const address = "203.0.113.200";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const story = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&story=5&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(story).toBeNull();
    expect(JSON.stringify(story)).not.toContain(hidden);
    const album = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&album=3&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(album).toBeNull();
    const collection = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&collection=2&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(collection).toBeNull();
    const phone = await detector.detect({
      event: eventFor(
        `tg://resolve?phone=79990001199&story=4&text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(phone).toBeNull();
    expect(JSON.stringify(phone)).not.toContain(address);
    const bare = await detector.detect({
      event: eventFor(`tg:resolve?domain=durov&story=9&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare).toBeNull();
    const web = await detector.detect({
      event: eventFor(`https://t.me/durov?story=5&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(web?.reasons).toEqual(["short_link"]);
    expect(web?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(web)).not.toContain(hidden);
    const zero = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&story=0&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(zero?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const live = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&story=live&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(live?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const capital = await detector.detect({
      event: eventFor(`tg://resolve?domain=durov&Story=5&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(capital)).not.toContain("durov");
  });

  it("reads an addstyle username draft and leaves a style slug", async () => {
    const hidden = "offer201";
    const slug = "tone201";
    const address = "203.0.113.201";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/addstyle?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/addstyle/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://addstyle.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=addstyle&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("addstyle");
    const style = await detector.detect({
      event: eventFor(`https://t.me/addstyle/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(style).toBeNull();
    expect(JSON.stringify(style)).not.toContain(hidden);
    expect(JSON.stringify(style)).not.toContain(slug);
    const capital = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/AddStyle/${slug}/?text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/addstyle/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://addstyle.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads an invoice username draft and leaves an invoice slug", async () => {
    const hidden = "offer202";
    const slug = "pay202";
    const address = "203.0.113.202";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/invoice?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/invoice/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://invoice.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=invoice&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("invoice");
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/invoice/pay.now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(hidden);
    const payment = await detector.detect({
      event: eventFor(`https://t.me/invoice/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(payment).toBeNull();
    expect(JSON.stringify(payment)).not.toContain(hidden);
    expect(JSON.stringify(payment)).not.toContain(slug);
    const underscored = await detector.detect({
      event: eventFor(`https://t.me/invoice/pay_now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscored).toBeNull();
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/invoice/pay-now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated).toBeNull();
    const capital = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/Invoice/${slug}/?text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/invoice/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://invoice.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads an addemoji username draft and leaves an emoji set", async () => {
    const hidden = "offer203";
    const slug = "pack203";
    const address = "203.0.113.203";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/addemoji?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/addemoji/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://addemoji.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=addemoji&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("addemoji");
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/addemoji/pack-now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hyphenated)).not.toContain(hidden);
    const capital = await detector.detect({
      event: eventFor(`https://t.me/AddEmoji/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const trailed = await detector.detect({
      event: eventFor(`https://t.me/addemoji/${slug}/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const set = await detector.detect({
      event: eventFor(`https://t.me/addemoji/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(set).toBeNull();
    expect(JSON.stringify(set)).not.toContain(hidden);
    expect(JSON.stringify(set)).not.toContain(slug);
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/addemoji/pack.now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const underscored = await detector.detect({
      event: eventFor(`https://t.me/addemoji/pack_now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscored).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/addemoji/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/addemoji/${slug}?text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/addemoji/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://addemoji.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads an addstickers username draft and leaves a sticker set", async () => {
    const hidden = "offer204";
    const slug = "pack204";
    const address = "203.0.113.204";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/addstickers?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/addstickers/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://addstickers.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=addstickers&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("addstickers");
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/addstickers/pack-now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hyphenated)).not.toContain(hidden);
    const capital = await detector.detect({
      event: eventFor(`https://t.me/AddStickers/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const trailed = await detector.detect({
      event: eventFor(`https://t.me/addstickers/${slug}/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const set = await detector.detect({
      event: eventFor(`https://t.me/addstickers/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(set).toBeNull();
    expect(JSON.stringify(set)).not.toContain(hidden);
    expect(JSON.stringify(set)).not.toContain(slug);
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/addstickers/pack.now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const underscored = await detector.detect({
      event: eventFor(`https://t.me/addstickers/pack_now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscored).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/addstickers/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/addstickers/${slug}?text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/addstickers/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://addstickers.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads an addtheme username draft and leaves a theme slug", async () => {
    const hidden = "offer205";
    const slug = "theme205";
    const address = "203.0.113.205";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/addtheme?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/addtheme/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://addtheme.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=addtheme&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("addtheme");
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/addtheme/theme-now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(hyphenated)).not.toContain(hidden);
    const capital = await detector.detect({
      event: eventFor(`https://t.me/AddTheme/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const trailed = await detector.detect({
      event: eventFor(`https://t.me/addtheme/${slug}/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const set = await detector.detect({
      event: eventFor(`https://t.me/addtheme/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(set).toBeNull();
    expect(JSON.stringify(set)).not.toContain(hidden);
    expect(JSON.stringify(set)).not.toContain(slug);
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/addtheme/theme.now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const underscored = await detector.detect({
      event: eventFor(`https://t.me/addtheme/theme_now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(underscored).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/addtheme/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/addtheme/${slug}?text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/addtheme/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://addtheme.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads a setlanguage username draft and leaves a language pack", async () => {
    const hidden = "offer206";
    const slug = "lang206";
    const address = "203.0.113.206";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/setlanguage?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/setlanguage/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://setlanguage.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=setlanguage&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("setlanguage");
    const capital = await detector.detect({
      event: eventFor(`https://t.me/SetLanguage/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const trailed = await detector.detect({
      event: eventFor(`https://t.me/setlanguage/${slug}/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const pack = await detector.detect({
      event: eventFor(`https://t.me/setlanguage/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(pack).toBeNull();
    expect(JSON.stringify(pack)).not.toContain(hidden);
    expect(JSON.stringify(pack)).not.toContain(slug);
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/setlanguage/zh-hans?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated).toBeNull();
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/setlanguage/zh.hans?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/setlanguage/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const dog = await detector.detect({
      event: eventFor(
        `https://www.telegram.dog/setlanguage/${slug}?text=${draft}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/setlanguage/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://setlanguage.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads an nft username draft and leaves a gift slug", async () => {
    const hidden = "offer207";
    const slug = "gift207";
    const address = "203.0.113.207";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/nft?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/nft/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://nft.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=nft&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("nft");
    const capital = await detector.detect({
      event: eventFor(`https://t.me/Nft/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const trailed = await detector.detect({
      event: eventFor(`https://t.me/nft/${slug}/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const gift = await detector.detect({
      event: eventFor(`https://t.me/nft/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(gift).toBeNull();
    expect(JSON.stringify(gift)).not.toContain(hidden);
    expect(JSON.stringify(gift)).not.toContain(slug);
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/nft/gift-now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated).toBeNull();
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/nft/gift.now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/nft/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const dog = await detector.detect({
      event: eventFor(`https://www.telegram.dog/nft/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/nft/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://nft.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
  });

  it("reads an auction username draft and leaves an auction slug", async () => {
    const hidden = "offer208";
    const slug = "lot208";
    const address = "203.0.113.208";
    const detector = createLinkDetector();
    const draft = encodeURIComponent(`https://bit.ly/${hidden}`);
    const user = await detector.detect({
      event: eventFor(`https://t.me/auction?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(hidden);
    const slash = await detector.detect({
      event: eventFor(`https://t.me/auction/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const prefixed = await detector.detect({
      event: eventFor(`https://auction.t.me?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const deep = await detector.detect({
      event: eventFor(`tg://resolve?domain=auction&text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(deep?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(deep)).not.toContain("auction");
    const capital = await detector.detect({
      event: eventFor(`https://t.me/Auction/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(capital?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const trailed = await detector.detect({
      event: eventFor(`https://t.me/auction/${slug}/?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    const lot = await detector.detect({
      event: eventFor(`https://t.me/auction/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(lot).toBeNull();
    expect(JSON.stringify(lot)).not.toContain(hidden);
    expect(JSON.stringify(lot)).not.toContain(slug);
    const hyphenated = await detector.detect({
      event: eventFor(`https://t.me/auction/lot-now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphenated).toBeNull();
    const dotted = await detector.detect({
      event: eventFor(`https://t.me/auction/lot.now?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    const post = await detector.detect({
      event: eventFor(`https://t.me/auction/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(post).toBeNull();
    const dog = await detector.detect({
      event: eventFor(`https://www.telegram.dog/auction/${slug}?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dog).toBeNull();
    const me = await detector.detect({
      event: eventFor(
        `https://telegram.me/auction/${slug}?text=${encodeURIComponent(`http://${address}/${hidden}`)}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(me).toBeNull();
    expect(JSON.stringify(me)).not.toContain(address);
    const numeric = await detector.detect({
      event: eventFor(`https://auction.t.me/5?text=${draft}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(numeric).toBeNull();
    expect(JSON.stringify(numeric)).not.toContain(hidden);
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

  it("keeps a bridged label Android leaves on a bare host", async () => {
    const detector = createLinkDetector();
    const path = "offer151";
    const bridged = await detector.detect({
      event: eventFor(`例_foo.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bridged).toBeNull();
    expect(JSON.stringify(bridged)).not.toContain("bit.ly");
    expect(JSON.stringify(bridged)).not.toContain(path);

    const hyphen = await detector.detect({
      event: eventFor(`foo-例.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hyphen).toBeNull();
    expect(JSON.stringify(hyphen)).not.toContain("bit.ly");

    const marked = await detector.detect({
      event: eventFor(`www.例_foo.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked).toBeNull();
    expect(JSON.stringify(marked)).not.toContain("bit.ly");

    const queried = await detector.detect({
      event: eventFor(`例_foo.com?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(queried).toBeNull();
    expect(JSON.stringify(queried)).not.toContain("bit.ly");

    const prefixed = await detector.detect({
      event: eventFor(`见例_foo.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed).toBeNull();
    expect(JSON.stringify(prefixed)).not.toContain("bit.ly");

    const spaced = await detector.detect({
      event: eventFor(`见 例_foo.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(spaced?.reasons).toEqual(["short_link"]);
    expect(spaced?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(spaced)).not.toContain(path);

    const tail = await detector.detect({
      event: eventFor(`例_.com/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tail)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`例_foo.com./http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const fake = await detector.detect({
      event: eventFor(`例_foo.example/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fake?.reasons).toEqual(["short_link"]);
    expect(fake?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(fake)).not.toContain(path);

    const joined = await detector.detect({
      event: eventFor(`点击_bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined).toBeNull();
    expect(JSON.stringify(joined)).not.toContain("bit.ly");
    expect(JSON.stringify(joined)).not.toContain(path);
  });

  it("opens the short link after a letter that ends a bare host", async () => {
    const detector = createLinkDetector();
    const path = "offer152";
    const letter = "\u03b1";
    const bare = await detector.detect({
      event: eventFor(`example.com${letter}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);
    expect(JSON.stringify(bare)).not.toContain(letter);

    const queried = await detector.detect({
      event: eventFor(`www.example.com${letter}?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(queried?.reasons).toEqual(["short_link"]);
    expect(queried?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(queried)).not.toContain(path);

    const te = await detector.detect({
      event: eventFor(`foo_bar.com\u0442/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(te?.reasons).toEqual(["short_link"]);
    expect(te?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(te)).not.toContain(path);

    const latin = await detector.detect({
      event: eventFor(`203.0.113.152\u00e9/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(latin?.reasons).toContain("short_link");
    expect(latin?.evidence.map((item) => item.summary)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(latin)).not.toContain(path);

    const glued = await detector.detect({
      event: eventFor(`example.com_${letter}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued?.reasons).toEqual(["short_link"]);
    expect(glued?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(glued)).not.toContain(path);

    const schemed = await detector.detect({
      event: eventFor(`http://example.com${letter}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const kept = await detector.detect({
      event: eventFor(`http://bit.ly${letter}tail.example/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(kept).toBeNull();
    expect(JSON.stringify(kept)).not.toContain("bit.ly");
    expect(JSON.stringify(kept)).not.toContain(path);

    const user = await detector.detect({
      event: eventFor(`http://bit.ly@example.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user).toBeNull();

    const invite = await detector.detect({
      event: eventFor(`example.com${letter}/https://t.me/+CODE152`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE152");
    expect(JSON.stringify(invite)).not.toContain(letter);
  });

  it("keeps a dot lookalike that follows an ascii dot inside one url", async () => {
    const detector = createLinkDetector();
    const path = "offer153";
    const fullwidth = "\uFF0E";
    const middle = "\u00B7";
    const schemed = await detector.detect({
      event: eventFor(`http://example.com.${fullwidth}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const slash = await detector.detect({
      event: eventFor(`http://example.com.${fullwidth}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();
    expect(JSON.stringify(slash)).not.toContain("bit.ly");
    expect(JSON.stringify(slash)).not.toContain(path);

    const queried = await detector.detect({
      event: eventFor(`http://example.com.${middle}?http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(queried).toBeNull();
    expect(JSON.stringify(queried)).not.toContain("bit.ly");
    expect(JSON.stringify(queried)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor(`http://example.com.${fullwidth}/https://t.me/+CODE153`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE153");
    expect(JSON.stringify(invite)).not.toContain("t.me");

    const bare = await detector.detect({
      event: eventFor(`example.com.${fullwidth}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);
    expect(JSON.stringify(bare)).not.toContain(fullwidth);

    const www = await detector.detect({
      event: eventFor(`www.example.com.${fullwidth}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(www?.reasons).toEqual(["short_link"]);
    expect(www?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(www)).not.toContain(path);

    const only = await detector.detect({
      event: eventFor(`bit${fullwidth}ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(only?.reasons).toEqual(["short_link"]);
    expect(only?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(only)).not.toContain(path);
    expect(JSON.stringify(only)).not.toContain(fullwidth);

    const doubled = await detector.detect({
      event: eventFor(`http://example.com..http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(doubled?.reasons).toEqual(["short_link"]);
    expect(doubled?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(doubled)).not.toContain(path);

    const separated = await detector.detect({
      event: eventFor(`example.com${fullwidth}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(separated?.reasons).toEqual(["short_link"]);
    expect(separated?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(separated)).not.toContain(path);
  });

  it("keeps one url when a label character follows @", async () => {
    const detector = createLinkDetector();
    const path = "offer154";
    const han = "\u4f8b";
    const cases = [
      `http://example.com@${han}http://bit.ly/${path}`,
      `http://example.com@\u2215http://bit.ly/${path}`,
      `http://example.com@\uFF0Ehttp://bit.ly/${path}`,
      `http://example.com@\u200bhttp://bit.ly/${path}`,
      `http://example.com@\uFEFFhttp://bit.ly/${path}`,
      `http://example.com@\u03b1http://bit.ly/${path}`,
      `http://example.com@\u3002http://bit.ly/${path}`,
      `http://bit.ly@${han}.com/${path}`,
    ];
    for (const text of cases) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit)).not.toContain("bit.ly");
      expect(JSON.stringify(hit)).not.toContain(path);
    }

    const opened = await detector.detect({
      event: eventFor(`http://example.com@!http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(opened?.reasons).toEqual(["short_link"]);
    expect(opened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(opened)).not.toContain(path);

    const tilde = await detector.detect({
      event: eventFor(`http://example.com@~http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tilde?.reasons).toEqual(["short_link"]);
    expect(tilde?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tilde)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`http://bit.ly@.evil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);
    expect(JSON.stringify(dotted)).not.toContain("evil.com");

    const auth = await detector.detect({
      event: eventFor(`http://user:pass@bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(auth?.reasons).toEqual(["short_link"]);
    expect(auth?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(auth)).not.toContain(path);
    expect(JSON.stringify(auth)).not.toContain("pass");

    const bare = await detector.detect({
      event: eventFor(`example.com@${han}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);
    expect(JSON.stringify(bare)).not.toContain(han);

    const separated = await detector.detect({
      event: eventFor(`bit\uFF0Ely/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(separated?.reasons).toEqual(["short_link"]);
    expect(separated?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(separated)).not.toContain(path);
  });

  it("opens the short link after a dot lookalike written before @", async () => {
    const detector = createLinkDetector();
    const path = "offer155";
    const fullwidth = "\uFF0E";
    const middle = "\u00B7";
    const opened = await detector.detect({
      event: eventFor(`http://example.com${fullwidth}@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(opened?.reasons).toEqual(["short_link"]);
    expect(opened?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(opened)).not.toContain(path);
    expect(JSON.stringify(opened)).not.toContain(fullwidth);

    const marked = await detector.detect({
      event: eventFor(`http://example.com${middle}@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(marked?.reasons).toEqual(["short_link"]);
    expect(marked?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(marked)).not.toContain(path);
    expect(JSON.stringify(marked)).not.toContain(middle);

    const address = "203.0.113.155";
    const ip = await detector.detect({
      event: eventFor(`http://${address}${fullwidth}@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ip?.reasons).toContain("short_link");
    expect(ip?.evidence.map((item) => item.summary)).toContain(
      "short_link:bit.ly",
    );
    expect(JSON.stringify(ip)).not.toContain(path);
    expect(JSON.stringify(ip)).not.toContain(fullwidth);

    const invite = await detector.detect({
      event: eventFor(`http://example.com${fullwidth}@https://t.me/+CODE155`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE155");
    expect(JSON.stringify(invite)).not.toContain(fullwidth);

    const dotted = await detector.detect({
      event: eventFor(`http://example.com.@http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted).toBeNull();
    expect(JSON.stringify(dotted)).not.toContain("bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const slash = await detector.detect({
      event: eventFor(`http://example.com${fullwidth}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();
    expect(JSON.stringify(slash)).not.toContain("bit.ly");

    const bare = await detector.detect({
      event: eventFor(`example.com${fullwidth}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bare)).not.toContain(path);

    const separator = await detector.detect({
      event: eventFor(`bit${fullwidth}ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(separator?.reasons).toEqual(["short_link"]);
    expect(separator?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(separator)).not.toContain(path);
    expect(JSON.stringify(separator)).not.toContain(fullwidth);

    const user = await detector.detect({
      event: eventFor(`http://user@bit${fullwidth}ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(user?.reasons).toEqual(["short_link"]);
    expect(user?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(user)).not.toContain(path);
    expect(JSON.stringify(user)).not.toContain("user");
  });

  it("opens the short link after a host written with dot lookalikes", async () => {
    const detector = createLinkDetector();
    const path = "offer156";
    const fullwidth = "\uFF0E";
    const middle = "\u00B7";
    const opened = [
      `bit${fullwidth}ly${fullwidth}com/http://t.co/${path}`,
      `bit${middle}ly${middle}com/http://t.co/${path}`,
      `safe${fullwidth}com/http://bit.ly/${path}`,
      `www.example${fullwidth}com/http://bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toEqual(["short_link"]);
      expect(JSON.stringify(hit), text).not.toContain(path);
      expect(JSON.stringify(hit), text).not.toContain(fullwidth);
      expect(JSON.stringify(hit), text).not.toContain(middle);
    }
    const tco = await detector.detect({
      event: eventFor(`bit${fullwidth}ly${fullwidth}com/http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tco?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(tco)).not.toContain("bit.ly");

    const invite = await detector.detect({
      event: eventFor(`bit${fullwidth}ly${fullwidth}com/https://t.me/+CODE156`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE156");
    expect(JSON.stringify(invite)).not.toContain(fullwidth);

    const schemed = await detector.detect({
      event: eventFor(
        `http://bit${fullwidth}ly${fullwidth}com/http://t.co/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("t.co");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const glued = await detector.detect({
      event: eventFor(`b${middle}it.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued).toBeNull();
    expect(JSON.stringify(glued)).not.toContain("bit.ly");
    expect(JSON.stringify(glued)).not.toContain(path);

    const separator = await detector.detect({
      event: eventFor(`bit${fullwidth}ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(separator?.reasons).toEqual(["short_link"]);
    expect(separator?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(separator)).not.toContain(path);
    expect(JSON.stringify(separator)).not.toContain(fullwidth);

    const split = await detector.detect({
      event: eventFor(`bit${fullwidth}\nly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(split?.reasons).toEqual(["short_link"]);
    expect(split?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(split)).not.toContain(path);

    const trailed = await detector.detect({
      event: eventFor(`bit${fullwidth}ly\nextra`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(trailed).toBeNull();
    expect(JSON.stringify(trailed)).not.toContain("bit.ly");
  });

  it("opens the short link after a lookalike letter before the scheme", async () => {
    const detector = createLinkDetector();
    const path = "offer157";
    const cyr = "\u0410";
    const wide = "\uFF21";
    const uk = "\u0456";
    const opened = [
      `example.com${cyr}http://bit.ly/${path}`,
      `example.com${wide}http://bit.ly/${path}`,
      `example.com${uk}https://bit.ly/${path}`,
      `www.example.com${wide}http://bit.ly/${path}`,
      `b${cyr}http://bit.ly/${path}`,
      `203.0.113.157${cyr}http://bit.ly/${path}`,
      `example.com${cyr}HTTP://bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
      expect(JSON.stringify(hit), text).not.toContain(cyr);
      expect(JSON.stringify(hit), text).not.toContain(wide);
      expect(JSON.stringify(hit), text).not.toContain(uk);
    }

    const invite = await detector.detect({
      event: eventFor(`example.com${cyr}https://t.me/+CODE157`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE157");
    expect(JSON.stringify(invite)).not.toContain(cyr);

    const schemed = await detector.detect({
      event: eventFor(`http://example.com${cyr}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const slash = await detector.detect({
      event: eventFor(`http://example.com/${wide}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(slash).toBeNull();
    expect(JSON.stringify(slash)).not.toContain("bit.ly");
    expect(JSON.stringify(slash)).not.toContain(path);

    const inside = await detector.detect({
      event: eventFor(`b${cyr}bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inside).toBeNull();
    expect(JSON.stringify(inside)).not.toContain("bit.ly");
    expect(JSON.stringify(inside)).not.toContain(path);

    const divided = await detector.detect({
      event: eventFor(`example.com${cyr}/http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(divided?.reasons).toEqual(["short_link"]);
    expect(divided?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(divided)).not.toContain(path);
    expect(JSON.stringify(divided)).not.toContain(cyr);

    const separator = await detector.detect({
      event: eventFor(`b${uk}t.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(separator?.reasons).toEqual(["short_link"]);
    expect(separator?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(separator)).not.toContain(path);
    expect(JSON.stringify(separator)).not.toContain(uk);

    const wideHost = await detector.detect({
      event: eventFor(`\uFF42\uFF49\uFF54.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(wideHost?.reasons).toEqual(["short_link"]);
    expect(wideHost?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(wideHost)).not.toContain(path);
  });

  it("leaves a short link glued through a non-spacing mark", async () => {
    const detector = createLinkDetector();
    const path = "offer158";
    const mark = "\u0300";
    const glued = [
      `example.com${mark}http://bit.ly/${path}`,
      `www.example.com${mark}http://bit.ly/${path}`,
      `203.0.113.10${mark}http://bit.ly/${path}`,
      `example.com\uFE0Fhttp://bit.ly/${path}`,
      `example.com\uFE20http://bit.ly/${path}`,
      `example.com${mark}${mark}http://bit.ly/${path}`,
      `example.com\u0345http://bit.ly/${path}`,
      `example.com${mark}bit.ly/${path}`,
      `bit.ly${mark}/${path}`,
      `www.bit.ly${mark}/${path}`,
      `http://bit.ly${mark}/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
      expect(JSON.stringify(hit), text).not.toContain(mark);
    }

    const invite = await detector.detect({
      event: eventFor(`example.com${mark}https://t.me/+CODE158`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE158");
    expect(JSON.stringify(invite)).not.toContain("t.me");

    const opened = [
      `example.com${mark}/http://bit.ly/${path}`,
      `www.example.com${mark}/http://bit.ly/${path}`,
      `${mark}http://bit.ly/${path}`,
      `!${mark}http://bit.ly/${path}`,
      `example.com ${mark}http://bit.ly/${path}`,
      `example.com.${mark}http://bit.ly/${path}`,
      `example.com\u03B1http://bit.ly/${path}`,
      `example.com\u0399http://bit.ly/${path}`,
      `example.com\u03B9http://bit.ly/${path}`,
      `example.com\u1FBEhttp://bit.ly/${path}`,
      `bi\uFE0Ft.ly/${path}`,
      `b\u0456t.ly/${path}`,
      `点击bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const schemed = await detector.detect({
      event: eventFor(`http://example.com${mark}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed).toBeNull();
    expect(JSON.stringify(schemed)).not.toContain("bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const swallowed = await detector.detect({
      event: eventFor(`example.com/${mark}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(swallowed).toBeNull();
    expect(JSON.stringify(swallowed)).not.toContain("bit.ly");
    expect(JSON.stringify(swallowed)).not.toContain(path);

    const queried = await detector.detect({
      event: eventFor(`example.com?${mark}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(queried).toBeNull();
    expect(JSON.stringify(queried)).not.toContain("bit.ly");

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.10/${mark}http://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.10");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded dot", async () => {
    const detector = createLinkDetector();
    const path = "offer159";
    const glued = [
      `example.com%2Ehttp://bit.ly/${path}`,
      `example.com%2ehttps://bit.ly/${path}`,
      `www.example.com%2Ehttp://bit.ly/${path}`,
      `%2Ehttp://bit.ly/${path}`,
      `http://example.com%2Ehttp://bit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const invite = await detector.detect({
      event: eventFor("example.com%2Ehttps://t.me/+CODE159"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE159");
    expect(JSON.stringify(invite)).not.toContain("t.me");

    const opened = [
      `example.com.http://bit.ly/${path}`,
      `example.com%2E\nhttp://bit.ly/${path}`,
      `example.com%2E/http://bit.ly/${path}`,
      `example.com%2E http://bit.ly/${path}`,
      `bit%2Ely/${path}`,
      `http://bit.ly%2Eevil.example/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.159%2Ehttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.159");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded plus", async () => {
    const detector = createLinkDetector();
    const path = "offer160";
    const glued = [
      `example.com%2Bhttp://bit.ly/${path}`,
      `example.com%2bhttps://bit.ly/${path}`,
      `www.example.com%2Bhttp://bit.ly/${path}`,
      `%2Bhttp://bit.ly/${path}`,
      `http://example.com%2Bhttp://bit.ly/${path}`,
      `example.com%2BHTTP://bit.ly/${path}`,
      `example.com%252Bhttp://bit.ly/${path}`,
      `example.com/%2Bhttp://bit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const invite = await detector.detect({
      event: eventFor("example.com%2Bhttps://t.me/+CODE160"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE160");
    expect(JSON.stringify(invite)).not.toContain("t.me");

    const opened = [
      `example.com+http://bit.ly/${path}`,
      `example.com%2B\nhttp://bit.ly/${path}`,
      `example.com%2B/http://bit.ly/${path}`,
      `example.com%2B http://bit.ly/${path}`,
      `example.com%2B\thttp://bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const kept = await detector.detect({
      event: eventFor("t.me/%2BCODE160"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(kept?.reasons).toEqual(["invite"]);
    expect(kept?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(kept)).not.toContain("CODE160");

    const stopped = await detector.detect({
      event: eventFor(`https://bit.ly%2Bhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stopped?.reasons).toEqual(["short_link"]);
    expect(stopped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stopped)).not.toContain("t.co");
    expect(JSON.stringify(stopped)).not.toContain(path);

    const pathed = await detector.detect({
      event: eventFor(`https://bit.ly/%2Bhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(pathed?.reasons).toEqual(["short_link"]);
    expect(pathed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(pathed)).not.toContain("t.co");
    expect(JSON.stringify(pathed)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.160%2Bhttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.160");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded plus host", async () => {
    const detector = createLinkDetector();
    const path = "offer164";
    const glued = [
      `%2Bbit.ly/${path}`,
      `%2bbit.ly/${path}`,
      `see%2Bbit.ly/${path}`,
      `see %2Bbit.ly/${path}`,
      `(%2Bbit.ly/${path}`,
      `!%2Bbit.ly/${path}`,
      `example.com%2Bbit.ly/${path}`,
      `www.example.com%2Bbit.ly/${path}`,
      `http://example.com%2Bbit.ly/${path}`,
      `https://example.com%2Bbit.ly/${path}`,
      `example.com%2Bt.co/${path}`,
      `%2Bexample.com/bit.ly/${path}`,
      `%2Bexample.com/http://bit.ly/${path}`,
      `example.com%2Bexample.com/bit.ly/${path}`,
      `example.com%2Bbit.ly/http://t.co/${path}`,
      `%252Bbit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const invite = await detector.detect({
      event: eventFor("example.com%2Bt.me/+CODE164"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE164");
    expect(JSON.stringify(invite)).not.toContain("t.me");

    const kept = await detector.detect({
      event: eventFor("t.me/%2BCODE164"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(kept?.reasons).toEqual(["invite"]);
    expect(kept?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(kept)).not.toContain("CODE164");

    const encodedSlash = await detector.detect({
      event: eventFor("t.me%2F%2BCODE164"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(encodedSlash?.reasons).toEqual(["invite"]);
    expect(encodedSlash?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(encodedSlash)).not.toContain("CODE164");

    const opened = [
      `+bit.ly/${path}`,
      `example.com+bit.ly/${path}`,
      `example.com%2B\nbit.ly/${path}`,
      `example.com%2B bit.ly/${path}`,
      `example.com%2B\tbit.ly/${path}`,
      `example.com%2B/bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const prefixed = await detector.detect({
      event: eventFor(`example.com%2Bwww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:2bwww.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.164%2Bbit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.164");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const hiddenIp = await detector.detect({
      event: eventFor("example.com%2B203.0.113.164"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.164");
  });

  it("leaves a short link glued on by a percent-encoded slash host", async () => {
    const detector = createLinkDetector();
    const path = "offer165";
    const glued = [
      `%2Fbit.ly/${path}`,
      `%2fbit.ly/${path}`,
      `see%2Fbit.ly/${path}`,
      `see %2Fbit.ly/${path}`,
      `(%2Fbit.ly/${path}`,
      `!%2Fbit.ly/${path}`,
      `www%2Fbit.ly/${path}`,
      `example.com%2Fbit.ly/${path}`,
      `%2Fexample.com/bit.ly/${path}`,
      `%2Fexample.com/http://bit.ly/${path}`,
      `%252Fbit.ly/${path}`,
      `%2Fhttp://bit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%2F203.0.113.165/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.165");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const kept = await detector.detect({
      event: eventFor("t.me%2F+CODE165"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(kept?.reasons).toEqual(["invite"]);
    expect(kept?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(kept)).not.toContain("CODE165");

    const opened = [
      `/bit.ly/${path}`,
      `example.com%2F\nbit.ly/${path}`,
      `example.com%2F bit.ly/${path}`,
      `example.com%2F/bit.ly/${path}`,
      `example.com%2F\tbit.ly/${path}`,
      `http:%2F/bit.ly/${path}`,
      `https://bit.ly%2Fname${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const prefixed = await detector.detect({
      event: eventFor(`example.com%2Fwww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:2fwww.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const stopped = await detector.detect({
      event: eventFor(`https://bit.ly%2Fhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stopped?.reasons).toEqual(["short_link"]);
    expect(stopped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stopped)).not.toContain("t.co");
    expect(JSON.stringify(stopped)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.165%2Fbit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.165");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded bracket", async () => {
    const detector = createLinkDetector();
    const path = "offer171";
    const glued = [
      `%5B.%5Dbit.ly/${path}`,
      `%5b.%5dbit.ly/${path}`,
      `%28.%29bit.ly/${path}`,
      `%7B.%7Dbit.ly/${path}`,
      `%5B%2E%5Dbit.ly/${path}`,
      `%5B\u3002%5Dbit.ly/${path}`,
      `see%5B.%5Dbit.ly/${path}`,
      `www%5B.%5Dbit.ly/${path}`,
      `example.com%5B.%5Dbit.ly/${path}`,
      `(%5B.%5Dbit.ly/${path}`,
      `[.%5Dbit.ly/${path}`,
      `%5B.%5Dhttp://bit.ly/${path}`,
      `%5B.%5DHTTP://bit.ly/${path}`,
      `%255B.%255Dbit.ly/${path}`,
      `%5B.%5Dbit.ly/http://t.co/${path}`,
      `https://example.com/%5B.%5Dbit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%5B.%5D203.0.113.171/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.171");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const openedTail = await detector.detect({
      event: eventFor(`%5B.%5D203.0.113.171/http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(openedTail?.reasons).toEqual(["short_link"]);
    expect(openedTail?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(openedTail)).not.toContain("203.0.113.171");
    expect(JSON.stringify(openedTail)).not.toContain(path);

    const opened = [
      `bit%5B.%5Dly/${path}`,
      `bit[.]ly/${path}`,
      `[.]bit.ly/${path}`,
      `%5B.]bit.ly/${path}`,
      `%5B.%5D\nbit.ly/${path}`,
      `%5B.%5D bit.ly/${path}`,
      `%5B.%5D\tbit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const prefixed = await detector.detect({
      event: eventFor(`%5B.%5Dwww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:5dwww.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`%5B.%5D.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:5d.bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const paren = await detector.detect({
      event: eventFor(`%28%2E%29www.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(paren?.reasons).toEqual(["short_link"]);
    expect(paren?.evidence[0]?.summary).toBe("short_link:29www.bit.ly");
    expect(JSON.stringify(paren)).not.toContain(path);

    const schemed = await detector.detect({
      event: eventFor(`http://%5B.%5Dwww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed?.reasons).toEqual(["short_link"]);
    expect(schemed?.evidence[0]?.summary).toBe("short_link:5dwww.bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const tail = await detector.detect({
      event: eventFor(`http://bit.ly%5B.%5Devil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tail)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor("t%5B.%5Dme/+CODE171"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE171");
  });

  it("leaves a short link glued on by a percent-encoded dot mark", async () => {
    const detector = createLinkDetector();
    const path = "offer170";
    const glued = [
      `%2Ebit.ly/${path}`,
      `%2ebit.ly/${path}`,
      `see%2Ebit.ly/${path}`,
      `x%2Ebit.ly/${path}`,
      `example.com%2Ebit.ly/${path}`,
      `www%2Ebit.ly/${path}`,
      `(%2Ebit.ly/${path}`,
      `%2Ehttp://bit.ly/${path}`,
      `%2Ehttps://t.co/${path}`,
      `%252Ebit.ly/${path}`,
      `%2Ebit.ly/http://t.co/${path}`,
      `https://example.com/%2Ebit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%2E203.0.113.170/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.170");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const openedTail = await detector.detect({
      event: eventFor(`%2E203.0.113.170/http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(openedTail?.reasons).toEqual(["short_link"]);
    expect(openedTail?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(openedTail)).not.toContain("203.0.113.170");
    expect(JSON.stringify(openedTail)).not.toContain(path);

    const opened = [
      `bit%2Ely/${path}`,
      `%2E\nbit.ly/${path}`,
      `%2E bit.ly/${path}`,
      `%2E\tbit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const prefixed = await detector.detect({
      event: eventFor(`%2Ewww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:2ewww.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`%2E.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:2e.bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const schemed = await detector.detect({
      event: eventFor(`http://%2Ewww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(schemed?.reasons).toEqual(["short_link"]);
    expect(schemed?.evidence[0]?.summary).toBe("short_link:2ewww.bit.ly");
    expect(JSON.stringify(schemed)).not.toContain(path);

    const tail = await detector.detect({
      event: eventFor(`http://bit.ly%2Eevil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tail)).not.toContain(path);

    const bareTail = await detector.detect({
      event: eventFor(`bit.ly%2Eevil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bareTail?.reasons).toEqual(["short_link"]);
    expect(bareTail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(bareTail)).not.toContain(path);

    const dottedIp = await detector.detect({
      event: eventFor(`%2E.203.0.113.170/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dottedIp?.reasons).toEqual(["ip_host"]);
    expect(dottedIp?.evidence[0]?.summary).toBe("ip_host:203.0.113.170");
    expect(JSON.stringify(dottedIp)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.170%2Eevil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.170");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor("t%2Eme/+CODE170"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE170");
  });

  it("leaves a short link glued on by a percent-encoded dot lookalike", async () => {
    const detector = createLinkDetector();
    const path = "offer169";
    const glued = [
      `%C2%B7bit.ly/${path}`,
      `%c2%b7bit.ly/${path}`,
      `%E2%80%A2bit.ly/${path}`,
      `%E2%80%A7bit.ly/${path}`,
      `%E2%88%99bit.ly/${path}`,
      `%E2%8B%85bit.ly/${path}`,
      `%E3%83%BBbit.ly/${path}`,
      `%EF%BC%8Ebit.ly/${path}`,
      `%EF%B9%92bit.ly/${path}`,
      `%EF%BD%A1bit.ly/${path}`,
      `see%C2%B7bit.ly/${path}`,
      `x%C2%B7bit.ly/${path}`,
      `example.com%C2%B7bit.ly/${path}`,
      `www%C2%B7bit.ly/${path}`,
      `%C2%B7http://bit.ly/${path}`,
      `%C2%B7HTTP://bit.ly/${path}`,
      `%C2%B7https://bit.ly/${path}`,
      `http://%C2%B7bit.ly/${path}`,
      `https://%C2%B7bit.ly/${path}`,
      `(%C2%B7bit.ly/${path}`,
      `%25C2%25B7bit.ly/${path}`,
      `%C2%B7bit.ly/http://t.co/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%C2%B7203.0.113.169/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.169");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const opened = [`bit%C2%B7ly/${path}`, `bit%c2%b7ly/${path}`];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const literal = await detector.detect({
      event: eventFor(`\u00B7bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(literal?.reasons).toEqual(["short_link"]);
    expect(literal?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(literal)).not.toContain(path);

    const inside = await detector.detect({
      event: eventFor(`bit\u00B7ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(inside?.reasons).toEqual(["short_link"]);
    expect(inside?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(inside)).not.toContain(path);

    const prefixed = await detector.detect({
      event: eventFor(`%C2%B7www.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:b7www.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`%C2%B7.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:b7.bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const tail = await detector.detect({
      event: eventFor(`http://bit.ly%C2%B7evil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(tail)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded gap", async () => {
    const detector = createLinkDetector();
    const path = "offer168";
    const glued = [
      `%0Abit.ly/${path}`,
      `%09bit.ly/${path}`,
      `%0Dbit.ly/${path}`,
      `%0Bbit.ly/${path}`,
      `%0Cbit.ly/${path}`,
      `%C2%A0bit.ly/${path}`,
      `%E2%80%8Bbit.ly/${path}`,
      `%EF%BB%BFbit.ly/${path}`,
      `%C2%ADbit.ly/${path}`,
      `%E2%80%8Ebit.ly/${path}`,
      `%250Abit.ly/${path}`,
      `%2509bit.ly/${path}`,
      `%09http://bit.ly/${path}`,
      `http%0A://bit.ly/${path}`,
      `ht%0Atp://bit.ly/${path}`,
      `http%E2%80%8B://bit.ly/${path}`,
      `https%0A://bit.ly/${path}`,
      `http://%0Abit.ly/${path}`,
      `(%0Abit.ly/${path}`,
      `%0Abit.ly/http://t.co/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%0A203.0.113.168/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.168");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const opened = [
      `bit%E2%80%8B.ly/${path}`,
      `b%0Ait.ly/${path}`,
      `\nbit.ly/${path}`,
      `http:%0A//bit.ly/${path}`,
      `http://bit.ly%0Aevil.com/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const prefixed = await detector.detect({
      event: eventFor(`%0Awww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:0awww.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`%0A.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:0a.bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`http://203.0.113.168%0Aevil.com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.168");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor(`t.me/+IN%E2%80%8BCODE168`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE168");
  });

  it("leaves a short link glued on by a percent-encoded host body", async () => {
    const detector = createLinkDetector();
    const path = "offer167";
    const glued = [
      `%2Bb%69t.ly/${path}`,
      `%2Bbit%2Ely/${path}`,
      `%2Bb%69t%2Ely/${path}`,
      `%2Bb%2569t.ly/${path}`,
      `see%2Bb%69t.ly/${path}`,
      `example.com%2Bb%69t.ly/${path}`,
      `example.com%2B\nb%69t.ly/${path}`,
      `%2Fb%69t.ly/${path}`,
      `%2Fbit%2Ely/${path}`,
      `%2F\nb%69t.ly/${path}`,
      `%2Db%69t.ly/${path}`,
      `%2Dbit%2Ely/${path}`,
      `%252Db%69t.ly/${path}`,
      `%2D\nb%69t.ly/${path}`,
      `%2Bbit%252Ely/${path}`,
      `%252Bb%69t.ly/${path}`,
      `%2Bx%2Ebit.ly/${path}`,
      `t.me/%2Bb%69t.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%2B203%2E0%2E113%2E167/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.167");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const swallowed = await detector.detect({
      event: eventFor(`%2Bb%69t.ly/http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(swallowed).toBeNull();
    expect(JSON.stringify(swallowed)).not.toContain("bit.ly");
    expect(JSON.stringify(swallowed)).not.toContain("t.co");
    expect(JSON.stringify(swallowed)).not.toContain(path);

    const opened = [
      `b%69t.ly/${path}`,
      `bit%2Ely/${path}`,
      `http://b%69t.ly/${path}`,
      `example.com%2B\nbit.ly/${path}`,
      `example.com%2B b%69t.ly/${path}`,
      `-b%69t.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const tail = await detector.detect({
      event: eventFor(`%2Bbit%2Ely/http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(tail?.reasons).toEqual(["short_link"]);
    expect(tail?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(tail)).not.toContain("bit.ly");
    expect(JSON.stringify(tail)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`%2B2b%77ww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.reasons).toEqual(["short_link"]);
    expect(suffix?.evidence[0]?.summary).toBe("short_link:77ww.bit.ly");
    expect(JSON.stringify(suffix)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor("t.me/%2BCODE167"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE167");
  });

  it("leaves a short link glued on by a percent-encoded hyphen host", async () => {
    const detector = createLinkDetector();
    const path = "offer166";
    const glued = [
      `%2Dbit.ly/${path}`,
      `%2dbit.ly/${path}`,
      `%252Dbit.ly/${path}`,
      `see %2Dbit.ly/${path}`,
      `(%2Dbit.ly/${path}`,
      `!%2Dbit.ly/${path}`,
      `see%2Dbit.ly/${path}`,
      `example.com%2Dbit.ly/${path}`,
      `example.com%252Dbit.ly/${path}`,
      `%25252Dbit.ly/${path}`,
      `bit%2Dly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`%2D203.0.113.166/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.166");
    expect(JSON.stringify(hiddenIp)).not.toContain(path);

    const opened = [
      `-bit.ly/${path}`,
      `example.com%2D\nbit.ly/${path}`,
      `example.com%2D bit.ly/${path}`,
      `example.com%2D/bit.ly/${path}`,
      `example.com%2D\tbit.ly/${path}`,
      `example.com%252D\nbit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const literal = await detector.detect({
      event: eventFor(`example.com-bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(literal).toBeNull();
    expect(JSON.stringify(literal)).not.toContain("bit.ly");
    expect(JSON.stringify(literal)).not.toContain(path);

    const prefixed = await detector.detect({
      event: eventFor(`%2Dwww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(prefixed?.reasons).toEqual(["short_link"]);
    expect(prefixed?.evidence[0]?.summary).toBe("short_link:2dwww.bit.ly");
    expect(JSON.stringify(prefixed)).not.toContain(path);

    const joined = await detector.detect({
      event: eventFor(`example.com%2Dwww.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:2dwww.bit.ly");
    expect(JSON.stringify(joined)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.166%2Dbit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.166");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("leaves a short link glued on by a percent-encoded hyphen", async () => {
    const detector = createLinkDetector();
    const path = "offer161";
    const glued = [
      `example.com%2Dhttp://bit.ly/${path}`,
      `example.com%2dhttps://bit.ly/${path}`,
      `www.example.com%2Dhttp://bit.ly/${path}`,
      `%2Dhttp://bit.ly/${path}`,
      `example.com%2DHTTP://bit.ly/${path}`,
      `http://example.com%2Dhttp://bit.ly/${path}`,
      `example.com/%2Dhttp://bit.ly/${path}`,
      `example.com%252Dhttp://bit.ly/${path}`,
      `%252Dhttp://bit.ly/${path}`,
      `example.com%25%2Dhttp://bit.ly/${path}`,
      `example.com%25252Dhttp://bit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const invite = await detector.detect({
      event: eventFor("example.com%2Dhttps://t.me/+CODE161"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite).toBeNull();
    expect(JSON.stringify(invite)).not.toContain("CODE161");
    expect(JSON.stringify(invite)).not.toContain("t.me");

    const opened = [
      `example.com-http://bit.ly/${path}`,
      `example.com%2D\nhttp://bit.ly/${path}`,
      `example.com%2D/http://bit.ly/${path}`,
      `example.com%2D http://bit.ly/${path}`,
      `example.com%2D\thttp://bit.ly/${path}`,
      `example.com%252D\nhttp://bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const plain = await detector.detect({
      event: eventFor(`bit%2Dly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();
    expect(JSON.stringify(plain)).not.toContain("bit.ly");
    expect(JSON.stringify(plain)).not.toContain(path);

    const stopped = await detector.detect({
      event: eventFor(`https://bit.ly%2Dhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stopped?.reasons).toEqual(["short_link"]);
    expect(stopped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stopped)).not.toContain("t.co");
    expect(JSON.stringify(stopped)).not.toContain(path);

    const pathed = await detector.detect({
      event: eventFor(`https://bit.ly/%2Dhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(pathed?.reasons).toEqual(["short_link"]);
    expect(pathed?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(pathed)).not.toContain("t.co");
    expect(JSON.stringify(pathed)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.161%2Dhttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.161");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const doubled = await detector.detect({
      event: eventFor(`203.0.113.161%252Dhttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(doubled?.reasons).toEqual(["ip_host"]);
    expect(doubled?.evidence[0]?.summary).toBe("ip_host:203.0.113.161");
    expect(JSON.stringify(doubled)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(doubled)).not.toContain(path);
  });

  it("leaves a short link spelled with a percent-encoded scheme", async () => {
    const detector = createLinkDetector();
    const path = "offer162";
    const glued = [
      `%68ttp://bit.ly/${path}`,
      `%48TTP://bit.ly/${path}`,
      `ht%74p://bit.ly/${path}`,
      `htt%70://bit.ly/${path}`,
      `http%73://bit.ly/${path}`,
      `%68%74%74%70://bit.ly/${path}`,
      `%2568ttp://bit.ly/${path}`,
      `ht%2574p://bit.ly/${path}`,
      `see %68ttp://bit.ly/${path}`,
      `ht%74\np://bit.ly/${path}`,
      `%68ttp://b%69t.ly/${path}`,
      `example.com/%68ttp://bit.ly/${path}`,
      `http://example.com/%68ttp://bit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `http://bit.ly/${path}`,
      `HTTP://bit.ly/${path}`,
      `http://b%69t.ly/${path}`,
      `https://b%69t.ly/${path}`,
      `b%69t.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const invite = await detector.detect({
      event: eventFor("t.me/+OFF%45"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("OFF%45");

    const nested = await detector.detect({
      event: eventFor(`https://bit.ly/%68ttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nested?.reasons).toEqual(["short_link"]);
    expect(nested?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(nested)).not.toContain("t.co");
    expect(JSON.stringify(nested)).not.toContain(path);
  });

  it("leaves a short link spelled with a percent-encoded slash", async () => {
    const detector = createLinkDetector();
    const path = "offer163";
    const glued = [
      `%2Fhttp://bit.ly/${path}`,
      `%2fhttps://bit.ly/${path}`,
      `!%2Fhttp://bit.ly/${path}`,
      `(%2Fhttp://bit.ly/${path}`,
      `see %2Fhttp://bit.ly/${path}`,
      `example.com%2Fhttp://bit.ly/${path}`,
      `http:%2F%2Fbit.ly/${path}`,
      `http:/%2Fbit.ly/${path}`,
      `https:%2F%2Fbit.ly/${path}`,
      `HTTP:%2F%2Fbit.ly/${path}`,
      `http%3A%2F%2Fbit.ly/${path}`,
      `http%3A/%2Fbit.ly/${path}`,
      `http%253A%2F%2Fbit.ly/${path}`,
      `%252Fhttp://bit.ly/${path}`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `example.com%2F\nhttp://bit.ly/${path}`,
      `example.com%2F/http://bit.ly/${path}`,
      `example.com%2F http://bit.ly/${path}`,
      `http:%2F/bit.ly/${path}`,
      `https://bit.ly%2Fname${path}`,
      `http://bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const invite = await detector.detect({
      event: eventFor("t.me%2F+CODE163"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE163");

    const nested = await detector.detect({
      event: eventFor(`https://bit.ly%2Fhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(nested?.reasons).toEqual(["short_link"]);
    expect(nested?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(nested)).not.toContain("t.co");
    expect(JSON.stringify(nested)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.163%2Fhttp://bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["ip_host"]);
    expect(addressed?.evidence[0]?.summary).toBe("ip_host:203.0.113.163");
    expect(JSON.stringify(addressed)).not.toContain("short_link:bit.ly");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("leaves a short link inside a label Android keeps together", async () => {
    const detector = createLinkDetector();
    const path = "offer172";
    const glued = [
      `example.com\u70B9bit.ly/${path}`,
      `example.com\u70B9\u51FBbit.ly/${path}`,
      `bit.ly\u70B9evil.com/${path}`,
      `www.bit.ly\u70B9evil.com/${path}`,
      `example.com\uAC00bit.ly/${path}`,
      `example.com\u3042bit.ly/${path}`,
      `example.com\u30A2bit.ly/${path}`,
      `example.com\u05D0bit.ly/${path}`,
      `example.com\u0627bit.ly/${path}`,
      `example.com\u0E01bit.ly/${path}`,
      `example.com\u263Abit.ly/${path}`,
      `x\u70B9bit.ly/${path}`,
      `www.example.com\u70B9bit.ly/${path}`,
      `b\u70B9it.ly/${path}`,
      `http://bit.ly\u70B9evil.com/${path}`,
      `http://example.com\u70B9bit.ly/${path}`,
      `t.me\u70B9/+CODE172`,
    ];
    for (const text of glued) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain(path);
      expect(JSON.stringify(hit), text).not.toContain("CODE172");
    }

    const hiddenIp = await detector.detect({
      event: eventFor(`203.0.113.10\u70B9bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(hiddenIp).toBeNull();
    expect(JSON.stringify(hiddenIp)).not.toContain("203.0.113.10");
    expect(JSON.stringify(hiddenIp)).not.toContain("bit.ly");

    const opened = [
      `\u70B9bit.ly/${path}`,
      `\u70B9\u51FBbit.ly/${path}`,
      `example.com\u70B9http://bit.ly/${path}`,
      `example.com\u70B9HTTP://bit.ly/${path}`,
      `example.com\u70B9/bit.ly/${path}`,
      `bit.ly\u70B9/${path}`,
      `example.com\u70B9\nbit.ly/${path}`,
      `example.com\n\u70B9bit.ly/${path}`,
      `example.com\u70B9 bit.ly/${path}`,
      `example.com\uE000bit.ly/${path}`,
      `example.com\u{10140}bit.ly/${path}`,
      `b\u0442it.ly/${path}`,
      `bit\u00B7ly/${path}`,
      `bi\uFE0Ft.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const shortened = await detector.detect({
      event: eventFor(`example.com\u70B9https://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(shortened?.reasons).toEqual(["short_link"]);
    expect(shortened?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(shortened)).not.toContain(path);

    const www = await detector.detect({
      event: eventFor(`example.com\u70B9www.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(www?.reasons).toEqual(["short_link"]);
    expect(www?.evidence[0]?.summary).toBe("short_link:example.comxwww.bit.ly");
    expect(JSON.stringify(www)).not.toContain(path);

    const dotted = await detector.detect({
      event: eventFor(`example.com\u70B9.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:example.comx.bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);
  });

  it("opens a finished host when the label tail is not a domain", async () => {
    const detector = createLinkDetector();
    const path = "offer186";
    const opened = [
      `bit.ly\u70B9free/${path}`,
      `bit.ly\uAC00free/${path}`,
      `bit.ly\u70B9free.notarealtld/${path}`,
      `see bit.ly\u70B9\u51FBfree/${path}`,
      `t.co\u70B9hello/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toEqual(["short_link"]);
      const summary = hit?.evidence[0]?.summary ?? "";
      expect(
        summary === "short_link:bit.ly" || summary === "short_link:t.co",
        text,
      ).toBe(true);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const both = await detector.detect({
      event: eventFor(`bit.ly\u70B9203.0.113.10/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(both?.reasons).toEqual(["short_link", "ip_host"]);
    expect(both?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly",
      "ip_host:203.0.113.10",
    ]);
    expect(JSON.stringify(both)).not.toContain(path);

    const address = await detector.detect({
      event: eventFor(`example.com\u70B9203.0.113.10/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(address?.reasons).toEqual(["ip_host"]);
    expect(address?.evidence[0]?.summary).toBe("ip_host:203.0.113.10");
    expect(JSON.stringify(address)).not.toContain(path);

    const pair = await detector.detect({
      event: eventFor(`203.0.113.10\u70B9203.0.113.11/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(pair?.reasons).toEqual(["ip_host"]);
    expect(pair?.evidence[0]?.summary).toBe("ip_host:203.0.113.10");
    expect(JSON.stringify(pair)).not.toContain("203.0.113.11");
    expect(JSON.stringify(pair)).not.toContain(path);

    const kept = [
      `bit.ly\u70B9evil.com/${path}`,
      `bit.ly\u70B9free.com/${path}`,
      `bit.ly\u70B9free.\u4E2D\u56FD/${path}`,
      `http://bit.ly\u70B9free/${path}`,
      `http://bit.ly\u70B9203.0.113.10/${path}`,
      `203.0.113.10\u70B9bit.ly/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
    }
  });

  it("keeps a mixed label on the host Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer187";
    const kept = [
      `bit.ly\u70B9\u65E5\u672C.com/${path}`,
      `www.bit.ly\u70B9\u65E5\u672C.com/${path}`,
      `t.co\u70B9\u65E5\u672C.com/${path}`,
      `203.0.113.10\u70B9\u65E5\u672C.com/${path}`,
      `bit.ly\uAC00.com/${path}`,
      `see bit.ly\u70B9\u65E5\u672C.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C.\u4E2D\u56FD/${path}`,
      `http://bit.ly\u70B9\u65E5\u672C.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C.evil.com/${path}`,
      `www.bit.ly\u70B9\u65E5\u672C.evil.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C.co.uk/${path}`,
      `bit.ly\u70B9.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C.com.notarealtld/${path}`,
      `http://bit.ly\u70B9\u65E5\u672C.evil.com/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const dotted = await detector.detect({
      event: eventFor(`example.com\u70B9.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(dotted?.reasons).toEqual(["short_link"]);
    expect(dotted?.evidence[0]?.summary).toBe("short_link:example.comx.bit.ly");
    expect(JSON.stringify(dotted)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`\u70B9\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.reasons).toEqual(["short_link"]);
    expect(suffix?.evidence[0]?.summary).toBe(
      "short_link:xn--wgv71as3s.bit.ly",
    );
    expect(JSON.stringify(suffix)).not.toContain(path);

    const fake = await detector.detect({
      event: eventFor(`bit.ly\u70B9\u65E5\u672C.notarealtld/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(fake?.reasons).toEqual(["short_link"]);
    expect(fake?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(fake)).not.toContain(path);

    const plain = await detector.detect({
      event: eventFor(`example.com\u70B9.notarealtld/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(plain).toBeNull();

    const joined = await detector.detect({
      event: eventFor(`bit.ly\u70B9\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.lyx.bit.ly",
    ]);
    expect(JSON.stringify(joined)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.10\u70B9\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["short_link"]);
    expect(addressed?.evidence[0]?.summary).toBe(
      "short_link:203.0.113.10x.bit.ly",
    );
    expect(JSON.stringify(addressed)).not.toContain("ip_host:203.0.113.10");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const longer = await detector.detect({
      event: eventFor(`example.com\u70B9.bit.ly.notarealtld/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(longer?.reasons).toEqual(["short_link"]);
    expect(longer?.evidence[0]?.summary).toBe("short_link:example.comx.bit.ly");
    expect(JSON.stringify(longer)).not.toContain(path);
  });

  it("keeps a unicode label on the dotted host Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer188";
    const kept = [
      `bit.ly\u70B9.\u65E5\u672C.com/${path}`,
      `www.bit.ly\u70B9.\u65E5\u672C.com/${path}`,
      `t.co\u70B9.\u65E5\u672C.com/${path}`,
      `203.0.113.10\u70B9.\u65E5\u672C.com/${path}`,
      `bit.ly\u70B9\u65E5.\u672C.com/${path}`,
      `bit.ly\uAC00.\uAC00.com/${path}`,
      `see bit.ly\u70B9.\u65E5\u672C.com/${path}`,
      `bit.ly\u70B9.\u65E5\u672C.\u4E2D\u56FD/${path}`,
      `bit.ly\u70B9.\u4E2D\u56FD/${path}`,
      `bit.ly\u70B9.\u4E2D\u56FD.com/${path}`,
      `bit.ly\u70B9.\u4E2D\u56FDcom/${path}`,
      `bit.ly\u70B9.com\u65E5\u672C/${path}`,
      `bit.ly\u70B9.\u65E5\u672C.com.notarealtld/${path}`,
      `bit.ly\u70B9\u65E5\u672C.\u672C.com/${path}`,
      `http://bit.ly\u70B9.\u65E5\u672C.com/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `bit.ly\u70B9.\u65E5\u672C.notarealtld/${path}`,
      `bit.ly\u70B9.\u65E5\u672Ccom/${path}`,
      `bit.ly\u70B9.\u4E2D\u56FD\u65E5\u672C/${path}`,
      `bit.ly\u70B9..com/${path}`,
      `bit.ly\u70B9.\u65E5\u672C..com/${path}`,
      `bit.ly\u70B9..\u65E5\u672C.com/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toEqual(["short_link"]);
      expect(hit?.evidence[0]?.summary, text).toBe("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const suffix = await detector.detect({
      event: eventFor(`example.com\u70B9.\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.reasons).toEqual(["short_link"]);
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:example.comx.xn--wgv71a.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`\u70B9.\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence[0]?.summary).toBe(
      "short_link:xn--3px.xn--wgv71a.bit.ly",
    );
    expect(JSON.stringify(bare)).not.toContain(path);

    const joined = await detector.detect({
      event: eventFor(`bit.ly\u70B9.\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.lyx.xn--wgv71a.bit.ly",
    ]);
    expect(JSON.stringify(joined)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.10\u70B9.\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["short_link"]);
    expect(addressed?.evidence.map((item) => item.summary)).toEqual([
      "short_link:203.0.113.10x.xn--wgv71a.bit.ly",
    ]);
    expect(JSON.stringify(addressed)).not.toContain("ip_host:203.0.113.10");
    expect(JSON.stringify(addressed)).not.toContain(path);
  });

  it("keeps a unicode label after an ideographic stop", async () => {
    const detector = createLinkDetector();
    const path = "offer189";
    const kept = [
      `bit.ly\u3002\u65E5\u672C.com/${path}`,
      `bit.ly\u3002\u70B9\u65E5\u672C.com/${path}`,
      `www.bit.ly\u3002\u65E5\u672C.com/${path}`,
      `t.co\u3002\u65E5\u672C.com/${path}`,
      `203.0.113.10\u3002\u65E5\u672C.com/${path}`,
      `bit.ly\u3002\u3002\u65E5\u672C.com/${path}`,
      `bit.ly\u3002\u4E2D\u56FD.com/${path}`,
      `bit.ly\u00B7\u70B9\u65E5\u672C.com/${path}`,
      `see bit.ly\u3002\u65E5\u672C.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C\u3002evil.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C\u3002\u3002evil.com/${path}`,
      `bit.ly\u70B9\u65E5\u672C\u3002\u65E5\u672C.com/${path}`,
      `203.0.113.10\u70B9\u65E5\u672C\u3002evil.com/${path}`,
      `http://bit.ly\u3002\u65E5\u672C.com/${path}`,
      `http://bit.ly\u70B9\u65E5\u672C\u3002evil.com/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `bit.ly\u3002com/${path}`,
      `bit.ly\u3002\u4E2D\u56FD/${path}`,
      `bit.ly\u70B9\u65E5\u672C\u3002com/${path}`,
      `bit.ly\u3002\u70B9\u65E5\u672C.notarealtld/${path}`,
      `bit.ly\u3002com.\u65E5\u672C/${path}`,
      `bit.ly\u3002/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toEqual(["short_link"]);
      expect(hit?.evidence[0]?.summary, text).toBe("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const suffix = await detector.detect({
      event: eventFor(`example.com\u3002\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.reasons).toEqual(["short_link"]);
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:example.com.xn--wgv71a.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);

    const glued = await detector.detect({
      event: eventFor(`example.com\u70B9\u3002\u65E5\u672C.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(glued?.reasons).toEqual(["short_link"]);
    expect(glued?.evidence.map((item) => item.summary)).toEqual([
      "short_link:example.comx.xn--wgv71a.bit.ly",
    ]);
    expect(JSON.stringify(glued)).not.toContain(path);

    const bare = await detector.detect({
      event: eventFor(`\u70B9\u65E5\u672C\u3002bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(bare?.reasons).toEqual(["short_link"]);
    expect(bare?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly",
    ]);
    expect(JSON.stringify(bare)).not.toContain(path);
  });

  it("joins an ideographic stop when another domain continues", async () => {
    const detector = createLinkDetector();
    const path = "offer183";
    const kept = [
      `bit.ly\u3002evil.com/${path}`,
      `www.bit.ly\u3002evil.com/${path}`,
      `bit.ly\u3002\u3002evil.com/${path}`,
      `203.0.113.10\u3002evil.com/${path}`,
      `bit\u3002ly/${path}`,
      `http://bit.ly\u3002evil.com/${path}`,
      `http://www.bit.ly\u3002evil.com/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const joined = await detector.detect({
      event: eventFor(`example.com\u3002bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:example.com.bit.ly");
    expect(JSON.stringify(joined)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.10\u3002bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["short_link"]);
    expect(addressed?.evidence[0]?.summary).toBe(
      "short_link:203.0.113.10.bit.ly",
    );
    expect(JSON.stringify(addressed)).not.toContain("ip_host:203.0.113.10");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const stopped = await detector.detect({
      event: eventFor(`bit.ly\u3002/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stopped?.reasons).toEqual(["short_link"]);
    expect(stopped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stopped)).not.toContain(path);
  });

  it("joins a dot lookalike when another ascii domain continues", async () => {
    const detector = createLinkDetector();
    const path = "offer184";
    const marks = ["\u00B7", "\u2022", "\uFF0E", "\uFF61"];
    for (const mark of marks) {
      const kept = [
        `bit.ly${mark}evil.com/${path}`,
        `www.bit.ly${mark}evil.com/${path}`,
        `bit.ly${mark}${mark}evil.com/${path}`,
        `203.0.113.10${mark}evil.com/${path}`,
        `http://bit.ly${mark}evil.com/${path}`,
      ];
      for (const text of kept) {
        const hit = await detector.detect({
          event: eventFor(text),
          logger: createMemoryLogger(),
          signal,
        });
        expect(hit, text).toBeNull();
        expect(JSON.stringify(hit), text).not.toContain("bit.ly");
        expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
        expect(JSON.stringify(hit), text).not.toContain(path);
      }
    }

    const joined = await detector.detect({
      event: eventFor(`example.com\u00B7bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(joined?.reasons).toEqual(["short_link"]);
    expect(joined?.evidence[0]?.summary).toBe("short_link:example.com.bit.ly");
    expect(JSON.stringify(joined)).not.toContain(path);

    const addressed = await detector.detect({
      event: eventFor(`203.0.113.10\u00B7bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(addressed?.reasons).toEqual(["short_link"]);
    expect(addressed?.evidence[0]?.summary).toBe(
      "short_link:203.0.113.10.bit.ly",
    );
    expect(JSON.stringify(addressed)).not.toContain("ip_host:203.0.113.10");
    expect(JSON.stringify(addressed)).not.toContain(path);

    const stopped = await detector.detect({
      event: eventFor(`bit.ly\u00B7/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(stopped?.reasons).toEqual(["short_link"]);
    expect(stopped?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(stopped)).not.toContain(path);

    const split = await detector.detect({
      event: eventFor(`bit.ly\u00B7evil\u00B7com/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(split?.reasons).toEqual(["short_link"]);
    expect(split?.evidence[0]?.summary).toBe("short_link:bit.ly");
    expect(JSON.stringify(split)).not.toContain(path);
  });

  it("maps an idna letter Android opens as that host", async () => {
    const detector = createLinkDetector();
    const path = "offer173";
    const changed = [
      `\u2139bit.ly/${path}`,
      `b\u017Fit.ly/${path}`,
      `http://b\u017Fit.ly/${path}`,
      `b\u212Ait.ly/${path}`,
      `bit.ly\u2139evil.com/${path}`,
      `example.com\u2139bit.ly/${path}`,
      `http://bit.ly\u2139evil.com/${path}`,
      `203.0.113.10\u2139bit.ly/${path}`,
    ];
    for (const text of changed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `b\u2139t.ly/${path}`,
      `http://b\u2139t.ly/${path}`,
      `http://b\u24D8t.ly/${path}`,
      `http://b\u2160t.ly/${path}`,
      `b\u1D35t.ly/${path}`,
      `bi\u1D40.ly/${path}`,
      `http://bit.l\u02B8/${path}`,
      `b\u0442it.ly/${path}`,
      `\u70B9\u51FBbit.ly/${path}`,
      `example.com\u2139http://bit.ly/${path}`,
      `example.com\u1D35http://bit.ly/${path}`,
      `example.com\u24D8http://t.co/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
    const twitter = await detector.detect({
      event: eventFor(`http://t.\u1D9Co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(twitter?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(twitter)).not.toContain(path);
    const circled = await detector.detect({
      event: eventFor(`example.com\u24D8http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(circled?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(circled)).not.toContain(path);
  });

  it("drops a grapheme joiner Android keeps inside a host", async () => {
    const detector = createLinkDetector();
    const path = "offer174";
    const closed = [
      `bit.\u034Fly/${path}`,
      `example.com\u034Fhttp://bit.ly/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `bi\u034Ft.ly/${path}`,
      `b\u034Fit.ly/${path}`,
      `bit\u034F.ly/${path}`,
      `bi\u034F\u034Ft.ly/${path}`,
      `http://bi\u034Ft.ly/${path}`,
      `http://bit\u034F.ly/${path}`,
      `\u034Fbit.ly/${path}`,
      `http://bit.\u034Fly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const twitter = await detector.detect({
      event: eventFor(`t\u034F.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(twitter?.evidence[0]?.summary).toBe("short_link:t.co");
    expect(JSON.stringify(twitter)).not.toContain(path);

    const invite = await detector.detect({
      event: eventFor(`t\u034F.me/+CODE174`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(invite?.reasons).toEqual(["invite"]);
    expect(invite?.evidence[0]?.summary).toBe("invite:t.me");
    expect(JSON.stringify(invite)).not.toContain("CODE174");
  });

  it("leaves a multi-byte percent encoding outside a schemed host", async () => {
    const detector = createLinkDetector();
    const path = "offer175";
    const closed = [
      `http://b%E2%85%A0t.ly/${path}`,
      `http://b%E2%84%B9t.ly/${path}`,
      `http://bi%CD%8Ft.ly/${path}`,
      `b%E2%85%A0t.ly/${path}`,
      `http://%E2%84%B9bit.ly/${path}`,
      `http://example.com/%E2%84%B9bit.ly/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `http://b%69t.ly/${path}`,
      `b%69t.ly/${path}`,
      `https://bit.ly%2F${path}`,
      `https://bit.ly/%E2%85%A0${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps script punctuation inside the host Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer176";
    const closed = [
      `b\u055Ait.ly/${path}`,
      `http://bit.\u055Aly/${path}`,
      `b\u0384it.ly/${path}`,
      `http://b\u0482t.ly/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `b\u0561it.ly/${path}`,
      `\u055Abit.ly/${path}`,
      `example.com\u055Ahttp://bit.ly/${path}`,
      `b\u03B1it.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit?.reasons, text).toContain("short_link");
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toContain("short_link:bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps a division slash inside the host Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer177";
    const closed = [
      `http://\u2215bit.ly/${path}`,
      `https://\u2044bit.ly/${path}`,
      `http://bit.ly\u2215/${path}`,
      `http://bit.ly\u2215?${path}`,
      `http://bit.ly\u2215`,
      `http://\u2215203.0.113.10/${path}`,
      `http://203.0.113.9\u2215/${path}`,
      `http://bit.ly\u2215http://bit.ly/${path}`,
      `http://example.com\u2215/bit.ly/${path}`,
      `http://%E2%88%95bit.ly/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `\u2215bit.ly/${path}`,
      `http://bit.ly\u2215@example.com/${path}`,
      `http://user\u2215@bit.ly/${path}`,
      `http://example.com\u2215@bit.ly/${path}`,
      `http://bit.ly%E2%88%95@example.com/${path}`,
      `http://bit.ly\u2215#evil.com/${path}`,
      `http://203.0.113.9\u2215@example.com/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).not.toBeNull();
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps an empty authority query with the scheme Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer178";
    const closed = [
      `http://?bit.ly/${path}`,
      `https://?bit.ly/${path}`,
      `http://?203.0.113.10/${path}`,
      `http:///?bit.ly/${path}`,
      `http://?http://bit.ly/${path}`,
      `http://?t.me/+${path}`,
      `http://example.com?bit.ly/${path}`,
      `http://example.com/?bit.ly/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113");
      expect(JSON.stringify(hit), text).not.toContain("t.me");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `http:///bit.ly/${path}`,
      `http:////bit.ly/${path}`,
      `http://bit.ly?${path}`,
      `http://#bit.ly/${path}`,
      `http://?bit.ly/x http://t.co/${path}`,
      `https://t.me/+${path}`,
      `bit.ly/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).not.toBeNull();
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps a hostless port with the scheme Android opens", async () => {
    const detector = createLinkDetector();
    const path = "offer179";
    const closed = [
      `http://:80/bit.ly/${path}`,
      `https://:443?bit.ly/${path}`,
      `http://:8/bit.ly/${path}`,
      `http://:080/bit.ly/${path}`,
      `http://:80/http://t.co/${path}`,
      `http://:80/203.0.113.10/${path}`,
      `http://:80/t.me/+${path}`,
      `http://example.com:80/bit.ly/${path}`,
      `http://:80bit.ly/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113");
      expect(JSON.stringify(hit), text).not.toContain("t.me");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `http://:999999/bit.ly/${path}`,
      `http://:/bit.ly/${path}`,
      `http://:80 /bit.ly/${path}`,
      `http://bit.ly:80/${path}`,
      `http://@bit.ly/${path}`,
      `http://:@bit.ly/${path}`,
      `https://t.me/+${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).not.toBeNull();
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps a schemed label character Android leaves in the host", async () => {
    const detector = createLinkDetector();
    const path = "offer180";
    const mark = "\u4e00";
    const closed = [
      `http://bit.ly${mark}/${path}`,
      `https://t.co${mark}?${path}`,
      `http://bit.ly${mark}`,
      `http://bit.ly${mark}.evil.com/${path}`,
      `http://bit.ly.${mark}/${path}`,
      `http://bit.ly${mark}:80/${path}`,
      `http://bit.ly${mark}:80`,
      `http://bit.ly${mark}:80@evil.com/${path}`,
      `http://bit.ly${mark}/http://t.co/${path}`,
      `http://www.bit.ly${mark}/${path}`,
      `http://203.0.113.10${mark}/${path}`,
      `http://t.me${mark}/+${path}`,
      `http://bit.ly\uff0c/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113");
      expect(JSON.stringify(hit), text).not.toContain("t.me");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `http://bit.ly${mark}@evil.com/${path}`,
      `https://t.co${mark}@evil.com/${path}`,
      `http://bit.ly${mark}#evil.com/${path}`,
      `http://bit.ly${mark} evil.com/${path}`,
      `http://bit.ly${mark}. evil.com/${path}`,
      `http://203.0.113.10${mark}@evil.com/${path}`,
      `bit.ly${mark}/${path}`,
      `www.bit.ly${mark}/${path}`,
      `http://bit.ly${mark}/${path} http://t.co/${path}`,
      `https://t.me/+${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).not.toBeNull();
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps a supplementary label character Android leaves in the host", async () => {
    const detector = createLinkDetector();
    const path = "offer181";
    const ext = "\u{20000}";
    const closed = [
      `http://bit.ly${ext}/${path}`,
      `https://t.co${ext}?${path}`,
      `http://bit.ly${ext}`,
      `http://bit.ly${ext}.evil.com/${path}`,
      `http://bit.ly.${ext}/${path}`,
      `http://bit.ly-${ext}/${path}`,
      `http://bit.ly${ext}:80/${path}`,
      `http://bit.ly${ext}:80@evil.com/${path}`,
      `http://bit.ly${ext}/http://t.co/${path}`,
      `http://www.bit.ly${ext}/${path}`,
      `http://203.0.113.10${ext}/${path}`,
      `http://t.me${ext}/+${path}`,
      `http://bit.ly${ext.repeat(61)}/${path}`,
      `http://bit.ly-${ext.repeat(31)}/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113");
      expect(JSON.stringify(hit), text).not.toContain("t.me");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      `http://bit.ly${ext}@evil.com/${path}`,
      `https://t.co${ext}@evil.com/${path}`,
      `http://bit.ly${ext}#evil.com/${path}`,
      `http://bit.ly${ext} evil.com/${path}`,
      `http://203.0.113.10${ext}@evil.com/${path}`,
      `bit.ly${ext}/${path}`,
      `www.bit.ly${ext}/${path}`,
      `http://bit.ly\u{10140}/${path}`,
      `https://t.me/+${path}`,
      `http://bit.ly${ext.repeat(62)}/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).not.toBeNull();
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(`http://bit.ly${ext}/${path} http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain("bit.ly");
    expect(JSON.stringify(later)).not.toContain(path);
  });

  it("deletes a mapped letter after a finished host Android already opened", async () => {
    const detector = createLinkDetector();
    const path = "offer182";
    const opened = [
      [`bit.ly\u00AA/${path}`, "short_link:bit.ly"],
      [`www.bit.ly\u00AA/${path}`, "short_link:www.bit.ly"],
      [`t.co\u0430/${path}`, "short_link:t.co"],
      [`bit.ly\u2139/${path}`, "short_link:bit.ly"],
      [`goo.gl\u00AA/${path}`, "short_link:goo.gl"],
      [`203.0.113.10\u00AA/${path}`, "ip_host:203.0.113.10"],
      [`bit.ly\uFF41/${path}`, "short_link:bit.ly"],
      [`bit.ly\u00AAx/${path}`, "short_link:bit.ly"],
      [`bit.ly\u00AA:80/${path}`, "short_link:bit.ly"],
      [`b\u2139t.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const closed = [
      `bit.ly\u2139evil.com/${path}`,
      `bit.ly\u00AAevil.com/${path}`,
      `http://bit.ly\u00AA/${path}`,
      `https://www.bit.ly\u00AA/${path}`,
      `http://user@bit.ly\u00AA/${path}`,
      `example.com\u2139bit.ly/${path}`,
      `b\u0430it.ly/${path}`,
      `notbit.ly\u00AA/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(`bit.ly\u00AAhttp://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);
  });

  it("deletes a bare address that follows a mapped letter", async () => {
    const detector = createLinkDetector();
    const path = "offer185";
    const opened = [
      `\u00AA203.0.113.10/${path}`,
      `a\u00AA203.0.113.10/${path}`,
      `see \u0410203.0.113.10/${path}`,
      `\uFF41203.0.113.10/${path}`,
      `\u00AA\u00AA203.0.113.10/${path}`,
      `a\u0430203.0.113.10/${path}`,
    ];
    for (const text of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual(["ip_host:203.0.113.10"]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const closed = [
      `http://\u00AA203.0.113.10/${path}`,
      `https://\uFF41203.0.113.10/${path}`,
      `http://user:pass@\u0410203.0.113.10/${path}`,
      `http://example.com/\u00AA203.0.113.10/${path}`,
      `http://example.com?\u00AA203.0.113.10`,
      `\u00AA203.0.113.10a/${path}`,
      `\u00AA203.0.113.10.evil.com/${path}`,
    ];
    for (const text of closed) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }
  });

  it("keeps a dot lookalike inside a schemed label", async () => {
    const detector = createLinkDetector();
    const path = "offer190";
    const kept = [
      `http://bit.ly\u00B7/${path}`,
      `https://t.co\u2022?${path}`,
      `http://www.bit.ly\u2027/${path}`,
      `http://203.0.113.10\u2219/${path}`,
      `http://bit.ly\u22C5\u22C5/${path}`,
      `http://bit.ly\u30FB:80/${path}`,
      `http://user:pass@bit.ly\uFE52/${path}`,
      `http://bit.ly\u00B7/http://t.co/${path}`,
      `bit.ly\u00B7.com/${path}`,
      `http://bit.ly\u00B7.evil.com/${path}`,
      `bit.ly\u00B7\u00B7.com/${path}`,
      `203.0.113.10\u00B7.evil.com/${path}`,
      `http://bit.ly\u00B7.\u65E5\u672C.com/${path}`,
      `http://bit.ly\uFF0E.notarealtld/${path}`,
      `see http://bit.ly\u00B7/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit.ly\u00B7/${path}`, "short_link:bit.ly"],
      [`www.bit.ly\u2022/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10\u00B7/${path}`, "ip_host:203.0.113.10"],
      [`bit.ly\u00B7?${path}`, "short_link:bit.ly"],
      [`bit.ly\u00B7:80/${path}`, "short_link:bit.ly"],
      [`http://bit.ly\u00B7@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly\u00B7#${path}`, "short_link:bit.ly"],
      [`http://bit.ly\u3002/${path}`, "short_link:bit.ly"],
      [`bit.ly\u00B7.notarealtld/${path}`, "short_link:bit.ly"],
      [`http://bit.ly\u00B7 evil.com/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const suffix = await detector.detect({
      event: eventFor(`example.com\u00B7.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:example.comx.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a schemed script letter inside the host", async () => {
    const detector = createLinkDetector();
    const path = "offer191";
    const greek = "\u03B1";
    const cyrillic = "\u0442";
    const armenian = "\u0561";
    const latin = "\u0153";
    const kept = [
      `http://bit.ly${greek}/${path}`,
      `https://t.co${greek}?${path}`,
      `http://bit.ly${greek}`,
      `http://bit.ly${greek}:80/${path}`,
      `http://www.bit.ly${greek}/${path}`,
      `http://203.0.113.10${armenian}/${path}`,
      `http://user:pass@bit.ly${greek}/${path}`,
      `see http://bit.ly${cyrillic}/${path}`,
      `http://bit.ly${latin}/${path}`,
      `http://bit.ly${greek}${greek}/${path}`,
      `http://bit.ly${greek}.evil.com/${path}`,
      `http://bit.ly${greek}/http://t.co/${path}`,
      `http://bit.ly${greek}http://t.co/${path}`,
      `https://t.me${greek}/+${path}`,
      `http://example.com${greek}/http://bit.ly/${path}`,
      `http://bit.ly${greek.repeat(61)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("bit.ly");
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain("t.me");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit.ly${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit.ly${greek}/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10${greek}/${path}`, "ip_host:203.0.113.10"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
      [`b${greek}it.ly/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit.ly${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${greek} evil.com/${path}`, "short_link:bit.ly"],
      [`https://bit.ly${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit.ly${greek}:999999/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${greek}:80evil/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${greek.repeat(62)}/${path}`, "short_link:bit.ly"],
      [`example.com${greek}/http://bit.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(`http://bit.ly${greek}/${path} http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain("bit.ly");
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit.ly${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.lyx.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a dotted script label on a schemed host", async () => {
    const detector = createLinkDetector();
    const path = "offer192";
    const greek = "\u03B1";
    const kept = [
      `http://bit.ly.${greek}/${path}`,
      `https://t.co.\u0442?${path}`,
      `http://bit.ly.${greek}`,
      `http://bit.ly.${greek}:80/${path}`,
      `http://www.bit.ly.${greek}/${path}`,
      `http://203.0.113.10.\u0561/${path}`,
      `http://user:pass@bit.ly.${greek}/${path}`,
      `see http://bit.ly.\u0153/${path}`,
      `http://bit.ly.${greek}${greek}/${path}`,
      `http://bit.ly.${greek}/http://t.co/${path}`,
      `http://bit.ly.${greek}.evil.com/${path}`,
      `http://bit.ly.${greek}com/${path}`,
      `http://example.com.${greek}/http://bit.ly/${path}`,
      `http://bit.ly.${greek.repeat(63)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit.ly.${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit.ly.${greek}/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10.${greek}/${path}`, "ip_host:203.0.113.10"],
      [`http://bit.ly.${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit.ly.${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly.${greek} evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly..${greek}/${path}`, "short_link:bit.ly"],
      [`http://bit.ly.${greek}:999999/${path}`, "short_link:bit.ly"],
      [`http://bit.ly.${greek.repeat(64)}/${path}`, "short_link:bit.ly"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(`http://bit.ly.${greek}/${path} http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit.ly.${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly.xn--mxa.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a script letter after a schemed ideographic dot", async () => {
    const detector = createLinkDetector();
    const path = "offer193";
    const greek = "\u03B1";
    const ideo = "\u3002";
    const kept = [
      `http://bit.ly${ideo}${greek}/${path}`,
      `https://t.co${ideo}\u0442?${path}`,
      `http://bit.ly${ideo}${greek}`,
      `http://bit.ly${ideo}${greek}:80/${path}`,
      `http://www.bit.ly${ideo}${greek}/${path}`,
      `http://203.0.113.10${ideo}\u0561/${path}`,
      `http://user:pass@bit.ly${ideo}${greek}/${path}`,
      `see http://bit.ly${ideo}\u0153/${path}`,
      `http://bit.ly\uFF0E${greek}/${path}`,
      `http://bit.ly\uFF61${greek}/${path}`,
      `http://bit.ly${ideo}${greek}/http://t.co/${path}`,
      `http://bit.ly${ideo}${greek}.evil.com/${path}`,
      `http://example.com${ideo}${greek}/http://bit.ly/${path}`,
      `http://bit.ly${ideo}${ideo}${greek}/${path}`,
      `http://bit.ly${ideo}${greek.repeat(60)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit.ly${ideo}${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit.ly${ideo}${greek}/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10${ideo}${greek}/${path}`, "ip_host:203.0.113.10"],
      [`http://bit.ly${ideo}${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit.ly${ideo}${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${ideo}${greek} evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${ideo}${greek}:999999/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${ideo}${greek.repeat(61)}/${path}`, "short_link:bit.ly"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(
        `http://bit.ly${ideo}${greek}/${path} http://t.co/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit.ly${ideo}${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.ly.xn--mxa.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a script letter after an ignored schemed mark", async () => {
    const detector = createLinkDetector();
    const path = "offer194";
    const greek = "\u03B1";
    const gap = "\u200B";
    const kept = [
      `http://bit.ly${gap}${greek}/${path}`,
      `https://t.co${gap}\u0442?${path}`,
      `http://bit.ly${gap}${greek}`,
      `http://bit.ly${gap}${greek}:80/${path}`,
      `http://www.bit.ly${gap}${greek}/${path}`,
      `http://203.0.113.10${gap}\u0561/${path}`,
      `http://user:pass@bit.ly${gap}${greek}/${path}`,
      `see http://bit.ly${gap}\u0153/${path}`,
      `http://bit.ly\u00AD${greek}/${path}`,
      `http://bit.ly\uFE0F${greek}/${path}`,
      `http://bit.ly\u2060${greek}/${path}`,
      `http://bit.ly\u034F${greek}/${path}`,
      `http://bit.ly${gap}${gap}${greek}/${path}`,
      `http://bit.ly${gap}${greek}/http://t.co/${path}`,
      `http://bit.ly${gap}${greek}.evil.com/${path}`,
      `http://example.com${gap}${greek}/http://bit.ly/${path}`,
      `http://bit.ly${gap}${greek.repeat(60)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit.ly${gap}${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit.ly${gap}${greek}/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10${gap}${greek}/${path}`, "ip_host:203.0.113.10"],
      [`http://bit.ly${gap}${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit.ly${gap}${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${gap}${greek} evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly\n${greek}/${path}`, "short_link:bit.ly"],
      [`http://bit.ly${gap}${greek.repeat(61)}/${path}`, "short_link:bit.ly"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(
        `http://bit.ly${gap}${greek}/${path} http://t.co/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit.ly${gap}${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.lyx.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a script letter after a buried schemed mark", async () => {
    const detector = createLinkDetector();
    const path = "offer195";
    const greek = "\u03B1";
    const gap = "\u200B";
    const kept = [
      `http://bit.ly${gap}.${greek}/${path}`,
      `http://bit${gap}.ly${greek}/${path}`,
      `http://bit.l${gap}y${greek}/${path}`,
      `http://bi${gap}t.ly${greek}/${path}`,
      `http://bit.ly${gap}\u3002${greek}/${path}`,
      `http://www.bit.ly${gap}.${greek}/${path}`,
      `http://203.0.113.10${gap}.${greek}/${path}`,
      `http://203.0.113${gap}.10\u0561/${path}`,
      `see http://bit${gap}.ly${greek}/${path}`,
      `http://bit${gap}.ly${greek}`,
      `http://bit${gap}.ly${greek}:80/${path}`,
      `http://bit.l\uFE0Fy${greek}/${path}`,
      `http://bit.l\u00ADy${greek}/${path}`,
      `http://bit.l\u034Fy${greek}/${path}`,
      `http://bit${gap}.ly${greek}/http://t.co/${path}`,
      `http://bit${gap}.ly${greek}.evil.com/${path}`,
      `http://example.com${gap}.ly${greek}/http://bit.ly/${path}`,
      `http://bit${gap}.ly${greek.repeat(61)}/${path}`,
      `http://bit.l${gap}y${greek.repeat(60)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit${gap}.ly${greek}/${path}`, "short_link:bit.ly"],
      [`bit.ly${gap}.${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit.ly${gap}.${greek}/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10${gap}.${greek}/${path}`, "ip_host:203.0.113.10"],
      [`http://bit${gap}.ly${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit${gap}.ly${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit${gap}.ly${greek} ${path}`, "short_link:bit.ly"],
      [`http://bit.ly\n${greek}/${path}`, "short_link:bit.ly"],
      [`http://bit${gap}.ly${greek.repeat(62)}/${path}`, "short_link:bit.ly"],
      [`http://bit.l${gap}y${greek.repeat(61)}/${path}`, "short_link:bit.ly"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(
        `http://bit${gap}.ly${greek}/${path} http://t.co/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit${gap}.ly${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.lyx.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a script letter after a buried nonspacing mark", async () => {
    const detector = createLinkDetector();
    const path = "offer196";
    const greek = "\u03B1";
    const mark = "\u034F";
    const kept = [
      `http://bit${mark}.ly${greek}/${path}`,
      `http://bit.ly${mark}.${greek}/${path}`,
      `http://bit${"\uFE0F"}.ly${greek}/${path}`,
      `http://bit${"\u180B"}.ly${greek}/${path}`,
      `http://bit${"\u180F"}.ly${greek}/${path}`,
      `http://www.bit${mark}.ly${greek}/${path}`,
      `http://203.0.113${mark}.10\u0561/${path}`,
      `see http://bit${mark}.ly${greek}/${path}`,
      `http://bit${mark}.ly${greek}`,
      `http://bit${mark}.ly${greek}:80/${path}`,
      `http://bit${mark}.ly${greek}/http://t.co/${path}`,
      `http://bit${mark}.ly${greek}.evil.com/${path}`,
      `http://bit${mark}.ly${greek.repeat(61)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit${mark}.ly${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit${mark}.ly${greek}/${path}`, "short_link:www.bit.ly"],
      [`203.0.113.10${mark}.${greek}/${path}`, "ip_host:203.0.113.10"],
      [`http://bit${mark}.ly${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit${mark}.ly${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit${mark}.ly${greek} ${path}`, "short_link:bit.ly"],
      [`http://bit.ly\n${greek}/${path}`, "short_link:bit.ly"],
      [`http://bit${mark}.ly${greek.repeat(62)}/${path}`, "short_link:bit.ly"],
      [`http://bit${mark}.ly/${path}`, "short_link:bit.ly"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(
        `http://bit${mark}.ly${greek}/${path} http://t.co/${path}`,
      ),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit${mark}.ly${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.lyx.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });

  it("keeps a script letter after a schemed hyphen", async () => {
    const detector = createLinkDetector();
    const path = "offer197";
    const greek = "\u03B1";
    const kept = [
      `http://bit.ly-${greek}/${path}`,
      `http://bit.ly--${greek}/${path}`,
      `http://www.bit.ly-${greek}/${path}`,
      `http://203.0.113.10-\u0561/${path}`,
      `see http://bit.ly-${greek}/${path}`,
      `http://bit.ly-${greek}`,
      `http://bit.ly-${greek}:80/${path}`,
      `http://bit.ly-${greek}/http://t.co/${path}`,
      `http://bit.ly-${greek}.evil.com/${path}`,
      `http://bit.ly-${greek.repeat(60)}/${path}`,
    ];
    for (const text of kept) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(hit, text).toBeNull();
      expect(JSON.stringify(hit), text).not.toContain("t.co");
      expect(JSON.stringify(hit), text).not.toContain("203.0.113.10");
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const opened = [
      [`bit.ly-${greek}/${path}`, "short_link:bit.ly"],
      [`www.bit.ly-${greek}/${path}`, "short_link:www.bit.ly"],
      [`http://bit.ly-${greek}#${path}`, "short_link:bit.ly"],
      [`http://bit.ly-${greek}@evil.com/${path}`, "short_link:bit.ly"],
      [`http://bit.ly-${greek} ${path}`, "short_link:bit.ly"],
      [`http://bit.ly\n-${greek}/${path}`, "short_link:bit.ly"],
      [`http://bit.ly-${greek.repeat(61)}/${path}`, "short_link:bit.ly"],
      [`http://bit.ly-/${path}`, "short_link:bit.ly"],
      [`http://bit.ly-.${greek}/${path}`, "short_link:bit.ly"],
      [`http://b${greek}it.ly/${path}`, "short_link:bit.ly"],
    ] as const;
    for (const [text, summary] of opened) {
      const hit = await detector.detect({
        event: eventFor(text),
        logger: createMemoryLogger(),
        signal,
      });
      expect(
        hit?.evidence.map((item) => item.summary),
        text,
      ).toEqual([summary]);
      expect(JSON.stringify(hit), text).not.toContain(path);
    }

    const later = await detector.detect({
      event: eventFor(`http://bit.ly-${greek}/${path} http://t.co/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(later?.evidence.map((item) => item.summary)).toEqual([
      "short_link:t.co",
    ]);
    expect(JSON.stringify(later)).not.toContain(path);

    const suffix = await detector.detect({
      event: eventFor(`http://bit.ly-${greek}.bit.ly/${path}`),
      logger: createMemoryLogger(),
      signal,
    });
    expect(suffix?.evidence.map((item) => item.summary)).toEqual([
      "short_link:bit.xn--ly--qxc.bit.ly",
    ]);
    expect(JSON.stringify(suffix)).not.toContain(path);
  });
});
