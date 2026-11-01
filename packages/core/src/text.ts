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
    if (code >= 0xff21 && code <= 0xff3a) {
      out += String.fromCodePoint(code - 0xff21 + 0x41);
      continue;
    }
    if (code >= 0xff41 && code <= 0xff5a) {
      out += String.fromCodePoint(code - 0xff41 + 0x61);
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Drop percent-encoded characters that `foldMatchText` would remove.
 * A second layer written as `%25HH` is removed the same way.
 * `%20`, `%2E`, `%2520`, and `%252E` stay. A third layer stays.
 */
export function foldEncodedGaps(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const skipped = encodedGapLength(text, index);
    const doubled = skipped > 0 ? 0 : doubleEncodedGapLength(text, index);
    const taken = skipped > 0 ? skipped : doubled;
    if (taken > 0) {
      index += taken;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
}

const DOT_LOOKALIKE_CHAR =
  /[\u00B7\u2022\u2027\u2219\u22C5\u30FB\uFF0E\uFE52\uFF61]/;

/**
 * Turn one percent-encoded dot lookalike into that character.
 * A second layer, and the ideographic full stop, stay.
 */
export function foldEncodedMiddleDot(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const found = encodedDot(text, index);
    if (found !== null) {
      out += found.char;
      index += found.length;
      continue;
    }
    out += text.charAt(index);
    index += 1;
  }
  return out;
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
