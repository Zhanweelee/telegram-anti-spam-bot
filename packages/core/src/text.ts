/** Format characters that are invisible in a keyword or pattern match. */
const FORMAT_CHARS =
  /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/**
 * Drop invisible format characters before a text match.
 * Spaces and visible letters stay. The stored message is unchanged.
 */
export function foldMatchText(text: string): string {
  return text.replace(FORMAT_CHARS, "");
}
