import { sha256Hex } from "./hash.js";

/** Telegram allows 1–256 characters for `secret_token`. */
export const MAX_SECRET_LENGTH = 256;

/**
 * Compare two secrets by hashing both, then walking the fixed-length digests.
 * A length check on the raw secrets would leak the configured secret's length.
 */
export async function secretsMatch(
  provided: string,
  expected: string,
): Promise<boolean> {
  if (
    provided.length === 0 ||
    expected.length === 0 ||
    provided.length > MAX_SECRET_LENGTH ||
    expected.length > MAX_SECRET_LENGTH
  ) {
    return false;
  }
  const [left, right] = await Promise.all([
    sha256Hex(provided),
    sha256Hex(expected),
  ]);
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}
