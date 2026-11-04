# 插件

步骤以 `AGENTS.md` 为准。这里只放最小形状。

检测器：

```ts
import { defineDetector } from "@tasb/core";
import { z } from "zod";

const configSchema = z.strictObject({
  keywords: z.array(z.string().min(1)).min(1),
});

export function createKeywordDetector(config: z.input<typeof configSchema>) {
  return defineDetector({
    id: "keyword",
    version: "0.1.0",
    capabilities: ["text"],
    configSchema,
    config,
    async detect(ctx, parsed) {
      const text = ctx.event.message?.text;
      if (!text) return null;
      const hit = parsed.keywords.some((word) => text.includes(word));
      if (!hit) return null;
      return {
        detectorId: "keyword",
        score: 1,
        reasons: ["keyword_match"],
        evidence: [{ kind: "keyword", summary: "keyword:configured" }],
      };
    },
  });
}
```

动作只调用 `ctx.moderator`，或者 core 已经导出的领域函数。dry-run 返回 `{ status: "skipped", detail: "dry_run" }`。缺消息或 actor 时返回 `failed`，不要抛给流水线。mute 带 `durationSeconds`，ban 不顺带删除。见 ADR 0004。Telegram 适配器在有 token 时把这三步各发成一次 Bot API 请求。失败由流水线记成 `action_failed`，不把响应正文写进日志。见 ADR 0020。同一条事件先占住审计再调用动作。已经有记录就不再调用。见 ADR 0335 和 ADR 0336。不足 30 秒或超过 366 天的限制先收到这个区间，避免被当成永久限制。见 ADR 0354。付费帖不删除。见 ADR 0356。

`log` 只写标识、分数和 reason。`report` 把同一份通知交给 `Notifier`。没有通知端口时返回 `report_unavailable`。见 ADR 0021。

`captcha` 只处理 `kind: "chat_member"` 且 `membership: "join"` 的事件。它调用 `beginChallenge`：先写入挑战，再 `restrictActor`。限制失败就删掉挑战并返回 `failed` / `captcha_unavailable`。结果里不要放 nonce。按钮文案和 `restrictChatMember` 留在 `platform-telegram`。没配 `DB` 时挑战留在内存，配了写入 D1。同一份 nonce 只有第一次取走时解除限制并写入 `captcha_passed`。到期清理也只取走这份 nonce。同一条入群再投递时，挑战还在就再发一次按钮；这次发送失败不解除限制。记下按钮的 message id 后，通过、到期、再发一颗或再次入群换掉挑战时删掉旧提示。成员离群或被移出时删掉还在的按钮；被限制时不删。入群改成封禁、禁言或删除时，也删掉上一颗。记不上 id 就删掉刚发出的按钮。点到另一颗也删。别人点了不删。别人的活按钮也不删。被升为管理员时删掉还在的按钮，不解除限制。提前解除且还没到期时也删。通过时把每一项权限都打开。限制时把反应和标签也关上。不足 30 秒或超过 366 天时先收到这个区间。状态仍是 `restricted`、`is_member` 为 false 时也删。回到群里重新验证。见 ADR 0009、ADR 0051、ADR 0340、ADR 0341、ADR 0342、ADR 0343、ADR 0344、ADR 0345、ADR 0346、ADR 0347、ADR 0348、ADR 0349、ADR 0350、ADR 0351、ADR 0352、ADR 0353、ADR 0354 和 ADR 0355。

入群检测器在 `packages/detectors-join`，`membership !== "join"` 时返回 null，并带 fixtures。`decline` 只处理 `kind: "join_request"`。带安全查询号时调用 `answerChatJoinRequestQuery`，结果是 `decline`；没有查询号时仍调用 `declineChatJoinRequest`。没有命中时，带查询号的申请答复 `queue`，其余仍留给管理员。见 ADR 0116 和 ADR 0360。默认规则 `join_link` 用现有链接检测器看入群昵称。短链或邀请就封禁，普通网址仍只验证。见 ADR 0117。

洪泛和重复在 `packages/detectors-rate`。两者共用一个 `RateWindow`。默认实现是内存，最多 256 个 key。放不下时 `observe` 返回 `null`，检测器返回未命中并记 `rate_window_skipped`。不要把原文或文件 id 放进 key。有正文时重复检测用 `textSha256`。没有正文但有 `mediaSha256` 时用这份摘要。两者都没有则跳过。配了 `RATE_WINDOW` 之后按群放进 Durable Object，调用失败记 `rate_window_failed` 并放过。提交的配置不绑定它。同一条事件 id 在这个 key 最近 32 次计数里只计一次。见 ADR 0010、ADR 0050、ADR 0052、ADR 0338 和 `docs/limits.md` 的 KV、Durable Objects 两节。

链接检测在 `packages/detectors-link`。默认只认短链域名、denylist 和 IPv4 主机。`ReputationSource` 不传就不会发请求。本地已命中时也不调用它。超时或抛错记 `reputation_failed`，返回 null。证据里只留主机名。抽主机名之前的折叠，以及每种字段怎么留下主机名，见 [message-surface.md](message-surface.md)。`tg://join?invite=` 和 `tg://addlist?slug=` 记成 `t.me` 邀请。`tg://resolve` 仍当公开用户名。邀请码不进证据。见 ADR 0102。

跨群黑名单在 `packages/detectors-blocklist`。`BlocklistStore` 先看这个群有没有打开。没打开就返回 null，并且不调用 `has`。打开后只匹配 actor id 或 `textSha256`。原文、带空格的句子、以及不是 64 位小写十六进制的值都不能写入。存储抛错记 `blocklist_failed`，返回 null。配了 `POLICY_KV` 时，开关和条目在变化时写入这份 KV。`remove` 删一条标识，不存在时不写。状态行带上这个租户的条目数，不列出标识。见 ADR 0012、ADR 0047、ADR 0048、ADR 0049 和 `docs/limits.md`。

适配器实现 `Storage`、`Cache`、`PolicyStore` 或 `ModerationPort`。不要把 D1、KV 或 Telegram 的类型 re-export 到 core 能 import 的位置。`RuleSource` 只返回未校验文档，schema 和缓存由 `loadRuleSet` 负责。`PolicyStore` 的实现要调用 `@tasb/core/testing` 的 `bindPolicyStoreContract`，和内存适配器、KV 适配器跑同一组行为。`Storage` 的实现要调用 `bindStorageContract`。`listAudits` 返回最近的一页，页内按时间从早到晚。`countAudits` 返回范围内的条数。`exportAudits` 返回这些审计。私聊放不下时用一次列表取最近一页，一条也放不下才只回复条数。`deleteAudits` 按页删除这些审计并返回这次删掉的条数。D1 每页 1000 行，最多 32 页。删不完时 `/forget` 再数剩余。见 ADR 0361。`putAuditsIfAbsent` 按主键补上还没有的审计。`CaptchaStore.deleteMany` 一次删掉多条挑战。D1 把这两次调用各打成一批。导出 JSON 再过一遍审计 schema，不能带原文键。`put` 用 `prefilterPolicySchema` 拒绝空 id、超过 128 字符的 id，以及超过 200 个 id。读到无法通过 schema 的文档时返回 null，不要把文档写进日志。

私聊命令的句子在 `packages/core` 的消息目录里，键是 `command.*`。`translate` 在未知语言时用中文，缺键时返回 key，不抛错。新增一句回复要同时写 `zh` 和 `en`。见 ADR 0013。

`/appeal` 读 `Storage.getAudit`，再用 `buildReviewSample` 写入 `ReviewQueue`。样本只有哈希、动作、分数、reason 和规则 id。证据摘要不复制。队列满 256 条或存储抛错时回复「参数无效」，日志是 `operator_rejected`。见 ADR 0014。

`/unban <chatId> <actorId>` 调用 `unbanActor`。配了 token 时使用 `unbanChatMember`，并且 `only_if_banned` 为 true。没有端口或调用失败时回复「参数无效」。不改黑名单，也不解除禁言。见 ADR 0362。

`/unmute <chatId> <actorId>` 先调用 `getChatMember`。状态是 `restricted` 时把每一项权限打开，不带 `until_date`。其它状态回复没有禁言，不再调用 `restrictChatMember`。没有 token 或调用失败时回复「参数无效」。见 ADR 0363。

`/ban <chatId> <actorId>` 调用 `banActor`。配了 token 时使用 `banChatMember`，`revoke_messages` 为 false，不带 `until_date`。没有 token 或调用失败时回复「参数无效」，不把内存里的记录当成已经封禁。不改黑名单，也不解除禁言。见 ADR 0364。

`/mute <chatId> <actorId> [seconds]` 调用 `muteActor`。不写秒数时用 3600。写出的秒数要是 30 到 366 天里的整数。配了 token 时仍把每一项权限关掉，并带上 `until_date`。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经禁言。见 ADR 0365。

`/member <chatId> <actorId>` 调用 `readMember`。配了 token 时使用 `getChatMember`。回复只含状态，以及封禁或禁言的到期时间。`until_date` 为 0 时不写到期。普通成员的订阅到期、姓名和标签不进回复。没有 token 或调用失败时回复「参数无效」。见 ADR 0366。

`/delete <chatId> <messageId>` 调用 `deleteMessage`，不带 `audienceId`。配了 token 时使用 `deleteMessage`，不调用 `deleteEphemeralMessage`。消息号要是没有前导零的正安全整数。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经删除。不改黑名单、封禁或禁言。见 ADR 0367。

`/deletes <chatId> <messageId> [messageId...]` 调用 `deleteMessages`。配了 token 时一次提交 1 到 100 个消息号。找不到的会跳过。没有 token、重复、超过 100 条或调用失败时回复「参数无效」，不把内存记录当成已经删除。不改黑名单、封禁或禁言。见 ADR 0374。

`/decline <chatId> <actorId>` 调用 `declineJoin`，不带查询号。配了 token 时使用 `declineChatJoinRequest`。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经拒绝。不改黑名单、封禁或禁言。见 ADR 0368。

`/approve <chatId> <actorId>` 调用 `approveJoin`，不带查询号。配了 token 时使用 `approveChatJoinRequest`。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经批准。不改黑名单、封禁或禁言。见 ADR 0369。

`/bansender <chatId> <senderChatId>` 调用 `banSenderChat`。配了 token 时使用 `banChatSenderChat`，不调用 `banChatMember`。直到解除，该频道主人不能再以名下任何频道代发。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经禁止。不改黑名单、用户封禁或禁言。见 ADR 0370。

`/unbansender <chatId> <senderChatId>` 调用 `unbanSenderChat`。配了 token 时使用 `unbanChatSenderChat`，不调用 `unbanChatMember`。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经解除。不改黑名单、用户封禁或禁言。见 ADR 0371。

`/lock <chatId>` 调用 `lockChat`。配了 token 时使用 `setChatPermissions`，十六项权限都是 false，并带上 `use_independent_chat_permissions`。不带成员号，也不带到期时间。管理员仍可发言。此状态保持到重新设置权限。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经关闭。不改黑名单、用户封禁或禁言。见 ADR 0372。

`/unlock <chatId>` 调用 `unlockChat`。配了 token 时使用 `setChatPermissions`，十六项权限都是 true，并带上 `use_independent_chat_permissions`。不带成员号，也不带到期时间。这可能比锁定前更宽。单人禁言仍在。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经打开。不改黑名单、用户封禁或禁言。见 ADR 0373。

`/perms <chatId>` 调用 `readPermissions`。配了 token 时使用 `getChat`，只回报默认的十六项权限。缺省的反应、标签和话题按官方默认补上。群标题、简介和邀请链接不进回复。没有 token 或调用失败时回复「参数无效」。不改黑名单、封禁或禁言。见 ADR 0375。

`/clearreact <chatId> <actorId>` 调用 `clearReactions`。配了 token 时使用 `deleteAllMessageReactions`。正数 id 走 `user_id`，负数 id 走 `actor_chat_id`。一次最多清最近一万条。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经清除。不删消息，也不改黑名单、封禁或禁言。见 ADR 0376。

`/revoke <chatId> <inviteLink>` 调用 `revokeInvite`。配了 token 时使用 `revokeChatInviteLink`。只接受 `t.me`、`telegram.me`、`telegram.dog` 上的 `+` 或 `joinchat` 邀请。回复不带链接。别人创建的链接撤不掉。主链接被撤后，新的主链接也不在回复里。没有 token、链接不像邀请，或调用失败时回复「参数无效」，不把内存记录当成已经撤销。内存记录不保存链接。不改黑名单、封禁或禁言。见 ADR 0377。

`/unpin <chatId>` 调用 `unpinChat`。配了 token 时使用 `unpinAllChatMessages`，只带群号。消息还在。话题里的置顶不在这次里。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经撤下。不删消息，也不改黑名单、封禁或禁言。见 ADR 0378。

`/admins <chatId>` 调用 `readAdministrators`。配了 token 时使用 `getChatAdministrators`，并带上 `return_bots`。回复只有编号、是否机器人、创建者或管理员、匿名，以及标成 true 的权限。姓名、用户名和自定义头衔不进回复。创建者不展开权限。放不下时保留前面的若干人并写上剩下的个数。没有 token 或调用失败时回复「参数无效」。不改黑名单、封禁或禁言。见 ADR 0379。

`/untopic <chatId> [threadId]` 调用 `unpinTopic`。不带话题号时使用 `unpinAllGeneralForumTopicMessages`。带上话题号时使用 `unpinAllForumTopicMessages`，并只带这个话题号。消息还在。没有 token、话题号不合法或调用失败时回复「参数无效」，不把内存记录当成已经撤下。不调用 `unpinAllChatMessages`，也不改黑名单、封禁或禁言。见 ADR 0380。

`/closetopic <chatId> [threadId]` 调用 `closeTopic`。不带话题号时使用 `closeGeneralForumTopic`。带上话题号时使用 `closeForumTopic`，并只带这个话题号。话题号 `1` 不改写成通用话题。消息还在。没有 token、话题号不合法或调用失败时回复「参数无效」，不把内存记录当成已经关闭。不调用 `hideGeneralForumTopic` 或 `deleteForumTopic`，也不改黑名单、封禁或禁言。见 ADR 0381。

`/opentopic <chatId> [threadId]` 调用 `openTopic`。不带话题号时使用 `reopenGeneralForumTopic`。带上话题号时使用 `reopenForumTopic`，并只带这个话题号。话题号 `1` 不改写成通用话题。原先隐藏的通用话题会重新显示。消息还在。没有 token、话题号不合法或调用失败时回复「参数无效」，不把内存记录当成已经打开。不调用 `unhideGeneralForumTopic`，也不改黑名单、封禁或禁言。见 ADR 0382。

`/hidegeneral <chatId>` 调用 `hideGeneral`。配了 token 时使用 `hideGeneralForumTopic`，只带群号。原先开着的通用话题会一起关闭。消息还在。其它话题不在这次里。多出来的参数不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经隐藏。不调用 `closeGeneralForumTopic`，也不改黑名单、封禁或禁言。见 ADR 0383。

`/showgeneral <chatId>` 调用 `showGeneral`。配了 token 时使用 `unhideGeneralForumTopic`，只带群号。原先关着的通用话题仍然关着。消息还在。其它话题不在这次里。多出来的参数不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经显示。不调用 `reopenGeneralForumTopic`，也不改黑名单、封禁或禁言。见 ADR 0384。

`/deltopic <chatId> <threadId>` 调用 `deleteTopic`。配了 token 时使用 `deleteForumTopic`，带上这个话题号。话题号 `1` 原样送出。这个话题和里面的消息在这次里。其它话题不在这次里。少一个参数不发出请求。没有 token、话题号不合法或调用失败时回复「参数无效」，不把内存记录当成已经删除。不调用 `deleteMessages`，也不改黑名单、封禁或禁言。见 ADR 0385。

`/count <chatId>` 调用 `readMemberCount`。配了 token 时使用 `getChatMemberCount`，只带群号。回复只有人数。0 也是人数。标题、邀请链接和简介不进回复。多出来的参数不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不编一个数字。不改黑名单、封禁或禁言。见 ADR 0386。

`/pin <chatId> <messageId>` 调用 `pinMessage`。配了 token 时使用 `pinChatMessage`，带上这个消息号。消息号 `1` 原样送出。不传静音参数，所以群里可能收到通知，频道和私聊不会。消息还在。其它置顶还在。少一个参数不发出请求。没有 token、消息号不合法或调用失败时回复「参数无效」，不把内存记录当成已经置顶。不调用 `unpinAllChatMessages` 或 `deleteMessage`，也不改黑名单、封禁或禁言。见 ADR 0387。

`/unpinmsg <chatId> <messageId>` 调用 `unpinMessage`。配了 token 时使用 `unpinChatMessage`，带上这个消息号。消息号 `1` 原样送出。不带消息号时不发出请求，也不会撤下最近的一条。消息还在。其它置顶还在。少一个参数不发出请求。没有 token、消息号不合法或调用失败时回复「参数无效」，不把内存记录当成已经撤下。不调用 `unpinAllChatMessages` 或 `deleteMessage`，也不改黑名单、封禁或禁言。见 ADR 0388。

`/unreact <chatId> <messageId> <actorId>` 调用 `removeReaction`。配了 token 时使用 `deleteMessageReaction`。正数编号带 `user_id`，负数编号带 `actor_chat_id`。不传表情。别人的反应还在。其它消息上的反应还在。少一个参数不发出请求。没有 token、消息号不合法或调用失败时回复「参数无效」，不把内存记录当成已经撤下。不调用 `deleteAllMessageReactions`，也不改黑名单、封禁或禁言。见 ADR 0389。

`/delphoto <chatId>` 调用 `deletePhoto`。配了 token 时使用 `deleteChatPhoto`，只带群号。标题和简介还在。不上传新头像，也不读文件号。多出来的参数不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经删除。不调用 `setChatPhoto`，也不改黑名单、封禁或禁言。见 ADR 0390。

`/leave <chatId>` 调用 `leaveChat`。配了 token 时使用 `leaveChat`，只带群号。之后这个 bot 不再处理这个聊天。消息还在。多出来的参数不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经退出。不调用 `getChat`，也不改黑名单、封禁或禁言。见 ADR 0391。

`/tag <chatId> <userId> [tag]` 调用 `setMemberTag`。配了 token 时使用 `setChatMemberTag`，始终带上 `tag`。不写标签时送出空字符串，长度 0 到 16。回复不重复标签，名字还在。少一个编号不发出请求。超过 16 个字符不发出请求。没有 token、编号不合法或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getChatMember`，也不改黑名单、封禁或禁言。见 ADR 0392。

`/delstickers <chatId>` 调用 `deleteStickerSet`。配了 token 时使用 `deleteChatStickerSet`，只带群号。消息还在。多出来的参数不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经删除。不调用 `setChatStickerSet` 或 `getChat`，也不改黑名单、封禁或禁言。见 ADR 0393。

`/boosts <chatId> <userId>` 调用 `readBoostCount`。配了 token 时使用 `getUserChatBoosts`，带群号和成员号。回复只有助推次数。0 也是次数。名字、助推号和到期时间不进回复。少一个编号不发出请求。没有 token、编号不合法或调用失败时回复「参数无效」，不编一个数字。不改黑名单、封禁或禁言。见 ADR 0394。

`/react <chatId> <messageId> <emoji>` 调用 `setReaction`。配了 token 时使用 `setMessageReaction`，只送名单里的一个表情。不送 `is_big`，也不送自定义或付费反应。别人的反应还在。一组媒体会落到还在的第一条。少一个参数、变体选择符或名单外的表情都不发出请求。没有 token、消息号不合法或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `deleteMessageReaction`，也不改黑名单、封禁或禁言。见 ADR 0395。

`/title <chatId> <title>` 调用 `setTitle`。配了 token 时使用 `setChatTitle`，带群号和 1 到 128 个字符的标题。回复不重复标题，简介和头像还在。不写标题或超过 128 个字符都不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经修改。不调用 `setChatDescription` 或 `getChat`，也不改黑名单、封禁或禁言。见 ADR 0396。

`/desc <chatId> [description]` 调用 `setDescription`。配了 token 时使用 `setChatDescription`，始终带上 `description`。不写简介时送出空字符串，长度 0 到 255。回复不重复简介，标题和头像还在。不写群号或超过 255 个字符都不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经修改。不调用 `setChatTitle` 或 `getChat`，也不改黑名单、封禁或禁言。见 ADR 0397。

`/newtopic <chatId> <name>` 调用 `createTopic`。配了 token 时使用 `createForumTopic`，只带群号和 1 到 128 个字符的名字。回复只有新话题号。名字、图标颜色和自定义表情不进回复。不写名字或超过 128 个字符都不发出请求。没有 `message_thread_id` 时回复「参数无效」，不编一个话题号。没有 token、群号不合法或调用失败时同样回复「参数无效」。不调用 `editForumTopic` 或 `getForumTopicIconStickers`，也不改黑名单、封禁或禁言。见 ADR 0398。

`/rentopic <chatId> <threadId> <name>` 调用 `renameTopic`。配了 token 时使用 `editForumTopic`，带群号、话题号和 1 到 128 个字符的名字。话题号 `1` 原样送出。不送自定义表情。空名字会保留原名，所以不写名字时不发出请求。回复不重复名字，消息还在，其它话题还在。超过 128 个字符或前导零的话题号不发出请求。没有 token、编号不合法或调用失败时回复「参数无效」，不把内存记录当成已经修改。不调用 `editGeneralForumTopic`，也不改黑名单、封禁或禁言。见 ADR 0399。

`/rengeneral <chatId> <name>` 调用 `renameGeneral`。配了 token 时使用 `editGeneralForumTopic`，只带群号和 1 到 128 个字符的名字。不送话题号。回复不重复名字，其它话题还在，消息还在。不写名字或超过 128 个字符都不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经修改。不调用 `editForumTopic` 或 `createForumTopic`，也不改黑名单、封禁或禁言。见 ADR 0400。

`/stickers <chatId> <name>` 调用 `setStickerSet`。配了 token 时使用 `setChatStickerSet`，带群号和贴纸包短名。短名是 1 到 64 个英文字母、数字和下划线，以字母开头，不能有连续下划线，并且以 `_by_` 加 bot 用户名结尾。回复不重复短名，消息还在。不合这个形状、多出来的参数或超过 64 个字符都不发出请求。没有 token、群号不合法或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `deleteChatStickerSet`、`getChat` 或 `getStickerSet`，也不改黑名单、封禁或禁言。见 ADR 0401。

`/admintitle <chatId> <userId> [title]` 调用 `setAdminTitle`。配了 token 时使用 `setChatAdministratorCustomTitle`，带群号、用户号和 `custom_title`。不写头衔时送出空字符串，长度 0 到 16。回复不重复头衔，权限还在。超过 16 个字符不发出请求。没有 token、编号不合法或调用失败时回复「参数无效」，不把内存记录当成已经设置。不在本地判断 emoji。不调用 `promoteChatMember`、`setChatMemberTag` 或 `getChat`，也不改黑名单、封禁或禁言。见 ADR 0402。

`/declinepost <chatId> <messageId> [comment]` 调用 `declinePost`。配了 token 时使用 `declineSuggestedPost`，带私聊号和消息号。不写说明时不送 `comment`。写出的说明按空白折叠后长度要落在 1 到 128。回复不重复说明，这条建议帖不会发出，其它建议帖还在。超过 128 个字符或前导零的消息号不发出请求。没有 token、编号不合法或调用失败时回复「参数无效」，不把内存记录当成已经拒绝。不调用 `approveSuggestedPost` 或 `declineChatJoinRequest`，也不改黑名单、封禁或禁言。见 ADR 0403。

`/delephemeral <chatId> <userId> <messageId>` 调用 `deleteMessage`，并带上 `audienceId`。配了 token 时适配器使用 `deleteEphemeralMessage`，带群号、接收者号和临时消息号。`/delete` 仍然不带 `audienceId`，也不调用 `deleteEphemeralMessage`。回复写明对方离线时可能收不到这次删除，其它消息还在。三个编号都要写全。前导零的消息号不发出请求。没有 token、编号不合法或调用失败时回复「参数无效」，不把内存记录当成已经删除。不改黑名单、封禁或禁言。见 ADR 0404。

`/myrights [channels] <clear|right...>` 调用 `setDefaultRights`。配了 token 时使用 `setMyDefaultAdministratorRights`。`channels` 才送 `for_channels`。`clear` 不送 `rights`，用来清掉默认值。写出的权限会把十八项全部送出，点名的是 true，其余是 false。回复不重复权限名。加入时仍可修改，已有群不受影响。只有配置里的管理员可以改。接入目录里的人即使管着群也不能改。没有 token、权限名不认识或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `promoteChatMember` 或 `getMyDefaultAdministratorRights`，也不改黑名单、封禁或禁言。见 ADR 0405。

`/botrights [channels]` 调用 `readDefaultRights`。配了 token 时使用 `getMyDefaultAdministratorRights`。`channels` 才送 `for_channels`。回复列出十八项，缺字段写未知，非布尔值回复「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份权限。不调用 `setMyDefaultAdministratorRights` 或 `promoteChatMember`。见 ADR 0406。

`/setcommands [private]` 调用 `setCommandMenu`。配了 token 时使用 `setMyCommands`，范围是 `all_private_chats`，不送 `language_code`。命令和说明来自固定目录，最多 100 条。回复不重复这份目录。群菜单不变。已有单独语言列表的人不受影响。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不送 `is_ephemeral`。不调用 `deleteMyCommands` 或 `getMyCommands`，也不改黑名单、封禁或禁言。见 ADR 0407。

`/commands [private]` 调用 `readCommandMenu`。配了 token 时使用 `getMyCommands`，范围是 `all_private_chats`，不送 `language_code`。回复列出命令、说明和临时标记。空列表写 0。缺 `is_ephemeral` 写未知。非布尔值、坏命令名或说明超长时整份回复是「参数无效」。放不下时保留前面的命令并写上剩下的个数。只有配置里的管理员可以看。没有 token 时不编一份菜单。不调用 `setMyCommands` 或 `deleteMyCommands`。见 ADR 0408。

`/delcommands [private]` 调用 `deleteCommandMenu`。配了 token 时使用 `deleteMyCommands`，范围是 `all_private_chats`，不送 `language_code`。清掉之后更高一层的菜单会显示出来。群菜单不变。已有单独语言列表的人不受影响。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经清掉。不调用 `setMyCommands` 或 `getMyCommands`，也不改黑名单、封禁或禁言。见 ADR 0409。

`/menubutton <commands|default>` 调用 `setMenuButton`。配了 token 时使用 `setChatMenuButton`。`commands` 送 `{ type: "commands" }`，`default` 送 `{ type: "default" }`。不送 `chat_id`，所以改的是默认按钮。某个私聊里单独设过的按钮不受影响。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不送 `web_app`。不调用 `getChatMenuButton`，也不改黑名单、封禁或禁言。见 ADR 0410。

`/button` 调用 `readMenuButton`。配了 token 时使用 `getChatMenuButton`，不送 `chat_id`，所以读的是默认按钮。`commands` 写命令，`default` 写默认，`web_app` 写应用。按钮文字和地址不进回复。别的类型整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一个状态。不调用 `setChatMenuButton`。见 ADR 0411。

`/botname [name]` 调用 `setBotName`。配了 token 时使用 `setMyName`。名字按空白折成一段，1 到 64 个字符才送出。不写名字时送空字符串，清掉默认名字。不送 `language_code`，所以已有单独语言名字的人不受影响。回复不重复名字。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getMyName`，也不改黑名单、封禁或禁言。见 ADR 0412。

`/myname` 调用 `readBotName`。配了 token 时使用 `getMyName`，不送 `language_code`，所以读的是默认名字。空名字写空。回复带上名字，日志不带。换行、超长或非字符串时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一个名字。不调用 `setMyName`。见 ADR 0413。

`/botdesc [description]` 调用 `setBotDescription`。配了 token 时使用 `setMyDescription`。简介按空白折成一段，1 到 512 个字符才送出。不写简介时送空字符串，清掉默认简介。不送 `language_code`，所以已有单独语言简介的人不受影响。回复不重复简介。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getMyDescription`，也不改黑名单、封禁或禁言。见 ADR 0414。

`/mydesc` 调用 `readBotDescription`。配了 token 时使用 `getMyDescription`，不送 `language_code`，所以读的是默认简介。空简介写空。回复带上简介，日志不带。换行、超长或非字符串时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份简介。不调用 `setMyDescription`。见 ADR 0415。

`/botshort [short]` 调用 `setBotShortDescription`。配了 token 时使用 `setMyShortDescription`。短简介按空白折成一段，1 到 120 个字符才送出。不写短简介时送空字符串，清掉默认短简介。不送 `language_code`，所以已有单独语言短简介的人不受影响。回复不重复短简介。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getMyShortDescription`，也不改黑名单、封禁或禁言。见 ADR 0416。

`/myshort` 调用 `readBotShortDescription`。配了 token 时使用 `getMyShortDescription`，不送 `language_code`，所以读的是默认短简介。空短简介写空。回复带上短简介，日志不带。换行、超长或非字符串时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份短简介。不调用 `setMyShortDescription`。见 ADR 0417。

`/who` 调用 `readBotIdentity`。配了 token 时使用 `getMe`，不带参数。回复写编号、用户名、能否入群，以及是否看得到全部群消息。缺用户名写空。缺开关写未知。名字和其它字段不进回复，也不进日志。用户名不合规则或不是 bot 时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份身份。不调用 `logOut` 或 `close`。见 ADR 0418。

`/hook` 调用 `readWebhook`。配了 token 时使用 `getWebhookInfo`，不带参数。回复写待投递条数、证书、连接上限和上次错误的 unix 秒。缺字段写未知。地址、IP、错误原文和 `allowed_updates` 不进回复，也不进日志。待投递不是非负整数、连接不在 1 到 100、或错误时间不是非负整数时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份状态。不调用 `setWebhook` 或 `deleteWebhook`。见 ADR 0419。

`/evals` 读 `ReviewQueue.list`，再用 `buildFeedbackCase` 收成评测样本。`confirmed` 是 `spam`，`false_positive` 是 `ham`。文档不带原文，也不能送回检测器重放。放不下全部样本时返回最近的一页，并写上省略条数。见 ADR 0016 和 ADR 0330。形状在 `evals/cases/feedback.json`。

`llm` 检测器在 `packages/detectors-llm`。没有 `LlmClassifier` 时返回 null。分类器抛错或超时记 `llm_failed`，也返回 null。证据只写 `llm:` 加标签。默认模型和使用方式见 ADR 0015。评测在 `evals/cases/llm.json`。

`regex` 检测器在 `packages/detectors-regex`。配置是 1 到 8 条模式，每条最多 64 个字符，只用 `u`。创建时拒绝嵌套量词、分组量词、反向引用和 `{`。比较前会去掉零宽字符、双向控制符、非常规空白、换行、变体选择符和点状间隔号，并把全角拉丁字母、七个西里尔字母和乌克兰语 `і` 收成拉丁字母，模式本身不改。一层百分号编码的间隔号先收成对应字符再去掉。第二层和句号 `。` 的编码保留。普通空格、句号 `。`、全角数字和西里尔 `т` 保留。`test` 抛错记 `regex_failed` 并返回 null。证据固定是 `regex:hit`，不写匹配片段，也不写模式。默认规则 `regex_hint` 是关闭的。见 ADR 0023、ADR 0054、ADR 0060、ADR 0064、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0098 和 ADR 0099。评测在 `evals/cases/regex.json`。

关键词检测同样先做这层折叠，再做包含判断。除了一层间隔号编码，百分号编码不在这一层解释。只由这些字符组成的关键词不会匹配所有消息。证据里的词也折叠。点状间隔号去掉。全角拉丁字母收成半角。七个西里尔字母和乌克兰语 `і` 收成拉丁字母。普通空格、句号 `。`、全角数字和西里尔 `т` 保留。一层百分号编码的间隔号先收成对应字符再去掉。第二层和句号 `。` 的编码保留。见 ADR 0054、ADR 0060、ADR 0064、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0098 和 ADR 0099。没有 `text` 和 `caption` 时，投票题干、抽奖奖品说明、清单标题、游戏标题、账单标题、场馆标题、文件名、音频标题、表演者、内联按钮文字或手动引用会先成为这段正文。几个按钮用一个普通空格分开。自动引用、被回复的原消息、选项、任务文字、说明、附加文字、地址、坐标、贴纸包名、文件 id、回复键盘和复制句子不进事件。见 ADR 0056、ADR 0057、ADR 0058、ADR 0059、ADR 0061、ADR 0062、ADR 0063 和 ADR 0092。没有更前面的正文时，作者签名整段成为正文。已有正文时签名不并进去。见 ADR 0101。没有更前面的正文时，成员标签也整段成为正文。已有正文或作者签名时，标签不并进去。见 ADR 0112。没有更前面的正文时，拒绝建议帖的说明也整段成为正文。已有正文时说明不并进去。嵌套的原帖不读。见 ADR 0113。

`forward` 检测器在 `packages/detectors-forward`。它只看 `message.forward`。Worker 默认只把 `channel` 当命中，证据是 `forward:channel`。用户、群和隐藏来源要改配置才会命中。见 ADR 0025。评测在 `evals/cases/forward.json`。

`aggregateMetrics` 读取 `pipeline_completed`、`pipeline_exempt`、检测器失败和存储失败日志。dry-run 不计入拦截率。`log` 和 `report` 计入动作，不计入拦截。结果里没有原文和昵称。见 ADR 0017。最小例子在 `examples/minimal-pipeline`。

规则包订阅走 `RuleSubscriptionStore`、`RulePackSource` 和 `RulePackArchive`。默认关闭。`/packs <chatId> off` 下一条消息就不再读规则包。刷新失败时保留上一份通过 schema 的 `RuleSet`。配了 `POLICY_KV` 时订阅指针和上一份通过 schema 的规则按群放进这份 KV。规则没变不写，超过 16384 个字符不写。私聊 `/rules` 列出这份解析结果，已订阅时标题带上 pack id，每一行标明 `file` 或 `switch`。放不下全部规则时列出前面的若干条，并写上剩下的条数。见 ADR 0333。超额之后，不在基础检测器里的规则加上 `paused`，标题末尾带上窗口结束时间。超额的 `/quota` 在下一行列出这些基础检测器 id，顺序与策略一致，默认名单仍是 ADR 0026。同一条事件 id 在该群最近 64 次计数里只计一次。见 ADR 0337。状态行末尾带窗口结束时间。见 ADR 0019、ADR 0037、ADR 0038、ADR 0039、ADR 0040、ADR 0041、ADR 0042、ADR 0043、ADR 0044、ADR 0046 和 `examples/operator-commands`。

插件清单含 `id`、`version`、`kind`、`schema`、`integrity`，外部包还可以有 `signature`。完整性是 canonical JSON 的 sha256。签名是同一段 JSON 的 HMAC-SHA256。内置清单可以不签名。外部清单没有有效签名时不会进入流水线，除非自部署把 `ALLOW_UNSIGNED_PLUGINS` 设为 `true`。`DEPLOYMENT_MODE=cloud` 时这个变量无效。坏签名在两种模式下都拒绝。见 ADR 0018 和 `examples/plugin-manifest`。

平台包把 Telegram `Update` 收成 `Event`。参考 `packages/platform-telegram` 和 `examples/telegram-webhook`。Webhook 失败时不要调用 `onEvent`。私聊管理命令见 `examples/operator-commands` 和 ADR 0006。`/logs` 一行放不下全部规则或原因时，保留前面的若干个并写上剩下的个数。见 ADR 0334。回复只通过 `ReplyPort` 发送，不要在 core 里调用 Bot API。

提交前：

```sh
pnpm boundaries
pnpm test
pnpm eval
```
