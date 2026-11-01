import { sha256HexUtf8 } from "@tasb/adapter-cloudflare";
import { canonicalPluginPayload, createMemoryLogger } from "@tasb/core";
import { describe, expect, it } from "vitest";
import {
  allowUnsignedPlugins,
  builtinManifests,
  selectAdmitted,
} from "./plugins.js";

const phrase = "请免费领取礼品";

describe("allowUnsignedPlugins", () => {
  it("stays off for the public bot even when the flag is set", () => {
    expect(
      allowUnsignedPlugins({
        DEPLOYMENT_MODE: "cloud",
        ALLOW_UNSIGNED_PLUGINS: "true",
      }),
    ).toBe(false);
    expect(allowUnsignedPlugins({ DEPLOYMENT_MODE: "self-host" })).toBe(false);
    expect(
      allowUnsignedPlugins({
        DEPLOYMENT_MODE: "self-host",
        ALLOW_UNSIGNED_PLUGINS: "yes",
      }),
    ).toBe(false);
    expect(
      allowUnsignedPlugins({
        DEPLOYMENT_MODE: "self-host",
        ALLOW_UNSIGNED_PLUGINS: "true",
      }),
    ).toBe(true);
  });
});

describe("selectAdmitted", () => {
  it("keeps builtin manifests and drops a tampered external one", async () => {
    const logger = createMemoryLogger();
    const kept = await selectAdmitted({
      slots: [
        {
          source: "builtin",
          manifest: builtinManifests.keyword,
          value: "keyword",
        },
      ],
      allowUnsigned: false,
      logger,
    });
    expect(kept).toEqual(["keyword"]);
    const digest = await sha256HexUtf8(
      canonicalPluginPayload({
        id: "keyword",
        version: "0.1.0",
        kind: "detector",
        schema: "keyword",
      }),
    );
    expect(digest).toBe(builtinManifests.keyword.integrity);
    const dropped = await selectAdmitted({
      slots: [
        {
          source: "external",
          manifest: {
            id: "extra",
            version: "0.1.0",
            kind: "detector",
            schema: "extra",
            integrity: digest,
            text: phrase,
          },
          value: "extra",
        },
      ],
      allowUnsigned: true,
      logger,
    });
    expect(dropped).toEqual([]);
    expect(JSON.stringify(logger.entries)).not.toContain(phrase);
    expect(
      logger.entries.some((entry) => entry.message === "plugin_rejected"),
    ).toBe(true);
  });
});
