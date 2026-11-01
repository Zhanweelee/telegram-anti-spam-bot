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
      event: eventFor("b\u0456t.ly/uk64"),
      logger: createMemoryLogger(),
      signal,
    });
    expect(ukrainian).toBeNull();
  });
});
