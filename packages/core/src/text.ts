/**
 * Characters removed before a keyword or pattern match.
 * An ordinary space (U+0020) stays. Other spaces and line breaks do not.
 */
const MATCH_GAPS =
  /[\t\n\v\f\r\u00A0\u00AD\u061C\u1680\u180E\u2000-\u200F\u2028-\u202E\u202F\u205F\u2060-\u2064\u2066-\u2069\u3000\uFEFF]/g;

/**
 * Drop format characters, unicode spaces, and line breaks before a text match.
 * An ordinary space and visible letters stay. The stored message is unchanged.
 */
export function foldMatchText(text: string): string {
  return text.replace(MATCH_GAPS, "");
}
