import { describe, expect, it } from "vitest";
import {
  admitPlugin,
  canonicalPluginPayload,
  type PluginManifest,
} from "./plugin-manifest.js";

const phrase = "请免费领取礼品";
const integrity = "ab".repeat(32);
const signature = "cd".repeat(32);

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "keyword",
    version: "0.1.0",
    kind: "detector",
    schema: "keyword",
    integrity,
    ...overrides,
  };
}

describe("canonicalPluginPayload", () => {
  it("keeps a stable key order", () => {
    expect(
      canonicalPluginPayload({
        version: "0.1.0",
        schema: "keyword",
        kind: "detector",
        id: "keyword",
      }),
    ).toBe(
      '{"id":"keyword","kind":"detector","schema":"keyword","version":"0.1.0"}',
    );
  });
});

describe("admitPlugin", () => {
  it("rejects a raw-text field and an integrity mismatch", () => {
    const invalid = admitPlugin({
      manifest: { ...manifest(), text: phrase },
      computedIntegrity: integrity,
      signatureValid: false,
      source: "external",
      allowUnsigned: true,
    });
    expect(invalid).toEqual({ ok: false, reason: "invalid" });
    expect(JSON.stringify(invalid)).not.toContain(phrase);
    const mismatch = admitPlugin({
      manifest: manifest(),
      computedIntegrity: "ef".repeat(32),
      signatureValid: true,
      source: "builtin",
      allowUnsigned: true,
    });
    expect(mismatch).toEqual({ ok: false, reason: "integrity_mismatch" });
    const malformed = admitPlugin({
      manifest: manifest(),
      computedIntegrity: "not-a-hash",
      signatureValid: false,
      source: "builtin",
      allowUnsigned: false,
    });
    expect(malformed).toEqual({ ok: false, reason: "integrity_mismatch" });
  });

  it("lets builtins and an explicit unsigned opt-in through", () => {
    expect(
      admitPlugin({
        manifest: manifest(),
        computedIntegrity: integrity,
        signatureValid: false,
        source: "builtin",
        allowUnsigned: false,
      }).ok,
    ).toBe(true);
    expect(
      admitPlugin({
        manifest: manifest(),
        computedIntegrity: integrity,
        signatureValid: false,
        source: "external",
        allowUnsigned: false,
      }),
    ).toEqual({ ok: false, reason: "unsigned" });
    expect(
      admitPlugin({
        manifest: manifest(),
        computedIntegrity: integrity,
        signatureValid: false,
        source: "external",
        allowUnsigned: true,
      }).ok,
    ).toBe(true);
  });

  it("rejects a bad signature even when unsigned plugins are allowed", () => {
    const signed = manifest({ signature });
    expect(
      admitPlugin({
        manifest: signed,
        computedIntegrity: integrity,
        signatureValid: false,
        source: "external",
        allowUnsigned: true,
      }),
    ).toEqual({ ok: false, reason: "bad_signature" });
    expect(
      admitPlugin({
        manifest: signed,
        computedIntegrity: integrity,
        signatureValid: true,
        source: "external",
        allowUnsigned: false,
      }).ok,
    ).toBe(true);
  });
});
