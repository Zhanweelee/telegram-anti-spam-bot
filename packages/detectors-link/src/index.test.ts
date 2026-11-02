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
});
