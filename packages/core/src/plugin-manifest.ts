import { z } from "zod";

const pluginIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const pluginKinds = [
  "detector",
  "action",
  "rule_source",
  "notifier",
  "storage",
] as const;
export const pluginKindSchema = z.enum(pluginKinds);
export type PluginKind = z.output<typeof pluginKindSchema>;

export const pluginSources = ["builtin", "external"] as const;
export const pluginSourceSchema = z.enum(pluginSources);
export type PluginSource = z.output<typeof pluginSourceSchema>;

export const pluginManifestSchema = z.strictObject({
  id: pluginIdSchema,
  version: versionSchema,
  kind: pluginKindSchema,
  schema: pluginIdSchema,
  integrity: sha256Schema,
  signature: sha256Schema.optional(),
});

export type PluginManifest = z.output<typeof pluginManifestSchema>;

export const pluginRejectReasons = [
  "invalid",
  "integrity_mismatch",
  "unsigned",
  "bad_signature",
] as const;
export type PluginRejectReason = (typeof pluginRejectReasons)[number];

export type PluginAdmission =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly reason: PluginRejectReason };

export function canonicalPluginPayload(input: {
  readonly id: string;
  readonly version: string;
  readonly kind: string;
  readonly schema: string;
}): string {
  return JSON.stringify({
    id: input.id,
    kind: input.kind,
    schema: input.schema,
    version: input.version,
  });
}

/** Decide whether a manifest may be loaded. Crypto stays outside core. */
export function admitPlugin(input: {
  readonly manifest: unknown;
  readonly computedIntegrity: string;
  readonly signatureValid: boolean;
  readonly source: PluginSource;
  readonly allowUnsigned: boolean;
}): PluginAdmission {
  const parsed = pluginManifestSchema.safeParse(input.manifest);
  if (!parsed.success) {
    return { ok: false, reason: "invalid" };
  }
  const manifest = parsed.data;
  if (
    !sha256Schema.safeParse(input.computedIntegrity).success ||
    input.computedIntegrity !== manifest.integrity
  ) {
    return { ok: false, reason: "integrity_mismatch" };
  }
  if (manifest.signature !== undefined) {
    return input.signatureValid
      ? { ok: true, manifest }
      : { ok: false, reason: "bad_signature" };
  }
  if (input.source === "builtin" || input.allowUnsigned) {
    return { ok: true, manifest };
  }
  return { ok: false, reason: "unsigned" };
}
