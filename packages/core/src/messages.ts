export const locales = ["zh", "en"] as const;
export type Locale = (typeof locales)[number];

export const messageKeys = [
  "command.denied",
  "command.invalid",
  "command.help",
  "command.rules.usage",
  "command.rules.header",
  "command.rules.pack",
  "command.rules.empty",
  "command.rules.line",
  "command.rules.paused",
  "command.rules.until",
  "command.rules.enabled",
  "command.rules.disabled",
  "command.rule.usage",
  "command.rule.status",
  "command.rule.missing",
  "command.rule.file",
  "command.rule.switch",
  "command.whitelist.usage",
  "command.whitelist.body",
  "command.allow.empty",
  "command.logs.usage",
  "command.logs.empty",
  "command.logs.line",
  "command.export.usage",
  "command.export.too_long",
  "command.forget.usage",
  "command.forget.deleted",
  "command.dryrun.usage",
  "command.dryrun.status",
  "command.switch.on",
  "command.switch.off",
  "command.redacted",
  "command.blocklist.usage",
  "command.blocklist.status",
  "command.blocklist.added",
  "command.appeal.usage",
  "command.appeal.missing",
  "command.appeal.queued",
  "command.appeal.false_positive",
  "command.appeal.confirmed",
  "command.evals.usage",
  "command.evals.too_long",
  "command.packs.usage",
  "command.packs.status",
  "command.quota.usage",
  "command.quota.disabled",
  "command.quota.status",
  "command.quota.basics",
  "command.quota.until",
  "command.quota.basic",
  "command.quota.full",
  "command.chats.usage",
  "command.chats.disabled",
  "command.chats.empty",
  "command.chats.body",
] as const;

export type MessageKey = (typeof messageKeys)[number];

const syntax = [
  "/help",
  "/rules [chatId]",
  "/rule [chatId] <ruleId> [on|off|reset]",
  "/whitelist <chatId>",
  "/whitelist <chatId> add <actorId>",
  "/whitelist <chatId> remove <actorId>",
  "/logs [chatId]",
  "/dryrun <chatId>",
  "/dryrun <chatId> on|off",
  "/export [chatId]",
  "/forget [chatId]",
  "/blocklist <chatId>",
  "/blocklist <chatId> on|off",
  "/blocklist <chatId> add actor <actorId>",
  "/blocklist <chatId> add hash <sha256>",
  "/appeal <chatId> <eventId> false|confirm",
  "/evals [chatId]",
  "/packs <chatId> [packId|off]",
  "/quota <chatId>",
  "/chats",
].join("\n");

const zh = {
  "command.denied": "没有权限",
  "command.invalid": "参数无效",
  "command.help": `命令：\n${syntax}`,
  "command.rules.usage": "用法：/rules [chatId]",
  "command.rules.header": "rules {chatId}",
  "command.rules.pack": "rules {chatId} {pack}",
  "command.rules.empty": "none",
  "command.rules.line":
    "{id} {state} {source} threshold {threshold} actions {actions}",
  "command.rules.paused": "paused",
  "command.rules.until": "{status} until {resetsAt}",
  "command.rules.enabled": "enabled",
  "command.rules.disabled": "disabled",
  "command.rule.usage": "用法：/rule [chatId] <ruleId> [on|off|reset]",
  "command.rule.status": "rule {chatId} {ruleId} {state} {source}",
  "command.rule.missing": "rule {id} missing",
  "command.rule.file": "file",
  "command.rule.switch": "switch",
  "command.whitelist.usage": "用法：/whitelist <chatId> [add|remove <actorId>]",
  "command.whitelist.body":
    "whitelist {chatId}\nexemptAdmins {exemptAdmins}\nallow {allow}",
  "command.allow.empty": "none",
  "command.logs.usage": "用法：/logs [chatId]",
  "command.logs.empty": "no audits",
  "command.logs.line":
    "{createdAt} {eventId} {action} score {score} rules {rules} reasons {reasons}",
  "command.export.usage": "用法：/export [chatId]",
  "command.export.too_long": "导出 {count} 条，超过私聊长度",
  "command.forget.usage": "用法：/forget [chatId]",
  "command.forget.deleted": "已删除 {count} 条",
  "command.dryrun.usage": "用法：/dryrun <chatId> [on|off]",
  "command.dryrun.status": "dry-run {chatId} {state}",
  "command.switch.on": "on",
  "command.switch.off": "off",
  "command.redacted": "redacted",
  "command.blocklist.usage":
    "用法：/blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
  "command.blocklist.status": "blocklist {chatId} {state}",
  "command.blocklist.added": "{status}\nadded",
  "command.appeal.usage": "用法：/appeal <chatId> <eventId> false|confirm",
  "command.appeal.missing": "没有这条审计",
  "command.appeal.queued": "appeal {chatId} {eventId} {label}",
  "command.appeal.false_positive": "误判",
  "command.appeal.confirmed": "确认",
  "command.evals.usage": "用法：/evals [chatId]",
  "command.evals.too_long": "评测样本 {count} 条，超过私聊长度",
  "command.packs.usage": "用法：/packs <chatId> [packId|off]",
  "command.packs.status": "packs {chatId} {pack}",
  "command.quota.usage": "用法：/quota <chatId>",
  "command.quota.disabled": "quota off",
  "command.quota.status": "quota {chatId} {used}/{limit} {period} {state}",
  "command.quota.basics": "{status}\n{basic}",
  "command.quota.until": "{status} until {resetsAt}",
  "command.quota.basic": "basic",
  "command.quota.full": "full",
  "command.chats.usage": "用法：/chats",
  "command.chats.disabled": "chats off",
  "command.chats.empty": "none",
  "command.chats.body": "chats\n{chats}",
} satisfies Record<MessageKey, string>;

const en = {
  "command.denied": "No permission",
  "command.invalid": "Invalid argument",
  "command.help": `Commands:\n${syntax}`,
  "command.rules.usage": "Usage: /rules [chatId]",
  "command.rules.header": "rules {chatId}",
  "command.rules.pack": "rules {chatId} {pack}",
  "command.rules.empty": "none",
  "command.rules.line":
    "{id} {state} {source} threshold {threshold} actions {actions}",
  "command.rules.paused": "paused",
  "command.rules.until": "{status} until {resetsAt}",
  "command.rules.enabled": "enabled",
  "command.rules.disabled": "disabled",
  "command.rule.usage": "Usage: /rule [chatId] <ruleId> [on|off|reset]",
  "command.rule.status": "rule {chatId} {ruleId} {state} {source}",
  "command.rule.missing": "rule {id} missing",
  "command.rule.file": "file",
  "command.rule.switch": "switch",
  "command.whitelist.usage":
    "Usage: /whitelist <chatId> [add|remove <actorId>]",
  "command.whitelist.body":
    "allowlist {chatId}\nexemptAdmins {exemptAdmins}\nallow {allow}",
  "command.allow.empty": "none",
  "command.logs.usage": "Usage: /logs [chatId]",
  "command.logs.empty": "No audits",
  "command.logs.line":
    "{createdAt} {eventId} {action} score {score} rules {rules} reasons {reasons}",
  "command.export.usage": "Usage: /export [chatId]",
  "command.export.too_long": "{count} rows, longer than a private message",
  "command.forget.usage": "Usage: /forget [chatId]",
  "command.forget.deleted": "Deleted {count}",
  "command.dryrun.usage": "Usage: /dryrun <chatId> [on|off]",
  "command.dryrun.status": "Dry-run {chatId} is {state}",
  "command.switch.on": "on",
  "command.switch.off": "off",
  "command.redacted": "redacted",
  "command.blocklist.usage":
    "Usage: /blocklist <chatId> [on|off|add actor <id>|add hash <sha256>]",
  "command.blocklist.status": "Blocklist {chatId} is {state}",
  "command.blocklist.added": "{status}\nAdded",
  "command.appeal.usage": "Usage: /appeal <chatId> <eventId> false|confirm",
  "command.appeal.missing": "No audit",
  "command.appeal.queued": "Appeal {chatId} {eventId} {label}",
  "command.appeal.false_positive": "False positive",
  "command.appeal.confirmed": "Confirmed",
  "command.evals.usage": "Usage: /evals [chatId]",
  "command.evals.too_long": "{count} cases, longer than a private message",
  "command.packs.usage": "Usage: /packs <chatId> [packId|off]",
  "command.packs.status": "Pack {chatId} {pack}",
  "command.quota.usage": "Usage: /quota <chatId>",
  "command.quota.disabled": "Quota off",
  "command.quota.status": "Quota {chatId} {used}/{limit} {period} {state}",
  "command.quota.basics": "{status}\n{basic}",
  "command.quota.until": "{status} until {resetsAt}",
  "command.quota.basic": "basic",
  "command.quota.full": "full",
  "command.chats.usage": "Usage: /chats",
  "command.chats.disabled": "Chats off",
  "command.chats.empty": "none",
  "command.chats.body": "chats\n{chats}",
} satisfies Record<MessageKey, string>;

const catalogs: Record<Locale, Record<MessageKey, string>> = { zh, en };

export function translate(
  locale: string,
  key: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const catalog = isLocale(locale) ? catalogs[locale] : catalogs.zh;
  const template = catalog[key as MessageKey];
  if (typeof template !== "string") {
    return key;
  }
  return fill(template, vars);
}

function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

function fill(
  template: string,
  vars: Readonly<Record<string, string | number>> | undefined,
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = vars?.[name];
    if (value === undefined) {
      return match;
    }
    return String(value);
  });
}
