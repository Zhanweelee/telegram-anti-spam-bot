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

/** Turn one `%2E`, `%2F`, or `%2B` into `.`, `/`, or `+`. A second layer stays. */
export function foldEncodedSeparators(text: string): string {
  return text.replace(/%2E/gi, ".").replace(/%2F/gi, "/").replace(/%2B/gi, "+");
}

const ENCODED_ALPHABET = /%[0-9A-Fa-f]{2}/g;

/**
 * Turn one `%HH` into a letter, digit, hyphen, or underscore.
 * `%20`, `%2E`, and a second layer written as `%25HH` stay.
 */
export function foldEncodedAlphabet(text: string): string {
  return text.replace(ENCODED_ALPHABET, (token) => {
    const char = String.fromCharCode(Number.parseInt(token.slice(1), 16));
    return /[A-Za-z0-9_-]/.test(char) ? char : token;
  });
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
