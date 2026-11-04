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
  contact: manifest({
    id: "contact",
    kind: "detector",
    integrity:
      "5bc05838659d8b7f142fae02d205abf729a47bb919df6010c99efeb592c39eb0",
  }),
  via: manifest({
    id: "via",
    kind: "detector",
    integrity:
      "de06e29b2c25afc892cec1be2de5aa9bc1ea873b7057e2d213a9b7272cb3a8ae",
  }),
  folder: manifest({
    id: "folder",
    kind: "detector",
    integrity:
      "b531e68519f6ab24df90805a254ea47a9f5359156afe22ffa30d6bb3f9f8b8f3",
  }),
  notice: manifest({
    id: "notice",
    kind: "detector",
    integrity:
      "3172784edc1b4d909e8d700cdde26aaa2e6aa88f13b99963f447360040175bbc",
  }),
  mediaSticker: manifest({
    id: "media_sticker",
    kind: "detector",
    integrity:
      "d23fd176eb8bbdc576bdd43d4c6679f37c4096743782812e3c2f255db1178fe9",
  }),
  mediaAnimation: manifest({
    id: "media_animation",
    kind: "detector",
    integrity:
      "0acaa1bedc1eb08ea8a51f4d0181d684f7f2879c2e9cfde522940df792e265fe",
  }),
  mediaVoice: manifest({
    id: "media_voice",
    kind: "detector",
    integrity:
      "4a1c5b5c00048784ac2dbe1c8434d8961e498c55aefcdb668fa8d1876e6488e3",
  }),
  mediaVideoNote: manifest({
    id: "media_video_note",
    kind: "detector",
    integrity:
      "c6860d4617f9db87604591b832242cee80df57e02f4a5ebfcfdf2aaee1a6a976",
  }),
  mediaDice: manifest({
    id: "media_dice",
    kind: "detector",
    integrity:
      "24b8cc2782af84d0e6de6681c6978dd5da4e6bce37784f6e56926e691273e952",
  }),
  scriptArabic: manifest({
    id: "script_arabic",
    kind: "detector",
    integrity:
      "6e0a84b5e27ba838be78fc355c3d9eb372295b15e62d6df2e7b55ac7f60e9dac",
  }),
  scriptCyrillic: manifest({
    id: "script_cyrillic",
    kind: "detector",
    integrity:
      "fc1049b7bff5b34139423e4ebefbd6382c9ae36818435c7ba4d8185afc48ca2b",
  }),
  channelSender: manifest({
    id: "channel_sender",
    kind: "detector",
    integrity:
      "29b97f81bf78cce73fe9739a01a0ed62e63cb99fe25dc1ce71e635a810a19582",
  }),
  sharedStory: manifest({
    id: "shared_story",
    kind: "detector",
    integrity:
      "344e17ebdabfccc439c7efe8722a50f77255d76640876591619243dcb5e20afc",
  }),
  bareLocation: manifest({
    id: "bare_location",
    kind: "detector",
    integrity:
      "8e1e49f3e645e6775df242d1cd2e06598e7e14f71d8ba1eaf399ba43f77f8bab",
  }),
  giveawayCard: manifest({
    id: "giveaway_card",
    kind: "detector",
    integrity:
      "142eec32ad66c94f6a9fdfdb0e215d0e75628342c58fb018dd1814e186f8b627",
  }),
  callNotice: manifest({
    id: "call_notice",
    kind: "detector",
    integrity:
      "ff584613b911d4a090dbac38d2cac4e55f739e4e0c4c14489bcda8266898360a",
  }),
  chatTitle: manifest({
    id: "chat_title",
    kind: "detector",
    integrity:
      "9bc5712d252f45b6a2b9af1059a4d05b0836c603edc6f9b380a0897a4e1480bb",
  }),
  communityNotice: manifest({
    id: "community_notice",
    kind: "detector",
    integrity:
      "083f31c3c82a22cf5929dae8ae0ecbee867de73a54e7b636f45195d382710a72",
  }),
  sharedChat: manifest({
    id: "shared_chat",
    kind: "detector",
    integrity:
      "13d9077476ae09154e74f0bd23c5a0ca327919e2259c35626f715e91018d3ef5",
  }),
  chatPhoto: manifest({
    id: "chat_photo",
    kind: "detector",
    integrity:
      "5217c465c580e1629f8c7c10e5ad54d114209f1b2e5bb62279b1400e8c77c69c",
  }),
  chatBackground: manifest({
    id: "chat_background",
    kind: "detector",
    integrity:
      "a00c71d31da2e68833160157dee61947da5f57c64d802a7e844a9504007a498f",
  }),
  giftCard: manifest({
    id: "gift_card",
    kind: "detector",
    integrity:
      "55aa4b28c6a3a4c3cd82ff8bad6ad3f9922d6d525c35055fa54e51051ad95f62",
  }),
  pinNotice: manifest({
    id: "pin_notice",
    kind: "detector",
    integrity:
      "a91576cecd406d51d3eb6f2a9899723fc9cf21a3fcb88491695c4bb8f4a5de47",
  }),
  giveawayNotice: manifest({
    id: "giveaway_notice",
    kind: "detector",
    integrity:
      "1af610c1f245f260530adf57469ddace0031c68424294b214ce5423dacded8ae",
  }),
  chatBoost: manifest({
    id: "chat_boost",
    kind: "detector",
    integrity:
      "2ffbd3164b9d89243f2f73a7067ca4ff0b0c114de1ed3c414e6793dc3f2aa0fa",
  }),
  forumNotice: manifest({
    id: "forum_notice",
    kind: "detector",
    integrity:
      "798de1b35085277d740014a5c1d33668ebbaaa64faae7b8800f3640199d92b22",
  }),
  autoDeleteNotice: manifest({
    id: "autodelete_notice",
    kind: "detector",
    integrity:
      "f99bc4982c88c9bc70009e3323a3f340f74229275208e35959980cca072c7d43",
  }),
  priceNotice: manifest({
    id: "price_notice",
    kind: "detector",
    integrity:
      "1668d2175b31bc3d3f7ca060086d04fd99cef438a4f378ee783623e30606ad36",
  }),
  postNotice: manifest({
    id: "post_notice",
    kind: "detector",
    integrity:
      "933a7f29b640ee65aad9d1ee03c532fe194ee191853a214126b2ff4b07493756",
  }),
  checklistNotice: manifest({
    id: "checklist_notice",
    kind: "detector",
    integrity:
      "4c9709b19970ae3c61a32a5fced4e2302baaa9a9d5101a439bc5369d00d4b368",
  }),
  callInvite: manifest({
    id: "call_invite",
    kind: "detector",
    integrity:
      "27644136ec1eb14856f1df80efac073733d0009d060f33d22d687f757d26d2f3",
  }),
  ownerNotice: manifest({
    id: "owner_notice",
    kind: "detector",
    integrity:
      "82cd1c3edba3b7f18bb09f471d040a850eaecf3ecaa9241909c132ae994142ee",
  }),
  proximityNotice: manifest({
    id: "proximity_notice",
    kind: "detector",
    integrity:
      "be6fb7dce7790a79758cb6d46702c83710388246111337101d1498eecc1c16f4",
  }),
  pollNotice: manifest({
    id: "poll_notice",
    kind: "detector",
    integrity:
      "4e012e8af59d9b3deb9e8773e5265240ab8594a830c8f0719c58a3d2e19ee9ef",
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
  forwardHidden: manifest({
    id: "forward_hidden",
    kind: "detector",
    integrity:
      "5c083f460c1eec579cefdd98e1338f3cd33e7cca2a2c03a65403c85019dec867",
  }),
  forwardChat: manifest({
    id: "forward_chat",
    kind: "detector",
    integrity:
      "d9299b72658c7a0266fd36cf0a5f882292206c6d1b7728b2368b009eea931992",
  }),
  forwardUser: manifest({
    id: "forward_user",
    kind: "detector",
    integrity:
      "eb5b5bfb112ac45534dd3306a1570e349b1a2d0ff990e5467ae8c2cc19535a9b",
  }),
  delete: manifest({
    id: "delete",
    kind: "action",
    integrity:
      "a1d04fcd334e99741928997fdd8e4f145f2b97fdb1b5d0072bb35ca4fc9ec296",
  }),
  warn: manifest({
    id: "warn",
    kind: "action",
    integrity:
      "2c7a6d47eed6b66be2f2d2dc17f05495c46fe0e562492ce078e9a49bb0dd7201",
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
  decline: manifest({
    id: "decline",
    kind: "action",
    integrity:
      "8a1b9516e5b4f1f7cc2447e0f31a40202a388a322dc8255c1a4bb351ef37b80e",
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
