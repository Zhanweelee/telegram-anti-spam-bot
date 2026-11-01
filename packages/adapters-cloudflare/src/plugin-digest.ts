interface DigestCrypto {
  subtle: {
    digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
    importKey(
      format: "raw",
      key: Uint8Array,
      algorithm: { name: "HMAC"; hash: "SHA-256" },
      extractable: false,
      usages: ["sign"],
    ): Promise<unknown>;
    sign(
      algorithm: "HMAC",
      key: unknown,
      data: Uint8Array,
    ): Promise<ArrayBuffer>;
  };
}

export async function sha256HexUtf8(value: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", utf8(value));
  return toHex(digest);
}

export async function hmacSha256Hex(
  value: string,
  key: string,
): Promise<string> {
  const cryptoKey = await subtle().importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle().sign("HMAC", cryptoKey, utf8(value));
  return toHex(signature);
}

export function signaturesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function subtle(): DigestCrypto["subtle"] {
  const crypto = (globalThis as { crypto?: DigestCrypto }).crypto;
  if (!crypto) {
    throw new Error("crypto_unavailable");
  }
  return crypto.subtle;
}

function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
