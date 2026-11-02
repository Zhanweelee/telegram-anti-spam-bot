/**
 * Characters removed before a keyword or pattern match.
 * An ordinary space (U+0020) stays. Other spaces, line breaks, and
 * variation selectors do not.
 */
const MATCH_GAPS =
  /[\t\n\v\f\r\u00A0\u00AD\u061C\u1680\u180E\u2000-\u200F\u2028-\u202E\u202F\u205F\u2060-\u2064\u2066-\u2069\u3000\uFEFF]/g;
const VARIATION_SELECTORS = /\p{Variation_Selector}/gu;

/**
 * Drop format characters, unicode spaces, line breaks, and variation
 * selectors before a text match. An ordinary space and visible letters
 * stay. The stored message is unchanged.
 */
export function foldMatchText(text: string): string {
  return text.replace(VARIATION_SELECTORS, "").replace(MATCH_GAPS, "");
}

/**
 * Dot-like characters that split a keyword or become a different hostname.
 * An ascii dot, an ordinary space, and the ideographic full stop stay.
 */
const DOT_LOOKALIKES =
  /[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF0E\uFE52\uFF61]/g;

/** Drop dot lookalikes before a keyword or pattern match. */
export function foldInterpuncts(text: string): string {
  return text.replace(DOT_LOOKALIKES, "");
}

/** Turn dot lookalikes into `.` before a hostname parse. */
export function foldDotLookalikes(text: string): string {
  return text.replace(DOT_LOOKALIKES, ".");
}

const HOST_DOT_LOOKALIKE =
  /[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF0E\uFE52\uFF61]/;

/**
 * Turn a dot lookalike into `.` unless an ASCII dot or `@` already precedes it,
 * or `@` follows it. Android keeps that character inside the label.
 * Folding it there would hide the next URL or split one URL.
 * A lookalike that separates labels still becomes `.`.
 */
function foldHostDots(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index);
    if (code === undefined) {
      break;
    }
    const char = String.fromCodePoint(code);
    const next = index + char.length;
    if (
      HOST_DOT_LOOKALIKE.test(char) &&
      !out.endsWith(".") &&
      !out.endsWith("@") &&
      text.codePointAt(next) !== 0x40
    ) {
      out += ".";
      index = next;
      continue;
    }
    out += char;
    index = next;
  }
  return out;
}

/**
 * Bracket pairs that stand in for a dot in a hostname.
 * One percent-encoded pair counts. A second layer and a space inside stay.
 * A bare ideographic full stop stays.
 */
const BRACKET_DOT =
  /(?:[[\uFF3B]|%5B)(?:\.|。|%2E)(?:[\]\uFF3D]|%5D)|(?:[(\uFF08]|%28)(?:\.|。|%2E)(?:[)\uFF09]|%29)|(?:[{\uFF5B]|%7B)(?:\.|。|%2E)(?:[}\uFF5D]|%7D)/gi;

/** Turn `[.]`, `(.)`, `{.}`, and one encoded pair into `.` before a hostname scan. */
export function foldBracketDots(text: string): string {
  return text.replace(BRACKET_DOT, ".");
}

/**
 * An encoded closing bracket glued to a finished host is the two hex
 * digits Android keeps. `bit%5B.%5Dly` and a literal `]` still become `.`.
 * A pair in a path, or after a line break, still becomes `.`.
 */
function foldGluedBracketDots(text: string): string {
  const pattern = new RegExp(BRACKET_DOT.source, "gi");
  let out = "";
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0] ?? "";
    out += text.slice(index, start);
    const closer = encodedBracketHex(raw);
    if (
      closer !== null &&
      !bracketSitsInPath(text, start) &&
      bracketOpensNext(text, start + raw.length)
    ) {
      out += closer;
    } else {
      out += raw;
    }
    index = start + raw.length;
  }
  return out + text.slice(index);
}

function encodedBracketHex(raw: string): string | null {
  const tail = raw.slice(-3);
  if (/^%(?:5d|29|7d)$/i.test(tail)) {
    return tail.slice(1);
  }
  return null;
}

function bracketOpensNext(text: string, index: number): boolean {
  const scheme = text.slice(index, index + 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return true;
  }
  if (text.charAt(index) === "." && gluedHostBodyLength(text, index + 1) > 0) {
    return true;
  }
  return gluedHostBodyLength(text, index) > 0;
}

function bracketSitsInPath(text: string, index: number): boolean {
  if (text.slice(index - 3, index).toLowerCase() === "://") {
    return false;
  }
  return encodedMarkSitsInPath(text, index);
}

function foldHostShape(text: string): string {
  return foldHostDots(
    foldHostEncodedMiddleDot(
      foldHostInterrupters(foldFullwidthLatin(foldCyrillicLookalikes(text))),
    ),
  );
}

function foldHostTail(text: string): string {
  const marked = foldGluedEncodedHyphen(foldGluedEncodedPlus(text, true), true);
  return foldBracketDots(
    foldEncodedAlphabet(foldEncodedSeparators(foldEncodedScheme(marked))),
  );
}

/**
 * A percent-encoded letter, colon, or slash that spells `http://` or
 * `https://` is not a scheme Android decodes. `%2F` glued to a written
 * scheme is not a slash either. `%2F` glued to a bare host is not a slash.
 * A literal scheme stays. `b%69t.ly` and `t.me%2F+…` are not schemes.
 * `!` ends the text in front, and `x` keeps the host after `://` from
 * starting. A bare host keeps its path, with the last label replaced so
 * the shortener suffix cannot match.
 */
function foldEncodedScheme(text: string): string {
  const prepared = text.replace(/%2F(?=https?:\/\/)/gi, "!x");
  let schemes = "";
  let index = 0;
  while (index < prepared.length) {
    const taken = encodedSchemeLength(prepared, index);
    if (taken > 0) {
      schemes += "!x";
      index += taken;
      continue;
    }
    schemes += prepared.charAt(index);
    index += 1;
  }
  return foldGluedEncodedSlashHost(schemes);
}

function foldGluedEncodedSlashHost(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text.slice(index, index + 3).toLowerCase() === "%2f") {
      const body = gluedHostBodyLength(text, index + 3);
      if (body > 0) {
        out += neutralizeGluedHost(text.slice(index + 3, index + 3 + body));
        index += 3 + body;
        continue;
      }
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedSchemeLength(text: string, index: number): number {
  const https = matchEncodedScheme(text, index, "https://");
  if (https > "https://".length) {
    return https;
  }
  const http = matchEncodedScheme(text, index, "http://");
  if (http > "http://".length) {
    return http;
  }
  return 0;
}

function matchEncodedScheme(
  text: string,
  index: number,
  scheme: string,
): number {
  let cursor = index;
  let encoded = false;
  for (const expected of scheme) {
    const taken = consumeSchemeChar(text, cursor, expected);
    if (taken === 0) {
      return 0;
    }
    if (taken > 1) {
      encoded = true;
    }
    cursor += taken;
  }
  return encoded ? cursor - index : 0;
}

function consumeSchemeChar(
  text: string,
  index: number,
  expected: string,
): number {
  const current = text.charAt(index);
  if (expected === ":" || expected === "/") {
    if (current === expected) {
      return 1;
    }
    return consumeEncodedMark(text, index, expected === ":" ? "3a" : "2f");
  }
  if (current.toLowerCase() === expected) {
    return 1;
  }
  return consumeEncodedSchemeLetter(text, index, expected);
}

function consumeEncodedMark(text: string, index: number, hex: string): number {
  const single = text.slice(index, index + 3).toLowerCase();
  if (single === `%${hex}`) {
    return 3;
  }
  if (
    hex === "3a" &&
    text.slice(index, index + 5).toLowerCase() === `%25${hex}`
  ) {
    return 5;
  }
  return 0;
}

function consumeEncodedSchemeLetter(
  text: string,
  index: number,
  expected: string,
): number {
  const lower = expected.charCodeAt(0).toString(16).padStart(2, "0");
  const upper = expected
    .toUpperCase()
    .charCodeAt(0)
    .toString(16)
    .padStart(2, "0");
  for (const marker of ["%25", "%"] as const) {
    if (text.slice(index, index + marker.length).toLowerCase() !== marker) {
      continue;
    }
    const hex = text
      .slice(index + marker.length, index + marker.length + 2)
      .toLowerCase();
    if (hex === lower || hex === upper) {
      return marker.length + 2;
    }
  }
  return 0;
}

/**
 * `%2E` glued to `http://` is not a dot Android decodes.
 * A line break between them still is. Rewrite the glued form before line
 * breaks disappear: `!` lets the host in front end, and `x` keeps `http`
 * from starting.
 */
/**
 * `%2E` glued to `http://` is not a dot Android decodes.
 * `%2E` glued to a host Android already finished is the two hex digits
 * at the start of that host. A dot inside `bit%2Ely` still becomes `.`.
 * A `%2E` in a path still becomes `.`. A line break or space still does.
 */
function foldGluedEncodedDot(text: string): string {
  const marked = text.replace(/%2E(?=https?:\/\/)/gi, "!x");
  let out = "";
  let index = 0;
  while (index < marked.length) {
    if (gluedEncodedDot(marked, index)) {
      out += marked.slice(index + 1, index + 3);
      index += 3;
      continue;
    }
    out += marked.charAt(index);
    index += 1;
  }
  return out;
}

function gluedEncodedDot(text: string, index: number): boolean {
  if (text.slice(index, index + 3).toLowerCase() !== "%2e") {
    return false;
  }
  if (encodedDotSitsInPath(text, index)) {
    return false;
  }
  const next = index + 3;
  if (text.charAt(next) === "." && gluedHostBodyLength(text, next + 1) > 0) {
    return true;
  }
  return gluedHostBodyLength(text, next) > 0;
}

/**
 * `%2B` glued to `http://` or to a bare host is not a plus Android decodes.
 * A line break between them still is. Rewrite the glued form before line
 * breaks disappear: `!` lets the host in front end, and `x` keeps `http`
 * from starting. A bare host keeps its path, with the last label replaced
 * so the shortener suffix cannot match. A percent-encoded host is included.
 * When its last dot is `%2E`, the span becomes `!` so a later URL still
 * opens. After gaps disappear, only that encoded host is rewritten.
 * `t.me/%2B…` is a path, so it still folds. `%2F%2B` is that same path
 * before the slash is decoded.
 */
function foldGluedEncodedPlus(text: string, encodedOnly = false): string {
  const scheme = encodedOnly
    ? text
    : text.replace(/%2B(?=https?:\/\/)/gi, "!x");
  let out = "";
  let index = 0;
  while (index < scheme.length) {
    const taken = gluedPlusHostLength(scheme, index);
    const host = taken > 0 ? scheme.slice(index + 3, index + taken) : "";
    if (taken > 0 && (!encodedOnly || host.includes("%"))) {
      out += neutralizeGluedHost(host);
      index += taken;
      continue;
    }
    out += scheme.charAt(index);
    index += 1;
  }
  return out;
}

function gluedPlusHostLength(text: string, index: number): number {
  if (text.slice(index, index + 3).toLowerCase() !== "%2b") {
    return 0;
  }
  if (encodedMarkSitsInPath(text, index)) {
    return 0;
  }
  const body = gluedHostBodyLength(text, index + 3);
  return body > 0 ? body + 3 : 0;
}

function encodedDotSitsInPath(text: string, index: number): boolean {
  if (text.slice(index - 3, index).toLowerCase() === "://") {
    return false;
  }
  return encodedMarkSitsInPath(text, index);
}

function encodedMarkSitsInPath(text: string, index: number): boolean {
  if (text.charAt(index - 1) === "/") {
    return true;
  }
  return text.slice(index - 3, index).toLowerCase() === "%2f";
}

function gluedHostBodyLength(text: string, index: number): number {
  const ip = gluedIpLength(text, index);
  if (ip > 0) {
    return ip;
  }
  return gluedNameLength(text, index);
}

function gluedIpLength(text: string, index: number): number {
  let cursor = index;
  const parts: string[] = [];
  for (let part = 0; part < 4; part += 1) {
    const octet = consumeOctet(text, cursor);
    if (octet.length === 0) {
      return 0;
    }
    parts.push(octet);
    cursor += octet.length;
    if (part < 3) {
      const dot = consumeHostDot(text, cursor);
      if (dot === 0) {
        return 0;
      }
      cursor += dot;
    }
  }
  const next = consumeHostDot(text, cursor) > 0 ? "." : text.charAt(cursor);
  if (!quadIsAddress(parts.join("."), next)) {
    return 0;
  }
  return cursor - index;
}

function consumeOctet(text: string, index: number): string {
  let digits = "";
  for (let offset = 0; offset < 3; offset += 1) {
    const char = text.charAt(index + offset);
    if (char < "0" || char > "9") {
      break;
    }
    digits += char;
  }
  return digits;
}

function gluedNameLength(text: string, index: number): number {
  let cursor = index;
  let labels = 0;
  for (let label = 0; label < 8; label += 1) {
    const taken = consumeHostLabel(text, cursor);
    if (taken === 0) {
      break;
    }
    const dot = consumeHostDot(text, cursor + taken);
    if (dot === 0) {
      break;
    }
    cursor += taken + dot;
    labels += 1;
  }
  if (labels === 0) {
    return 0;
  }
  const tld = consumeHostTld(text, cursor);
  if (tld === 0) {
    return 0;
  }
  return cursor + tld - index;
}

const LABEL_ALNUM = /[A-Za-z0-9]/;
const LABEL_MARK = /[_-]/;

function consumeHostLabel(text: string, index: number): number {
  const pieces: Array<{ length: number; alnum: boolean }> = [];
  let cursor = index;
  while (pieces.length < 63) {
    const unit = consumeLabelUnit(text, cursor);
    if (unit === null) {
      break;
    }
    pieces.push({ length: unit.length, alnum: LABEL_ALNUM.test(unit.char) });
    cursor += unit.length;
  }
  while (pieces.length > 0 && !pieces[pieces.length - 1]?.alnum) {
    const last = pieces.pop();
    if (last !== undefined) {
      cursor -= last.length;
    }
  }
  if (pieces.length === 0 || !pieces[0]?.alnum) {
    return 0;
  }
  return cursor - index;
}

function consumeLabelUnit(
  text: string,
  index: number,
): { length: number; char: string } | null {
  const current = text.charAt(index);
  if (LABEL_ALNUM.test(current) || LABEL_MARK.test(current)) {
    return { length: 1, char: current };
  }
  for (const marker of ["%25", "%"] as const) {
    if (text.slice(index, index + marker.length).toLowerCase() !== marker) {
      continue;
    }
    const hex = text.slice(index + marker.length, index + marker.length + 2);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      continue;
    }
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    if (LABEL_ALNUM.test(char) || LABEL_MARK.test(char)) {
      return { length: marker.length + 2, char };
    }
  }
  return null;
}

function consumeHostDot(text: string, index: number): number {
  if (text.charAt(index) === ".") {
    return 1;
  }
  if (text.slice(index, index + 3).toLowerCase() === "%2e") {
    return 3;
  }
  return 0;
}

function consumeHostTld(text: string, index: number): number {
  let cursor = index;
  let count = 0;
  while (count < 63) {
    const unit = consumeLabelUnit(text, cursor);
    if (unit === null || !/[A-Za-z]/.test(unit.char)) {
      break;
    }
    cursor += unit.length;
    count += 1;
  }
  if (count < 2) {
    return 0;
  }
  return cursor - index;
}

function quadIsAddress(quad: string, next: string): boolean {
  if (next === "." || (next >= "0" && next <= "9")) {
    return false;
  }
  return quad.split(".").every((part) => {
    const value = Number(part);
    return part === String(value) && value <= 255;
  });
}

function neutralizeGluedHost(host: string): string {
  const literal = host.lastIndexOf(".");
  const encoded = host.toLowerCase().lastIndexOf("%2e");
  if (literal < 0 || encoded > literal) {
    return "!";
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    return "!0.arpa";
  }
  return `!${host.slice(0, literal)}.arpa`;
}

/**
 * `%2D` and the one extra `%252D` layer glued to `http://` or to a bare
 * host are not hyphens Android decodes. A line break between them still is.
 * Rewrite the glued form before line breaks disappear: `!` lets the host in
 * front end, and `x` keeps `http` from starting. A bare host keeps its path,
 * with the last label replaced so the shortener suffix cannot match.
 * A host that is itself percent-encoded is included. After gaps disappear,
 * only that encoded host is rewritten. `bit%2Dly` is not glued to a host.
 */
function foldGluedEncodedHyphen(text: string, encodedOnly = false): string {
  const scheme = encodedOnly
    ? text
    : text.replace(/%(?:25)?2D(?=https?:\/\/)/gi, "!x");
  let out = "";
  let index = 0;
  while (index < scheme.length) {
    const marker = gluedHyphenMarkerLength(scheme, index);
    const body =
      marker > 0 && !encodedMarkSitsInPath(scheme, index)
        ? gluedHostBodyLength(scheme, index + marker)
        : 0;
    const host =
      body > 0 ? scheme.slice(index + marker, index + marker + body) : "";
    if (body > 0 && (!encodedOnly || host.includes("%"))) {
      out += neutralizeGluedHost(host);
      index += marker + body;
      continue;
    }
    out += scheme.charAt(index);
    index += 1;
  }
  return out;
}

function gluedHyphenMarkerLength(text: string, index: number): number {
  if (text.slice(index, index + 5).toLowerCase() === "%252d") {
    return 5;
  }
  if (text.slice(index, index + 3).toLowerCase() === "%2d") {
    return 3;
  }
  return 0;
}

/**
 * Fold plain text before a hostname scan.
 * This is the link-detector order. Structured URL parsing keeps its own order.
 * An ordinary space stays. A second percent layer stays.
 * Gaps are removed so a short link split by an invisible character still matches.
 * A dot lookalike after an ASCII dot stays in the label.
 * `%2E`, `%2B`, or `%2D` glued to a scheme stays out of that scheme.
 * `%2B` glued to a bare host stays out of that host.
 * `%2D` glued to a bare host stays out of that host.
 * The same marks glued to a percent-encoded host stay out of that host.
 * A percent-encoded letter that spells the scheme stays out of that scheme.
 * `%2F` that spells `://`, or sits immediately before the scheme, stays out.
 * `%2F` glued to a bare host stays out of that host.
 * A percent-encoded gap stays when its hex digits are the start of the host,
 * or when it sits inside `http://` before `://`.
 * A percent-encoded dot lookalike stays when a host or scheme follows it.
 * The same lookalike used as the dot inside a host still becomes `.`.
 * `%2E` glued to a finished host becomes the two hex digits Android keeps.
 * `%2E` used as the dot inside a host still becomes `.`.
 * An encoded bracket pair glued to a finished host becomes its closing hex.
 * `bit%5B.%5Dly` and a literal closing bracket still become `.`.
 * A run of Android label characters sitting between ASCII letters or digits
 * becomes `x`, so one host is not read as the shortener inside it.
 * A run before `http://` or `https://` stays. `。` stays. A label character
 * with no ASCII letter before it stays.
 */
export function foldHostScan(text: string): string {
  return foldHostTail(
    foldHostEncodedGaps(
      foldGluedLabelRuns(
        foldMatchText(
          foldGluedEncodedHyphen(
            foldGluedEncodedPlus(
              foldGluedEncodedDot(foldGluedBracketDots(foldHostShape(text))),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Same host fold, with tabs, line breaks, and percent-encoded gaps left in place.
 * Android stops at those characters. The joined host from `foldHostScan` stays separate.
 */
export function foldHostScanKeepingGaps(text: string): string {
  return foldHostTail(foldHostShape(text));
}

/**
 * Host fold that leaves Android's stopping characters in place.
 * Percent encodings, bracketed dots, gaps, and a letter after a finished
 * host stay. A letter between two ASCII letters still drops, so `bαit.ly`
 * can match. A Cyrillic lookalike or fullwidth letter stays when `http://`
 * or `https://` follows it, so a bare host can end. Other lookalike letters
 * still fold. Dot lookalikes stay, so a bare host written with them does
 * not swallow the next URL. The joined scan still folds those letters.
 */
export function foldHostScanKeepingStops(text: string): string {
  return foldGluedLabelRuns(
    foldHostInterruptersAndroidKeeps(foldAndroidLetterUnlessScheme(text)),
  );
}

/**
 * Android keeps these characters inside the same host label.
 * Replacing the run with `x` stops a later ASCII label from being its own URL.
 * `。` still separates labels for the URL parser. A following scheme stays.
 */
function foldGluedLabelRuns(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index);
    if (code === undefined) {
      break;
    }
    const char = String.fromCodePoint(code);
    const next = index + char.length;
    if (gluedLabelCode(code) && asciiHostLetter(text, index - 1)) {
      let end = next;
      while (end < text.length) {
        const more = text.codePointAt(end);
        if (more === undefined || !gluedLabelCode(more)) {
          break;
        }
        end += String.fromCodePoint(more).length;
      }
      if (asciiHostLetter(text, end) && !startsWithScheme(text, end)) {
        out += "x";
        index = end;
        continue;
      }
    }
    out += char;
    index = next;
  }
  return out;
}

const GLUED_LABEL_SKIP = new Set([
  0x00b7, 0x2022, 0x2027, 0x2219, 0x22c5, 0x3002, 0x30fb, 0xff0e, 0xfe52,
  0xff61,
]);

function gluedLabelCode(code: number): boolean {
  return code > 0x7f && !GLUED_LABEL_SKIP.has(code) && androidLabelCode(code);
}

const CYRILLIC_LOOKALIKES: Record<string, string> = {
  "\u0406": "I",
  "\u0410": "A",
  "\u0415": "E",
  "\u041E": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0423": "Y",
  "\u0425": "X",
  "\u0430": "a",
  "\u0435": "e",
  "\u043E": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0443": "y",
  "\u0445": "x",
  "\u0456": "i",
};

/**
 * Fold Cyrillic letters that share a Latin shape.
 * Cyrillic т and every other letter stay.
 */
export function foldCyrillicLookalikes(text: string): string {
  let out = "";
  for (const char of text) {
    out += CYRILLIC_LOOKALIKES[char] ?? char;
  }
  return out;
}

/**
 * Letters that would split an ASCII hostname into a shorter tail.
 * ASCII letters stay. These letters are removed, not mapped.
 */
const HOST_INTERRUPTER =
  /[\p{Script=Armenian}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Latin}]/u;

/**
 * Drop Armenian, Cyrillic, Greek, and non-ASCII Latin letters before a
 * hostname scan. CJK, Hangul, kana, and ASCII stay. These letters are
 * removed, not mapped.
 */
export function foldHostInterrupters(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code !== undefined && code > 0x7f && HOST_INTERRUPTER.test(char)) {
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Drop a label letter only when it sits between two ASCII letters or digits.
 * A following URL stays, so a bare host can end before that letter.
 * The joined scan still removes every letter.
 */
function foldHostInterruptersAndroidKeeps(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index);
    if (code === undefined) {
      break;
    }
    const char = String.fromCodePoint(code);
    const next = index + char.length;
    if (
      code > 0x7f &&
      androidLabelCode(code) &&
      HOST_INTERRUPTER.test(char) &&
      asciiHostLetter(text, index - 1) &&
      asciiHostLetter(text, next) &&
      !startsWithScheme(text, next)
    ) {
      index = next;
      continue;
    }
    out += char;
    index = next;
  }
  return out;
}

function asciiHostLetter(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) {
    return false;
  }
  const code = text.charCodeAt(index);
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function startsWithScheme(text: string, index: number): boolean {
  const rest = text.slice(index, index + "https://".length).toLowerCase();
  return rest.startsWith("https://") || rest.startsWith("http://");
}

/**
 * Non-ASCII code points in `LinkifyPort.UCS_CHAR_FIXED`.
 * The caller already skipped ASCII.
 */
function androidLabelCode(code: number): boolean {
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

/**
 * Fold fullwidth Latin letters to ASCII.
 * Fullwidth digits, U+FF0B, and other characters stay.
 */
export function foldFullwidthLatin(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      out += char;
      continue;
    }
    out += fullwidthLatin(code) ?? char;
  }
  return out;
}

/**
 * Map a Cyrillic lookalike or fullwidth letter to ASCII, unless the next
 * characters are `http://` or `https://`. Android does not treat that
 * letter as a word character, so the bare host ends and the URL opens.
 */
function foldAndroidLetterUnlessScheme(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; ) {
    const code = text.codePointAt(index);
    if (code === undefined) {
      break;
    }
    const char = String.fromCodePoint(code);
    const next = index + char.length;
    const mapped = CYRILLIC_LOOKALIKES[char] ?? fullwidthLatin(code);
    if (mapped !== undefined && !startsWithScheme(text, next)) {
      out += mapped;
      index = next;
      continue;
    }
    out += char;
    index = next;
  }
  return out;
}

function fullwidthLatin(code: number): string | undefined {
  if (code >= 0xff21 && code <= 0xff3a) {
    return String.fromCodePoint(code - 0xff21 + 0x41);
  }
  if (code >= 0xff41 && code <= 0xff5a) {
    return String.fromCodePoint(code - 0xff41 + 0x61);
  }
  return undefined;
}

/**
 * Drop percent-encoded characters that `foldMatchText` would remove.
 * A second layer written as `%25HH` is removed the same way.
 * `%20`, `%2E`, `%2520`, and `%252E` stay. A third layer stays.
 */
export function foldEncodedGaps(text: string): string {
  return dropEncodedGaps(text, true);
}

/**
 * Host scan keeps an encoded gap whose hex digits open the host Android
 * actually shows, and a gap inside `http://` before `://`. A gap after a
 * label character still drops, so `bit%E2%80%8B.ly` stays one host.
 */
function foldHostEncodedGaps(text: string): string {
  return dropEncodedGaps(text, false);
}

function dropEncodedGaps(text: string, everyGap: boolean): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const skipped = encodedGapLength(text, index);
    const doubled = skipped > 0 ? 0 : doubleEncodedGapLength(text, index);
    const taken = skipped > 0 ? skipped : doubled;
    if (taken > 0 && (everyGap || encodedGapJoinsLabel(text, index, taken))) {
      index += taken;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedGapJoinsLabel(
  text: string,
  index: number,
  taken: number,
): boolean {
  if (!/[A-Za-z0-9_-]/.test(text.charAt(index - 1))) {
    return false;
  }
  let cursor = index + taken;
  while (/[A-Za-z]/.test(text.charAt(cursor))) {
    cursor += 1;
  }
  return text.slice(cursor, cursor + 3) !== "://";
}

const DOT_LOOKALIKE_CHAR =
  /[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF0E\uFE52\uFF61]/;

/**
 * Turn one percent-encoded dot lookalike into that character.
 * A second layer, and the ideographic full stop, stay.
 */
export function foldEncodedMiddleDot(text: string): string {
  return replaceEncodedDots(text, false);
}

/**
 * Host scan keeps a percent-encoded dot lookalike when a host, `.` plus a
 * host, or `http://` / `https://` follows it. Android leaves those hex
 * digits in the next label. `bit%C2%B7ly` still becomes a dot.
 */
function foldHostEncodedMiddleDot(text: string): string {
  return replaceEncodedDots(text, true);
}

function replaceEncodedDots(text: string, keepBeforeHost: boolean): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const found = encodedDot(text, index);
    if (
      found !== null &&
      !(keepBeforeHost && encodedDotSitsBeforeHost(text, index + found.length))
    ) {
      out += found.char;
      index += found.length;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedDotSitsBeforeHost(text: string, index: number): boolean {
  const scheme = text.slice(index, index + 8).toLowerCase();
  if (scheme.startsWith("https://") || scheme.startsWith("http://")) {
    return true;
  }
  if (text.charAt(index) === "." && gluedHostBodyLength(text, index + 1) > 0) {
    return true;
  }
  return gluedHostBodyLength(text, index) > 0;
}

function encodedDot(
  text: string,
  index: number,
): { readonly char: string; readonly length: number } | null {
  const first = readPercentByte(text, index);
  if (!first) {
    return null;
  }
  const width = utf8Width(first.byte);
  if (!width) {
    return null;
  }
  const bytes = [first.byte];
  let next = first.next;
  for (let part = 1; part < width; part += 1) {
    const byte = readPercentByte(text, next);
    if (!byte || (byte.byte & 0xc0) !== 0x80) {
      return null;
    }
    bytes.push(byte.byte);
    next = byte.next;
  }
  const char = decodeUtf8(bytes);
  if (char === null || !DOT_LOOKALIKE_CHAR.test(char)) {
    return null;
  }
  return { char, length: next - index };
}

/** Turn one `%2E`, `%2F`, or `%2B` into `.`, `/`, or `+`. A second layer stays. */
export function foldEncodedSeparators(text: string): string {
  return text.replace(/%2E/gi, ".").replace(/%2F/gi, "/").replace(/%2B/gi, "+");
}

const ENCODED_ALPHABET_CHAR = /[A-Za-z0-9_-]/;

/**
 * Turn one `%HH`, or one `%25HH`, into a letter, digit, hyphen, or
 * underscore. `%20`, `%2E`, `%252E`, and a third layer stay.
 */
export function foldEncodedAlphabet(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const doubled = encodedAlphabetLength(text, index, "%25");
    const single = doubled > 0 ? 0 : encodedAlphabetLength(text, index, "%");
    const taken = doubled > 0 ? doubled : single;
    if (taken > 0) {
      const hex = text.slice(index + taken - 2, index + taken);
      out += alphabetChar(hex);
      index += taken;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

function encodedAlphabetLength(
  text: string,
  index: number,
  marker: "%25" | "%",
): number {
  if (text.slice(index, index + marker.length).toLowerCase() !== marker) {
    return 0;
  }
  const hex = text.slice(index + marker.length, index + marker.length + 2);
  if (!/^[0-9a-fA-F]{2}$/.test(hex) || alphabetChar(hex) === null) {
    return 0;
  }
  return marker.length + 2;
}

function alphabetChar(hex: string): string | null {
  const char = String.fromCharCode(Number.parseInt(hex, 16));
  return ENCODED_ALPHABET_CHAR.test(char) ? char : null;
}

const ANDROID_SCHEME = /^(https?:\/\/)/i;
const ANDROID_USERINFO =
  /^(?:[A-Za-z0-9$_.+!*'(),;?&=-]|%[0-9A-Fa-f]{2}){1,64}(?::(?:[A-Za-z0-9$_.+!*'(),;?&=-]|%[0-9A-Fa-f]{2}){1,25})?@/;
const ANDROID_SLASH = /\u2215|\u2044|%E2%88%95|%E2%81%84/g;
const ANDROID_LABEL_CHAR = /[A-Za-z0-9]/;
const ANDROID_LABEL_WORD = /[A-Za-z0-9_]/;
const ANDROID_LABEL_MAX = 63;

/** ASCII, plus the three spaces `LinkifyPort` keeps inside a label. */
function androidLabelChar(char: string): boolean {
  if (ANDROID_LABEL_CHAR.test(char)) {
    return true;
  }
  const code = char.charCodeAt(0);
  return code === 0x1680 || code === 0x205f || code === 0xfeff;
}

/** A label unit Android can keep, including letters outside ASCII. */
function androidLabelUnit(char: string): boolean {
  return androidLabelChar(char) || androidLabelCode(char.charCodeAt(0));
}

/** Java `\b` or the end of the text. A label cannot finish without one. */
function labelBoundary(raw: string, index: number): boolean {
  if (index <= 0 || index >= raw.length) {
    return true;
  }
  const last = ANDROID_LABEL_WORD.test(raw.charAt(index - 1));
  const next = ANDROID_LABEL_WORD.test(raw.charAt(index));
  return last !== next;
}

function acceptableLabelEnd(
  raw: string,
  index: number,
  start: number,
): boolean {
  if (index <= start || !labelBoundary(raw, index)) {
    return false;
  }
  const last = raw.charAt(index - 1);
  return last !== "-" && last !== "_";
}

function readAndroidLabel(raw: string, index: number): number | null {
  if (!androidLabelUnit(raw.charAt(index))) {
    return null;
  }
  const start = index;
  let next = index + 1;
  while (next < raw.length && next - start < ANDROID_LABEL_MAX) {
    if (androidLabelUnit(raw.charAt(next))) {
      next += 1;
      continue;
    }
    const mark = raw.charAt(next);
    if (mark !== "-" && mark !== "_") {
      break;
    }
    let look = next;
    while (
      look < raw.length &&
      (raw.charAt(look) === "-" || raw.charAt(look) === "_")
    ) {
      look += 1;
    }
    if (
      look >= raw.length ||
      !androidLabelUnit(raw.charAt(look)) ||
      look - start >= ANDROID_LABEL_MAX
    ) {
      break;
    }
    next = look + 1;
  }
  if (acceptableLabelEnd(raw, next, start)) {
    return next;
  }
  for (let end = next - 1; end > start; end -= 1) {
    if (acceptableLabelEnd(raw, end, start)) {
      return end;
    }
  }
  return null;
}

/**
 * URL Android highlights, when that span is shorter or replaces a slash.
 * The matcher stops unless the next character continues a path.
 * A label cannot end on a hyphen, and it cannot be longer than 63 characters.
 * U+1680, U+205F, U+FEFF, and other Android label characters stay inside the label.
 * The label still ends where the next character has no word boundary.
 * An underscore can sit inside a label. A label cannot end in front of one.
 * A dot starts a label only when one follows.
 * A port is one to five digits and cannot end in the middle of a longer number.
 * A hyphen inside user info stays with `@`.
 * User info stays when `@` is followed by a host, a label character, a path, a finished port, `_`, or the end.
 * Otherwise the highlighted host is the one before `@`.
 * A division slash or fraction slash inside the span becomes `/`.
 * The same string comes back as null.
 */
function userinfoSticks(raw: string, index: number): boolean {
  if (index >= raw.length) {
    return true;
  }
  const code = raw.codePointAt(index);
  if (code === undefined) {
    return true;
  }
  const mark = String.fromCodePoint(code);
  if (mark === "/" || mark === "?" || mark === "_") {
    return true;
  }
  if (androidLabelChar(mark) || (code > 0x7f && androidLabelCode(code))) {
    return true;
  }
  if (mark !== ":") {
    return false;
  }
  const port = /^:\d{1,5}(?!\d)/.exec(raw.slice(index));
  if (!port?.[0]) {
    return false;
  }
  const after = index + port[0].length;
  return after >= raw.length || !ANDROID_LABEL_WORD.test(raw.charAt(after));
}

export function androidUrlSpan(raw: string): string | null {
  const scheme = ANDROID_SCHEME.exec(raw);
  if (scheme?.index !== 0) {
    return null;
  }
  let index = scheme[0].length;
  const user = ANDROID_USERINFO.exec(raw.slice(index));
  if (user?.[0] && userinfoSticks(raw, index + user[0].length)) {
    index += user[0].length;
  }
  const first = readAndroidLabel(raw, index);
  if (first === null) {
    return null;
  }
  index = first;
  while (raw.charAt(index) === ".") {
    const next = readAndroidLabel(raw, index + 1);
    if (next === null) {
      break;
    }
    index = next;
  }
  if (raw.charAt(index) === ":") {
    const port = /^:\d{1,5}(?!\d)/.exec(raw.slice(index));
    if (port?.[0]) {
      index += port[0].length;
    }
  }
  const next = raw.charAt(index);
  const continues =
    next.length === 0 || next === "/" || next === "?" || next === "#";
  const span = continues ? raw : raw.slice(0, index);
  const folded = span.replace(ANDROID_SLASH, "/");
  return folded === raw ? null : folded;
}

function encodedGapLength(text: string, index: number): number {
  const first = readPercentByte(text, index);
  if (!first) {
    return 0;
  }
  const width = utf8Width(first.byte);
  if (!width) {
    return 0;
  }
  const bytes = [first.byte];
  let next = first.next;
  for (let part = 1; part < width; part += 1) {
    const byte = readPercentByte(text, next);
    if (!byte || (byte.byte & 0xc0) !== 0x80) {
      return 0;
    }
    bytes.push(byte.byte);
    next = byte.next;
  }
  const char = decodeUtf8(bytes);
  if (char === null || foldMatchText(char) !== "") {
    return 0;
  }
  return next - index;
}

function doubleEncodedGapLength(text: string, index: number): number {
  let inner = "";
  let cursor = index;
  let groups = 0;
  while (groups < 4 && cursor + 5 <= text.length) {
    if (text.slice(cursor, cursor + 3).toLowerCase() !== "%25") {
      break;
    }
    const hex = text.slice(cursor + 3, cursor + 5);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
      break;
    }
    inner += `%${hex}`;
    cursor += 5;
    groups += 1;
    if (encodedGapsCover(inner)) {
      return cursor - index;
    }
  }
  return 0;
}

function encodedGapsCover(text: string): boolean {
  let index = 0;
  while (index < text.length) {
    const skipped = encodedGapLength(text, index);
    if (skipped === 0) {
      return false;
    }
    index += skipped;
  }
  return text.length > 0;
}

function readPercentByte(
  text: string,
  index: number,
): { readonly byte: number; readonly next: number } | null {
  if (text.charCodeAt(index) !== 37) {
    return null;
  }
  const hex = text.slice(index + 1, index + 3);
  if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
    return null;
  }
  return { byte: Number.parseInt(hex, 16), next: index + 3 };
}

function utf8Width(first: number): number | null {
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
  return null;
}

function decodeUtf8(bytes: readonly number[]): string | null {
  const point = codePoint(bytes);
  if (point === null || point > 0x10ffff) {
    return null;
  }
  return String.fromCodePoint(point);
}

function codePoint(bytes: readonly number[]): number | null {
  const first = bytes[0];
  if (first === undefined) {
    return null;
  }
  if (bytes.length === 1) {
    return first;
  }
  const second = bytes[1];
  if (second === undefined) {
    return null;
  }
  if (bytes.length === 2) {
    return ((first & 0x1f) << 6) | (second & 0x3f);
  }
  const third = bytes[2];
  if (third === undefined) {
    return null;
  }
  if (first === 0xe0 && second < 0xa0) {
    return null;
  }
  if (first === 0xed && second >= 0xa0) {
    return null;
  }
  if (bytes.length === 3) {
    return ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
  }
  const fourth = bytes[3];
  if (fourth === undefined) {
    return null;
  }
  if (first === 0xf0 && second < 0x90) {
    return null;
  }
  if (first === 0xf4 && second >= 0x90) {
    return null;
  }
  return (
    ((first & 0x07) << 18) |
    ((second & 0x3f) << 12) |
    ((third & 0x3f) << 6) |
    (fourth & 0x3f)
  );
}
