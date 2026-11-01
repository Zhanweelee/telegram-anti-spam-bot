import {
  hmacSha256Hex,
  sha256HexUtf8,
  signaturesMatch,
} from "@tasb/adapter-cloudflare";
import {
  admitPlugin,
  canonicalPluginPayload,
  type PluginAdmission,
  type PluginManifest,
} from "@tasb/core";

const exampleKey = "example-key";

export async function admitExample(input: {
  readonly allowUnsigned: boolean;
  readonly sign: boolean;
}): Promise<PluginAdmission> {
  const payload = canonicalPluginPayload({
    id: "extra",
    version: "0.1.0",
    kind: "detector",
    schema: "extra",
  });
  const integrity = await sha256HexUtf8(payload);
  const signature = input.sign
    ? await hmacSha256Hex(payload, exampleKey)
    : undefined;
  const manifest: PluginManifest = {
    id: "extra",
    version: "0.1.0",
    kind: "detector",
    schema: "extra",
    integrity,
    ...(signature ? { signature } : {}),
  };
  const signatureValid = signature
    ? signaturesMatch(signature, await hmacSha256Hex(payload, exampleKey))
    : false;
  return admitPlugin({
    manifest,
    computedIntegrity: integrity,
    signatureValid,
    source: "external",
    allowUnsigned: input.allowUnsigned,
  });
}
