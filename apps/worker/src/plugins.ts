import { sha256HexUtf8 } from "@tasb/adapter-cloudflare";
import {
  admitPlugin,
  canonicalPluginPayload,
  type Logger,
  type PluginManifest,
  type PluginSource,
} from "@tasb/core";

export interface PluginSlot<T> {
  readonly source: PluginSource;
  readonly manifest: unknown;
  readonly signatureValid?: boolean;
  readonly value: T;
}

/** Cloud ignores the opt-in. Self-host must set the flag to the exact string. */
export function allowUnsignedPlugins(env: {
  readonly DEPLOYMENT_MODE?: string;
  readonly ALLOW_UNSIGNED_PLUGINS?: string;
}): boolean {
  if (env.DEPLOYMENT_MODE === "cloud") {
    return false;
  }
  return env.ALLOW_UNSIGNED_PLUGINS === "true";
}

export async function selectAdmitted<T>(input: {
  readonly slots: readonly PluginSlot<T>[];
  readonly allowUnsigned: boolean;
  readonly logger: Logger;
}): Promise<T[]> {
  const admitted: T[] = [];
  for (const slot of input.slots) {
    const decision = admitPlugin({
      manifest: slot.manifest,
      computedIntegrity: await integrityFor(slot.manifest),
      signatureValid: slot.signatureValid === true,
      source: slot.source,
      allowUnsigned: input.allowUnsigned,
    });
    if (!decision.ok) {
      input.logger.warn("plugin_rejected", {
        id: manifestId(slot.manifest),
        reason: decision.reason,
        source: slot.source,
      });
      continue;
    }
    admitted.push(slot.value);
  }
  return admitted;
}

function manifest(input: {
  readonly id: string;
  readonly kind: PluginManifest["kind"];
  readonly integrity: string;
}): PluginManifest {
  return {
    id: input.id,
    version: "0.1.0",
    kind: input.kind,
    schema: input.id,
    integrity: input.integrity,
  };
}

export const builtinManifests = {
  keyword: manifest({
    id: "keyword",
    kind: "detector",
    integrity:
      "4d04d928caf2d35056eb1beed553a4ca12490469fdd51ac40ff729106ce9c413",
  }),
  join: manifest({
    id: "join",
    kind: "detector",
    integrity:
      "46bb1558bbe3410f6a6d226d42abfb0058517afbfc80df37c27b2e2f02ee5442",
  }),
  bot: manifest({
    id: "bot",
    kind: "detector",
    integrity:
      "9baddcf248aabed1cd0fabd714d080b8e16fda611ac23ca593c04766d59cb021",
  }),
  flood: manifest({
    id: "flood",
    kind: "detector",
    integrity:
      "63cc5bb6e20b08b85bd20d846c6cd9d7b10d947e7d1ec6d4f8041d7afb4b16f2",
  }),
  repeat: manifest({
    id: "repeat",
    kind: "detector",
    integrity:
      "108aa182a9ceb5b2ef1e1534b3c8f29756f1341f0014fbf3db3627fb4024d0bd",
  }),
  link: manifest({
    id: "link",
    kind: "detector",
    integrity:
      "ddfbf082b99326747a6ed08912d3e41386a39f467d56d66731807ebef5d343f2",
  }),
  blocklist: manifest({
    id: "blocklist",
    kind: "detector",
    integrity:
      "e74174a67153e0b60d1c8c647361f32b248ea9faa8744108c4d1d66503a37a3f",
  }),
  llm: manifest({
    id: "llm",
    kind: "detector",
    integrity:
      "5075ceed6b1156151821db7cf800d5954a3711ead005bf4fd3257ba21beab7c4",
  }),
  regex: manifest({
    id: "regex",
    kind: "detector",
    integrity:
      "e780b923abc15091f942b22050063a686ac27b82f4eda783d0db54070106231a",
  }),
  forward: manifest({
    id: "forward",
    kind: "detector",
    integrity:
      "bf956e266793601c8878d49d26724b3135f9c5a5e6e02ce9816fb1e33f9c548a",
  }),
  delete: manifest({
    id: "delete",
    kind: "action",
    integrity:
      "a1d04fcd334e99741928997fdd8e4f145f2b97fdb1b5d0072bb35ca4fc9ec296",
  }),
  mute: manifest({
    id: "mute",
    kind: "action",
    integrity:
      "02d8efaeedaf2e503d65ece77dd85f209aa7ac08933fac50b59a45cf3a1c7a30",
  }),
  ban: manifest({
    id: "ban",
    kind: "action",
    integrity:
      "4c4627812eb0ef8d47c85aee95cf8ac82d84a7562a541f8e026b896235ed9b28",
  }),
  captcha: manifest({
    id: "captcha",
    kind: "action",
    integrity:
      "691e59a13ec3cbbaa89067434789b6d25a59f3355badfee2d99c7f1ea6093008",
  }),
  log: manifest({
    id: "log",
    kind: "action",
    integrity:
      "49e97a90c8d3fc387d63d35e26691e58ee70a0da8a6e65340830adeb48609853",
  }),
  report: manifest({
    id: "report",
    kind: "action",
    integrity:
      "37571b39efd10deda3f3e2d285e96ddac357afd619dda4c123c1d59fab5672c3",
  }),
} as const;

async function integrityFor(value: unknown): Promise<string> {
  if (!isRecord(value)) {
    return "";
  }
  const id = value.id;
  const version = value.version;
  const kind = value.kind;
  const schema = value.schema;
  if (
    typeof id !== "string" ||
    typeof version !== "string" ||
    typeof kind !== "string" ||
    typeof schema !== "string" ||
    id.length > 64 ||
    version.length > 32 ||
    kind.length > 32 ||
    schema.length > 64
  ) {
    return "";
  }
  return sha256HexUtf8(canonicalPluginPayload({ id, version, kind, schema }));
}

function manifestId(value: unknown): string {
  if (
    isRecord(value) &&
    typeof value.id === "string" &&
    /^[a-z][a-z0-9_-]{0,63}$/.test(value.id)
  ) {
    return value.id;
  }
  return "invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
