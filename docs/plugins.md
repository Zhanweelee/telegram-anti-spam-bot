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

动作只调用 `ctx.moderator`，或者 core 已经导出的领域函数。dry-run 返回 `{ status: "skipped", detail: "dry_run" }`。缺消息或 actor 时返回 `failed`，不要抛给流水线。mute 带 `durationSeconds`，ban 不顺带删除。见 ADR 0004。`warn` 删掉当前这条未付费消息并累计次数，满 3 次再封禁。次数和 `/warn` 共用。默认规则仍是 delete。见 ADR 0454。Telegram 适配器在有 token 时把这三步各发成一次 Bot API 请求。失败由流水线记成 `action_failed`，不把响应正文写进日志。见 ADR 0020。同一条事件先占住审计再调用动作。已经有记录就不再调用。见 ADR 0335 和 ADR 0336。不足 30 秒或超过 366 天的限制先收到这个区间，避免被当成永久限制。见 ADR 0354。付费帖不删除。见 ADR 0356。

`log` 只写标识、分数和 reason。`report` 把同一份通知交给 `Notifier`。没有通知端口时返回 `report_unavailable`。见 ADR 0021。

`captcha` 只处理 `kind: "chat_member"` 且 `membership: "join"` 的事件。它调用 `beginChallenge`：先写入挑战，再 `restrictActor`。限制失败就删掉挑战并返回 `failed` / `captcha_unavailable`。结果里不要放 nonce。按钮文案和 `restrictChatMember` 留在 `platform-telegram`。两颗按钮是 nonce 算出的得数。见 ADR 0455。没配 `DB` 时挑战留在内存，配了写入 D1。同一份 nonce 只有第一次取走时解除限制并写入 `captcha_passed`。到期清理也只取走这份 nonce。同一条入群再投递时，挑战还在就再发一次按钮；这次发送失败不解除限制。记下按钮的 message id 后，通过、到期、再发一颗或再次入群换掉挑战时删掉旧提示。成员离群或被移出时删掉还在的按钮；被限制时不删。入群改成封禁、禁言或删除时，也删掉上一颗。记不上 id 就删掉刚发出的按钮。点到另一颗也删。别人点了不删。别人的活按钮也不删。被升为管理员时删掉还在的按钮，不解除限制。提前解除且还没到期时也删。通过时把每一项权限都打开。限制时把反应和标签也关上。不足 30 秒或超过 366 天时先收到这个区间。状态仍是 `restricted`、`is_member` 为 false 时也删。回到群里重新验证。见 ADR 0009、ADR 0051、ADR 0340、ADR 0341、ADR 0342、ADR 0343、ADR 0344、ADR 0345、ADR 0346、ADR 0347、ADR 0348、ADR 0349、ADR 0350、ADR 0351、ADR 0352、ADR 0353、ADR 0354 和 ADR 0355。

入群检测器在 `packages/detectors-join`，`membership !== "join"` 时返回 null，并带 fixtures。`decline` 只处理 `kind: "join_request"`。带安全查询号时调用 `answerChatJoinRequestQuery`，结果是 `decline`；没有查询号时仍调用 `declineChatJoinRequest`。没有命中时，带查询号的申请答复 `queue`，其余仍留给管理员。见 ADR 0116 和 ADR 0360。默认规则 `join_link` 用现有链接检测器看入群昵称。短链或邀请就封禁，普通网址仍只验证。见 ADR 0117。

`regex` 同时看消息正文和 `profile`。证据仍是 `regex:hit`。`join_regex` 默认打开，名字或新标签命中就封禁。申请简介命中就拒绝。`regex_hint` 仍关闭。见 ADR 0532。

`service_name_regex` 默认打开。入群服务消息、视频聊天邀请、换群主和靠近提醒的可见名字命中同一份正则时删除。名字干净时这几行仍留下。见 ADR 0533。

`sender_tag_regex` 默认打开。正文旁边的成员标签命中同一份正则时删除。标签干净，或标签自己就是正文时，仍留下。见 ADR 0534。

`button_text_regex` 默认打开。正文旁边的内联按钮文字命中同一份正则时删除。按钮干净，或按钮自己就是正文时，仍留下。见 ADR 0535。

`author_signature_regex` 和 `mirror_signature_regex` 默认打开。正文旁边的作者签名，以及讨论组原帖来源上的签名，命中同一份正则时删除。签名干净，或签名自己就是正文时，仍留下。见 ADR 0536。

`poll_option_regex` 默认打开。投票选项命中同一份正则时删除。选项干净，或选项自己就是题干时，仍留下。见 ADR 0537。

投票选项上画出的添加者名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0577。

清单任务上画出的完成者名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0578。

已知用户和群的转发抬头只留主机名，仍走 `links`。频道标题和外部回复不读。见 ADR 0579。

公开中奖者的名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0580。

别的聊天代发时，标题只留主机名，仍走 `links`。本群自己的身份不读。见 ADR 0581。

退群的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0582。

助推的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0583。

改自动删除计时的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0584。

改价的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0585。

置顶的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0586。

建群的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0587。

开视频聊天的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0588。

关话题的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0589。

创建抽奖的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0590。

换头像的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0591。

改名的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0592。

换背景的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0593。

动社区的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0594。

交群的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0595。

拉进视频聊天的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0596。

靠近提醒上操作的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0597。

拉人进群的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0598。

送礼的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0599。

拒绝建议帖的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0600。

通过、失败、付款或退款建议帖的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0601。

勾完或取消勾完清单的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0602。

新加清单任务的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0603。

加选项或删选项的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0604。

新建或改名话题的人，名字只留主机名，仍走 `links`。名字里的关键词不命中。见 ADR 0605。

`checklist_task_regex` 默认打开。清单任务命中同一份正则时删除。任务干净，或任务自己就是标题时，仍留下。见 ADR 0538。

`media_name_regex` 默认打开。说明旁边的文件名或音频标题命中同一份正则时删除。名称干净，或名称自己就是正文时，仍留下。见 ADR 0539。

`performer_regex` 默认打开。标题旁边的音频表演者命中同一份正则时删除。表演者干净，或表演者自己就是正文时，仍留下。见 ADR 0540。

`game_text_regex` 和 `invoice_text_regex` 默认打开。游戏说明、附加文字和账单说明命中同一份正则时删除。说明干净，或说明自己就是正文时，仍留下。见 ADR 0541。

`venue_address_regex` 默认打开。地点地址命中同一份正则时删除。地址干净，或地址自己就是正文时，仍留下。见 ADR 0542。

`poll_explanation_regex` 默认打开。测验说明命中同一份正则时删除。说明干净，或说明自己就是正文时，仍留下。见 ADR 0543。

`poll_question_regex`、`prize_text_regex` 和 `checklist_title_regex` 默认打开。题干、奖品说明或清单标题命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0544。

`game_title_regex`、`invoice_title_regex` 和 `venue_title_regex` 默认打开。游戏、账单或场馆标题命中同一份正则时删除。标题干净，或自己就是正文时，仍留下。见 ADR 0545。

`web_app_button_regex` 默认打开。小程序按钮文字命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0546。

`quote_text_regex` 默认打开。手动引用命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0547。

`gift_text_regex` 默认打开。礼物附言命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0548。

`gift_label_regex` 默认打开。独特礼物的收藏名命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0549。

`topic_name_regex` 默认打开。论坛话题名命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0550。

`decline_comment_regex` 默认打开。拒绝建议帖的说明命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0551。

`added_text_regex` 默认打开。后加的投票选项或清单任务命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0552。

`hidden_name_regex` 默认打开。隐藏转发的显示名命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0553。

`member_name_regex` 默认打开。入群、邀请、换群主或靠近提醒的可见名字命中同一份正则时删除。这段干净，或自己就是正文时，仍按原来的服务消息规则。见 ADR 0554。

`shared_name_regex` 默认打开。分享来的用户名字命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0555。

`managed_name_regex` 默认打开。新建受管 bot 的可见名字命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0556。

`access_name_regex` 默认打开。允许发消息带上的小程序名字命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0557。

`game_file_regex` 默认打开。游戏动图文件名命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0558。

`audio_file_regex` 默认打开。音频文件名命中同一份正则时删除。这段干净，或自己就是名称时，仍留下。见 ADR 0559。

`paid_file_regex` 默认打开。后面的付费视频文件名命中同一份正则时删除。第一段干净，或自己就是名称时，仍留下。见 ADR 0560。

`rich_name_regex` 默认打开。富文本里的文件名、音频标题和表演者命中同一份正则时删除。这一截和正文相同时不重复。见 ADR 0561。

`poll_media_regex` 默认打开。投票媒体上的文件名、音频名和场馆名命中同一份正则时删除。这一截和正文相同时不重复。见 ADR 0562。

`poll_description_regex` 默认打开。投票描述命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0563。

`rich_text_regex` 默认打开。富文本里看得见的字命中同一份正则时删除。这段干净，或自己就是正文时，仍留下。见 ADR 0564。

`rich_button_regex` 默认打开。段落旁边的富文本按钮命中同一份正则时删除。没有段落时，这些字仍留在正文或富文本里。见 ADR 0565。

`later_name_regex` 默认打开。选中名称之后的文件名命中同一份正则时删除。这一段自己就是名称时，仍留下。见 ADR 0566。

`folder` 在 `packages/detectors-folder`。只在 `chat_member` 且 `folderInvite` 为 true 时返回 score 1。证据是 `folder:invite`。邀请链接不进事件。默认规则 `folder_join` 关闭。打开后封禁。见 ADR 0429。

`notice` 在 `packages/detectors-notice`。只在 `message.notice` 是 `join` 或 `leave` 时返回 score 1。证据是 `notice:join` 或 `notice:leave`。名字不进证据。默认规则 `service_notice` 关闭。打开后删除入群和退群提示。见 ADR 0467。

`media_sticker`、`media_animation`、`media_voice`、`media_video_note` 和 `media_dice` 在 `packages/detectors-media`。只在 `message.media` 正好是这一种时返回 score 1。证据是 `media:` 加类别。贴纸包名、文件名、点数和表情不进证据。五条规则默认关闭。私聊 `/rule` 打开后只删除这一种。见 ADR 0469。

`media_photo`、`media_video`、`media_document` 和 `media_audio` 也在 `packages/detectors-media`。只在 `message.media` 正好是这一种时返回 score 1。证据是 `media:` 加类别。文件号、文件名、类型和时长不进证据。四条规则默认关闭。私聊 `/rule` 打开后只删除这一种。见 ADR 0575。

`script_arabic` 和 `script_cyrillic` 在 `packages/detectors-script`。这种字母至少 4 个，并且多于其它字母时返回 score 1。证据是 `script:` 加文字。正文不进证据。两条规则默认关闭。私聊 `/rule` 打开后只删除这一种。见 ADR 0470。

`channel_sender` 在 `packages/detectors-sender`。只在 `message.asChannel` 为 true 时返回 score 1。证据是 `sender:channel`。频道号和标题不进证据。规则默认关闭。私聊 `/rule` 打开后删除别的频道代发。见 ADR 0471。

`shared_story` 在 `packages/detectors-story`。只在 `message.asStory` 为 true 时返回 score 1。证据是 `story:card`。发布者名字、用户名和故事编号不进证据。规则默认关闭。私聊 `/rule` 打开后删除转发来的故事卡片。见 ADR 0472。

`bare_location` 在 `packages/detectors-location`。只在 `message.asLocation` 为 true 时返回 score 1。证据是 `location:pin`。坐标不进证据。规则默认关闭。私聊 `/rule` 打开后删除只有坐标的位置消息。场馆消息不带这个标记。见 ADR 0473。

`giveaway_card` 在 `packages/detectors-giveaway`。只在 `message.asGiveaway` 为 true 时返回 score 1。证据是 `giveaway:card`。频道名字、中奖人数和中奖者姓名不进证据。规则默认关闭。私聊 `/rule` 打开后删除抽奖卡片和结束公告。投票不带这个标记。见 ADR 0474。

`call_notice` 在 `packages/detectors-call`。只在 `message.call` 是开始、结束或预约时返回 score 1。证据是 `call:` 加这一种。时长和开始时间不进证据。规则默认关闭。私聊 `/rule` 打开后删除视频聊天的开始、结束和预约。邀请名单不带这个标记。见 ADR 0475。

`chat_title` 在 `packages/detectors-title`。只在 `message.asTitle` 为 true 时返回 score 1。证据是 `title:rename`。新群名不进证据。规则默认关闭。私聊 `/rule` 打开后删除改名服务消息。换头像不带这个标记。见 ADR 0476。

`community_notice` 在 `packages/detectors-community`。`message.community` 是移入、加入或移出时返回 score 1。证据是 `community:` 加这一种。社区名字和社区 id 不进证据。规则默认关闭。私聊 `/rule` 打开后删除这三种服务消息。见 ADR 0477。

`shared_chat` 在 `packages/detectors-shared-chat`。只在 `message.asSharedChat` 为 true 时返回 score 1。证据是 `chat:shared`。标题、用户名和编号不进证据。规则默认关闭。私聊 `/rule` 打开后删除分享来的聊天。分享来的用户不带这个标记。见 ADR 0478。

`chat_photo` 在 `packages/detectors-photo`。`message.photo` 是换上或拿掉时返回 score 1。证据是 `photo:` 加这一种。文件号和尺寸不进证据。规则默认关闭。私聊 `/rule` 打开后删除这两种服务消息。见 ADR 0479。

`chat_background` 在 `packages/detectors-background`。`message.background` 是壁纸、图案、纯色或主题时返回 score 1。证据是 `background:` 加这一种。文件名、文件号和主题名不进证据。规则默认关闭。私聊 `/rule` 打开后删除换背景的服务消息。见 ADR 0480。

`gift_card` 在 `packages/detectors-gift`。`message.gift` 是普通礼物、独特礼物或升级购买时返回 score 1。证据是 `gift:` 加这一种。星星数量、编号和发布者名字不进证据。规则默认关闭。私聊 `/rule` 打开后删除这三种卡片。见 ADR 0481。

`pin_notice` 在 `packages/detectors-pin`。只在 `message.asPin` 为 true 时返回 score 1。证据是 `pin:notice`。被置顶的原文和消息号不进证据。规则默认关闭。私聊 `/rule` 打开后删除置顶提示。置顶本身还在。见 ADR 0482。

`giveaway_notice` 在 `packages/detectors-giveaway-notice`。`message.giveawayNotice` 是创建或私下结束时返回 score 1。证据是 `giveaway:` 加这一种。星星数量、中奖人数和奖品原文不进证据。规则默认关闭。私聊 `/rule` 打开后删除这两种公告。见 ADR 0483。

`chat_boost` 在 `packages/detectors-boost`。只在 `message.asBoost` 为 true 时返回 score 1。证据是 `boost:added`。次数和发送者名字不进证据。规则默认关闭。私聊 `/rule` 打开后删除助推提示。助推本身还在。见 ADR 0484。

`forum_notice` 在 `packages/detectors-forum`。`message.forumNotice` 是关掉、重开、隐藏或重新显示时返回 score 1。证据是 `forum:` 加这一种。话题名不进证据。规则默认关闭。私聊 `/rule` 打开后删除这四种提示。话题开关不变。见 ADR 0485。

`autodelete_notice` 在 `packages/detectors-autodelete`。只在 `message.asAutoDelete` 为 true 时返回 score 1。证据是 `autodelete:changed`。秒数不进证据。规则默认关闭。私聊 `/rule` 打开后删除改计时的提示。计时本身还在。见 ADR 0486。

`price_notice` 在 `packages/detectors-price`。`message.priceNotice` 是付费发言或私信改价时返回 score 1。证据是 `price:` 加这一种。星星数量不进证据。规则默认关闭。私聊 `/rule` 打开后删除这两种提示。价格和私信开关不变。见 ADR 0487。

`post_notice` 在 `packages/detectors-post`。`message.postNotice` 是通过、失败、付款或退款时返回 score 1。证据是 `post:` 加这一种。原帖和价格不进证据。规则默认关闭。私聊 `/rule` 打开后删除这四种提示。稿子状态不变。见 ADR 0488。

`checklist_notice` 在 `packages/detectors-checklist`。`message.checklistNotice` 是完成或取消完成时返回 score 1。证据是 `checklist:` 加这一种。任务号不进证据。规则默认关闭。私聊 `/rule` 打开后删除这两种提示。任务完成状态不变。见 ADR 0489。

`call_invite` 在 `packages/detectors-call-invite`。只在 `message.asCallInvite` 为 true 时返回 score 1。证据是 `invite:video`。用户编号不进证据。被邀请的名字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除邀请提示。开始、结束和预约仍由 `call_notice` 决定。见 ADR 0491。

`owner_notice` 在 `packages/detectors-owner`。`message.ownerNotice` 是换人或离开时返回 score 1。证据是 `owner:` 加这一种。用户编号不进证据。新群主的名字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这两种提示。群主身份不变。见 ADR 0492。

`proximity_notice` 在 `packages/detectors-proximity`。只在 `message.asProximity` 为 true 时返回 score 1。证据是 `proximity:near`。距离和用户编号不进证据。两个人的名字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除靠近提醒。纯坐标仍由 `bare_location` 决定。见 ADR 0493。

`poll_notice` 在 `packages/detectors-poll`。`message.pollNotice` 是后加或删除选项时返回 score 1。证据是 `poll:` 加这一种。选项编号和原投票不进证据。选项文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这两种提示。投票题干仍不带这个标记。见 ADR 0494。

`checklist_added` 在 `packages/detectors-task`。只在 `message.asChecklistAdded` 为 true 时返回 score 1。证据是 `checklist:added`。任务编号、完成者名字和原清单不进证据。任务文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种提示。完成和取消完成仍由 `checklist_notice` 决定。见 ADR 0495。

`topic_notice` 在 `packages/detectors-topic`。`message.topicNotice` 是新建或改名时返回 score 1。证据是 `topic:` 加这一种。图标颜色和自定义表情编号不进证据。话题名仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这两种提示。关掉和重开仍由 `forum_notice` 决定。见 ADR 0496。

`post_declined` 在 `packages/detectors-decline`。只在 `message.asPostDeclined` 为 true 时返回 score 1。证据是 `decline:post`。原帖不进证据。拒绝说明仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种提示。通过、失败、付款和退款仍由 `post_notice` 决定。见 ADR 0497。

`group_created` 在 `packages/detectors-created`。只在 `message.asGroupCreated` 为 true 时返回 score 1。证据是 `group:created`。发送者名字不进证据。规则默认关闭。私聊 `/rule` 打开后删除这种提示。入群和退群仍由 `service_notice` 决定。见 ADR 0498。

`post_pending` 在 `packages/detectors-pending`。只在 `message.asPostPending` 为 true 时返回 score 1。证据是 `post:pending`。价格和发表时间不进证据。正文仍是这条消息自己的文字。规则默认关闭。私聊 `/rule` 打开后删除这种正文。通过、失败、付款和退款仍由 `post_notice` 决定。拒绝仍由 `post_declined` 决定。见 ADR 0499。

`media_spoiler` 在 `packages/detectors-spoiler`。只在 `message.asSpoiler` 为 true 时返回 score 1。证据是 `media:spoiler`。文件号不进证据。说明仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种媒体。贴纸、动图、语音、视频留言和骰子仍由各自的规则决定。见 ADR 0500。

`message_effect` 在 `packages/detectors-effect`。只在 `message.asEffect` 为 true 时返回 score 1。证据是 `effect:message`。特效编号不进证据。正文仍是这条消息自己的文字。规则默认关闭。私聊 `/rule` 打开后删除这种消息。见 ADR 0576。

`rich_phone` 和 `rich_card` 在 `packages/detectors-rich`。只在对应标记为 true 时返回 score 1。证据是 `rich:phone` 或 `rich:card`。号码不进证据。看得见的字仍是正文。两条规则默认关闭。私聊 `/rule` 打开后只删除这一种。见 ADR 0501。

`rich_email` 也在 `packages/detectors-rich`。只在 `message.asRichEmail` 为 true 时返回 score 1。证据是 `rich:email`。地址不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。电话和银行卡仍由各自的规则决定。见 ADR 0502。

富文本照片、视频和动图上 `has_spoiler` 正好是 `true` 时，同样命中 `media_spoiler`。证据仍是 `media:spoiler`。文件号不进证据。说明仍是正文。见 ADR 0503。

`rich_map` 在 `packages/detectors-location`。只在 `message.asRichMap` 为 true 时返回 score 1。证据是 `map:rich`。坐标不进证据。说明仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种地图。纯位置仍由 `bare_location` 决定。见 ADR 0504。

`rich_mention` 也在 `packages/detectors-rich`。只在 `message.asRichMention` 为 true 时返回 score 1。证据是 `rich:mention`。用户名不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。邮箱仍由 `rich_email` 决定。见 ADR 0505。

`rich_text_mention` 也在 `packages/detectors-rich`。只在 `message.asRichTextMention` 为 true 时返回 score 1。证据是 `rich:text_mention`。用户编号不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。用户名提及仍由 `rich_mention` 决定。见 ADR 0506。

`rich_command` 也在 `packages/detectors-rich`。只在 `message.asRichCommand` 为 true 时返回 score 1。证据是 `rich:command`。命令不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。按标识提及仍由 `rich_text_mention` 决定。见 ADR 0507。

`rich_hashtag` 也在 `packages/detectors-rich`。只在 `message.asRichHashtag` 为 true 时返回 score 1。证据是 `rich:hashtag`。标签不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。机器人命令仍由 `rich_command` 决定。见 ADR 0508。

`rich_cashtag` 也在 `packages/detectors-rich`。只在 `message.asRichCashtag` 为 true 时返回 score 1。证据是 `rich:cashtag`。行情代码不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。话题标签仍由 `rich_hashtag` 决定。见 ADR 0509。

`rich_anchor` 也在 `packages/detectors-rich`。只在 `message.asRichAnchor` 为 true 时返回 score 1。证据是 `rich:anchor`。名字不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。行情标签仍由 `rich_cashtag` 决定。见 ADR 0510。

`rich_anchor_link` 也在 `packages/detectors-rich`。只在 `message.asRichAnchorLink` 为 true 时返回 score 1。证据是 `rich:anchor_link`。名字不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。锚点仍由 `rich_anchor` 决定。见 ADR 0511。

`rich_reference` 也在 `packages/detectors-rich`。只在 `message.asRichReference` 为 true 时返回 score 1。证据是 `rich:reference`。名字不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。锚点链接仍由 `rich_anchor_link` 决定。见 ADR 0512。

`rich_reference_link` 也在 `packages/detectors-rich`。只在 `message.asRichReferenceLink` 为 true 时返回 score 1。证据是 `rich:reference_link`。名字不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。引用仍由 `rich_reference` 决定。见 ADR 0513。

`text_mention` 在 `packages/detectors-mention`。只在 `message.asTextMention` 为 true 时返回 score 1。证据是 `entity:text_mention`。用户编号不进证据。看得见的字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。富文本按标识提及仍由 `rich_text_mention` 决定。见 ADR 0514。

清单任务和后加任务上的按标识提及也让 `asTextMention` 为 true。投票选项和手动引用仍不带。见 ADR 0567。

投票说明和描述上的按标识提及也让 `asTextMention` 为 true。见 ADR 0568。

礼物附言上的按标识提及也让 `asTextMention` 为 true。发布者用户名不进证据。见 ADR 0569。

游戏附加文字上的按标识提及也让 `asTextMention` 为 true。封面文件编号不进证据。见 ADR 0570。

`custom_emoji` 在 `packages/detectors-emoji`。只在 `message.asCustomEmoji` 为 true 时返回 score 1。证据是 `entity:custom_emoji`。编号不进证据。看得见的字和替代文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。按标识提及仍由 `text_mention` 决定。见 ADR 0515。

投票描述上的自定义表情也让 `asCustomEmoji` 为 true。编号不进证据。见 ADR 0571。

后加清单任务上的自定义表情也让 `asCustomEmoji` 为 true。完成者名字不进证据。见 ADR 0572。

后加和删掉的投票选项上的自定义表情也让 `asCustomEmoji` 为 true。选项编号不进证据。见 ADR 0573。

手动引用上的自定义表情也让 `asCustomEmoji` 为 true。引用位置不进证据。见 ADR 0574。

`copy_text` 在 `packages/detectors-copy`。只在 `message.asCopyText` 为 true 时返回 score 1。证据是 `button:copy_text`。复制句子不进证据。看得见的按钮文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。自定义表情仍由 `custom_emoji` 决定。见 ADR 0516。

`switch_query` 在 `packages/detectors-query`。只在 `message.asSwitchQuery` 为 true 时返回 score 1。证据是 `button:switch_query`。查询不进证据。看得见的按钮文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。复制按钮仍由 `copy_text` 决定。见 ADR 0517。

`login_forward` 在 `packages/detectors-login`。只在 `message.asLoginForward` 为 true 时返回 score 1。证据是 `button:login_forward`。替换文字不进证据。看得见的按钮文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。内联查询仍由 `switch_query` 决定。见 ADR 0518。

`button_emoji` 在 `packages/detectors-icon`。只在 `message.asButtonEmoji` 为 true 时返回 score 1。证据是 `button:button_emoji`。编号不进证据。看得见的按钮文字仍是正文。规则默认关闭。私聊 `/rule` 打开后删除这种正文。正文里的自定义表情仍由 `custom_emoji` 决定。见 ADR 0519。

`sticker_emoji` 在 `packages/detectors-emoji-sticker`。只在 `message.asStickerEmoji` 为 true 时返回 score 1。证据是 `sticker:sticker_emoji`。编号不进证据。普通贴纸仍由 `media_sticker` 决定。规则默认关闭。私聊 `/rule` 打开后删除这种贴纸。正文里的自定义表情仍由 `custom_emoji` 决定。见 ADR 0520。

洪泛和重复在 `packages/detectors-rate`。两者共用一个 `RateWindow`。默认实现是内存，最多 256 个 key。放不下时 `observe` 返回 `null`，检测器返回未命中并记 `rate_window_skipped`。不要把原文或文件 id 放进 key。有正文时重复检测用 `textSha256`。没有正文但有 `mediaSha256` 时用这份摘要。两者都没有则跳过。配了 `RATE_WINDOW` 之后按群放进 Durable Object，调用失败记 `rate_window_failed` 并放过。提交的配置不绑定它。同一条事件 id 在这个 key 最近 32 次计数里只计一次。见 ADR 0010、ADR 0050、ADR 0052、ADR 0338 和 `docs/limits.md` 的 KV、Durable Objects 两节。

链接检测在 `packages/detectors-link`。默认只认短链域名、denylist 和 IPv4 主机。`ReputationSource` 不传就不会发请求。本地已命中时也不调用它。超时或抛错记 `reputation_failed`，返回 null。证据里只留主机名。抽主机名之前的折叠，以及每种字段怎么留下主机名，见 [message-surface.md](message-surface.md)。`tg://join?invite=` 和 `tg://addlist?slug=` 记成 `t.me` 邀请。`tg://resolve` 仍当公开用户名。邀请码不进证据。见 ADR 0102。

跨群黑名单在 `packages/detectors-blocklist`。`BlocklistStore` 先看这个群有没有打开。没打开就返回 null，并且不调用 `has`。打开后只匹配 actor id 或 `textSha256`。原文、带空格的句子、以及不是 64 位小写十六进制的值都不能写入。存储抛错记 `blocklist_failed`，返回 null。配了 `POLICY_KV` 时，开关和条目在变化时写入这份 KV。`remove` 删一条标识，不存在时不写。状态行带上这个租户的条目数，不列出标识。见 ADR 0012、ADR 0047、ADR 0048、ADR 0049 和 `docs/limits.md`。

适配器实现 `Storage`、`Cache`、`PolicyStore` 或 `ModerationPort`。不要把 D1、KV 或 Telegram 的类型 re-export 到 core 能 import 的位置。`RuleSource` 只返回未校验文档，schema 和缓存由 `loadRuleSet` 负责。`PolicyStore` 的实现要调用 `@tasb/core/testing` 的 `bindPolicyStoreContract`，和内存适配器、KV 适配器跑同一组行为。`Storage` 的实现要调用 `bindStorageContract`。`listAudits` 返回最近的一页，页内按时间从早到晚。`countAudits` 返回范围内的条数。`exportAudits` 返回这些审计。私聊放不下时用一次列表取最近一页，一条也放不下才只回复条数。`deleteAudits` 按页删除这些审计并返回这次删掉的条数。D1 每页 1000 行，最多 32 页。删不完时 `/forget` 再数剩余。见 ADR 0361。`putAuditsIfAbsent` 按主键补上还没有的审计。`CaptchaStore.deleteMany` 一次删掉多条挑战。D1 把这两次调用各打成一批。导出 JSON 再过一遍审计 schema，不能带原文键。`put` 用 `prefilterPolicySchema` 拒绝空 id、超过 128 字符的 id，以及超过 200 个 id。读到无法通过 schema 的文档时返回 null，不要把文档写进日志。

私聊命令的句子在 `packages/core` 的消息目录里，键是 `command.*`。`translate` 在未知语言时用中文，缺键时返回 key，不抛错。新增一句回复要同时写 `zh` 和 `en`。见 ADR 0013。

`/appeal` 读 `Storage.getAudit`，再用 `buildReviewSample` 写入 `ReviewQueue`。样本只有哈希、动作、分数、reason 和规则 id。证据摘要不复制。队列满 256 条或存储抛错时回复「参数无效」，日志是 `operator_rejected`。见 ADR 0014。

`/unban <chatId> <actorId>` 调用 `unbanActor`。配了 token 时使用 `unbanChatMember`，并且 `only_if_banned` 为 true。没有端口或调用失败时回复「参数无效」。不改黑名单，也不解除禁言。见 ADR 0362。

`/unmute <chatId> <actorId>` 先调用 `getChatMember`。状态是 `restricted` 时把每一项权限打开，不带 `until_date`。其它状态回复没有禁言，不再调用 `restrictChatMember`。没有 token 或调用失败时回复「参数无效」。见 ADR 0363。

`/ban <chatId> <actorId>` 调用 `banActor`。配了 token 时使用 `banChatMember`，`revoke_messages` 为 false，不带 `until_date`。没有 token 或调用失败时回复「参数无效」，不把内存里的记录当成已经封禁。不改黑名单，也不解除禁言。见 ADR 0364。

`/banfor <chatId> <actorId> <seconds>` 调用 `banActorFor`。配了 token 时使用 `banChatMember`，`revoke_messages` 为 false，并带上 `until_date`。秒数要在 30 秒到 366 天之间，少了或多了都不发出请求。没有 token 或调用失败时回复「参数无效」，不把内存里的记录当成已经封禁。不改黑名单，也不解除禁言。见 ADR 0431。

`/allows <chatId> <actorId>` 调用 `readMemberAllows`。配了 token 时使用 `getChatMember`，只带 `chat_id` 和 `user_id`。没有单独限制时回复无。受限时写出人是否还在、到期时间和每一项权限。缺布尔值整份回复是「参数无效」。名字和标签不进回复，也不进日志。没有 token 时不编一份权限。不调用 `restrictChatMember`。见 ADR 0432。

`/canadmin <chatId> <actorId>` 调用 `readMemberAdmin`。配了 token 时使用 `getChatMember`，只带 `chat_id` 和 `user_id`。不是管理员时回复无。管理员写出打开的权限，以及这个 bot 能不能改。创建者不写权限词，也不写能不能改。缺必填布尔值整份回复是「参数无效」。名字和自定义头衔不进回复，也不进日志。没有 token 时不编一份权限。不调用 `promoteChatMember`。见 ADR 0433。

`/kick <chatId> <actorId>` 调用 `kickActor`。配了 token 时先 `getChatMember`。普通成员，以及还在群里的受限成员，再调用 `unbanChatMember`，不带 `only_if_banned`。已经离开、已经封禁或是管理员时不调用第二次。回复写明移出、不在群里或是管理员。名字不进回复。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经移出。不调用 `banChatMember`。不改 `/ban` 和 `/unban`。见 ADR 0434。

`/cani <chatId>` 调用 `readOwnAdmin`。配了 token 时先 `getMe`，再 `getChatMember`，只带 `chat_id` 和这个 bot 的 `user_id`。不是管理员时回复无。管理员写出打开的权限，以及这个 bot 能不能改。创建者不写权限词，也不写能不能改。名字和用户名不进回复，也不进日志。没有 token 时不编一份权限。不调用 `promoteChatMember`。不改 `/canadmin`。见 ADR 0435。

`/captcha <chatId> <actorId>` 对已经在群里的人再发一次入群验证。先 `restrictChatMember` 300 秒，再静音发出同一对按钮。验证消息发到目标群，回复发到私聊。按钮发不出去时解除限制并删除挑战，回复「参数无效」。nonce 不进回复，也不进日志。群聊里的同样文本不执行。没有 token 或调用失败时不把内存记录当成已经限制。不改入群时的 `new_member`。见 ADR 0450。

`/uncaptcha <chatId> <actorId>` 取消尚未完成的验证。先取走挑战，再 `restrictChatMember` 把每一项权限打开，不带 `until_date`，然后 `deleteMessage` 删掉按钮。没有待验证时不调用。放行失败时把挑战放回去，不删按钮。nonce 不进回复，也不进日志。不改 `/unmute`。见 ADR 0451。

`/warn <chatId> <actorId>` 给同一个人记一次警告。未满 3 次不调用 Telegram。第 3 次调用 `banActor`，也就是 `banChatMember`，`revoke_messages` 仍是 false，不带 `until_date`。封禁失败时次数退回，回复「参数无效」。已经满 3 次时不再封禁。`/unwarn` 只把次数清掉，不调用 `unbanChatMember`。`/warns <chatId>` 按次数从高到低列出这个群，次数相同按编号从小到大。没有警告时只写群号。`/warns <chatId> <actorId>` 仍只读一个人。见 ADR 0456。私聊 `/warnlimit` 把这个群的上限改成 1 到 10，默认仍是 3。见 ADR 0457。配了 DB 时次数在 D1，没配时仍在内存，重启后从 0 开始。名字不进回复，也不进日志。见 ADR 0453。规则动作 `warn` 见 ADR 0454。已经满 3 次时，流水线再命中会再封禁；这条命令不再封禁。

机器人还在群里但不是管理员，或管理员缺删除、缺限制时，给改了它的那个人发一条私聊。已经离开或被移出时不发。两条权限都在时不发。不发到群里。见 ADR 0436。

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

`/commands skip <count>` 先按原顺序跳过前面的 `count` 条再列。不写 `skip` 或 `count` 为 0 时回复不变。`private` 仍是同一份私聊菜单。见 ADR 0523。

`/delcommands [private]` 调用 `deleteCommandMenu`。配了 token 时使用 `deleteMyCommands`，范围是 `all_private_chats`，不送 `language_code`。清掉之后更高一层的菜单会显示出来。群菜单不变。已有单独语言列表的人不受影响。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经清掉。不调用 `setMyCommands` 或 `getMyCommands`，也不改黑名单、封禁或禁言。见 ADR 0409。

`/menubutton <commands|default>` 调用 `setMenuButton`。配了 token 时使用 `setChatMenuButton`。`commands` 送 `{ type: "commands" }`，`default` 送 `{ type: "default" }`。不送 `chat_id`，所以改的是默认按钮。某个私聊里单独设过的按钮不受影响。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不送 `web_app`。不调用 `getChatMenuButton`，也不改黑名单、封禁或禁言。见 ADR 0410。

`/button` 调用 `readMenuButton`。配了 token 时使用 `getChatMenuButton`，不送 `chat_id`，所以读的是默认按钮。`commands` 写命令，`default` 写默认，`web_app` 写应用。按钮文字和地址不进回复。别的类型整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一个状态。不调用 `setChatMenuButton`。见 ADR 0411。

`/botname [name]` 调用 `setBotName`。配了 token 时使用 `setMyName`。名字按空白折成一段，1 到 64 个字符才送出。不写名字时送空字符串，清掉默认名字。不送 `language_code`，所以已有单独语言名字的人不受影响。回复不重复名字。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getMyName`，也不改黑名单、封禁或禁言。见 ADR 0412。

`/myname` 调用 `readBotName`。配了 token 时使用 `getMyName`，不送 `language_code`，所以读的是默认名字。空名字写空。回复带上名字，日志不带。换行、超长或非字符串时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一个名字。不调用 `setMyName`。见 ADR 0413。

`/botdesc [description]` 调用 `setBotDescription`。配了 token 时使用 `setMyDescription`。简介按空白折成一段，1 到 512 个字符才送出。不写简介时送空字符串，清掉默认简介。不送 `language_code`，所以已有单独语言简介的人不受影响。回复不重复简介。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getMyDescription`，也不改黑名单、封禁或禁言。见 ADR 0414。

`/mydesc` 调用 `readBotDescription`。配了 token 时使用 `getMyDescription`，不送 `language_code`，所以读的是默认简介。空简介写空。回复带上简介，日志不带。换行、超长或非字符串时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份简介。不调用 `setMyDescription`。见 ADR 0415。

`/botshort [short]` 调用 `setBotShortDescription`。配了 token 时使用 `setMyShortDescription`。短简介按空白折成一段，1 到 120 个字符才送出。不写短简介时送空字符串，清掉默认短简介。不送 `language_code`，所以已有单独语言短简介的人不受影响。回复不重复短简介。只有配置里的管理员可以改。没有 token 或调用失败时回复「参数无效」，不把内存记录当成已经设置。不调用 `getMyShortDescription`，也不改黑名单、封禁或禁言。见 ADR 0416。

`/myshort` 调用 `readBotShortDescription`。配了 token 时使用 `getMyShortDescription`，不送 `language_code`，所以读的是默认短简介。空短简介写空。回复带上短简介，日志不带。换行、超长或非字符串时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份短简介。不调用 `setMyShortDescription`。见 ADR 0417。

`/who` 调用 `readBotIdentity`。配了 token 时使用 `getMe`，不带参数。回复写编号、用户名、能否入群、是否看得到全部群消息、能否做访客查询，以及能否处理入群查询。缺用户名写空。缺开关写未知。名字和其它字段不进回复，也不进日志。用户名不合规则、不是 bot 或开关不是布尔值时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份身份。不调用 `logOut` 或 `close`。见 ADR 0418 和 ADR 0424。

`/hook` 调用 `readWebhook`。配了 token 时使用 `getWebhookInfo`，不带参数。回复写待投递条数、证书、连接上限和上次错误的 unix 秒。缺字段写未知。地址、IP、错误原文和 `allowed_updates` 不进回复，也不进日志。待投递不是非负整数、连接不在 1 到 100、或错误时间不是非负整数时整份回复是「参数无效」。只有配置里的管理员可以看。没有 token 时不编一份状态。不调用 `setWebhook` 或 `deleteWebhook`。见 ADR 0419。

`/guard <chatId>` 调用 `readChatGuard`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写类型、话题、频道私聊、审核入群、入群才能发言、官方反垃圾、慢速秒数、自毁秒数、加速豁免、防转发、隐藏成员、可见历史、反应上限和关联群。缺开关或秒数写未知。标题、简介、邀请链接、用户名和名字不进回复，也不进日志。类型不是四种群、秒数不是非负整数、反应上限缺失或关联群号不合规则时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一份状态。不调用 `setChatPermissions`。见 ADR 0420。

`/joinbot <chatId>` 调用 `readJoinBot`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写处理入群申请的 bot 编号和用户名。没有 `guard_bot` 写未知。缺用户名写空。名字和其它用户字段不进回复，也不进日志。不是 bot、编号不是正的安全整数或用户名不合规则时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一份身份。不调用 `setChatPermissions`。见 ADR 0421。

`/reactions <chatId>` 调用 `readReactions`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写允许的反应个数。缺 `available_reactions` 写全部，因为文档说这时全部表情反应都允许。空数组写 0。表情、自定义表情编号和付费反应不进回复，也不进日志。不是反应对象或返回的群号和请求不一致时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一个个数。不调用 `setMessageReaction`。见 ADR 0422。

`/community <chatId>` 调用 `readCommunity`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写社区编号。没有 `community` 写无。名字不进回复，也不进日志。编号不是正的安全整数或返回的群号和请求不一致时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一个编号。不调用 `setChatPermissions`。见 ADR 0423。

`/canstickers <chatId>` 调用 `readStickerSetRight`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写这个 bot 能否更换群贴纸包。缺 `can_set_sticker_set` 写未知。贴纸包名字不进回复，也不进日志。不是布尔值或返回的群号和请求不一致时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一个开关。不调用 `setChatStickerSet` 或 `deleteChatStickerSet`。见 ADR 0425。

`/parent <chatId>` 调用 `readParentChat`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写对应频道的编号。没有 `parent_chat` 写无。标题和用户名不进回复，也不进日志。类型不是四种群、编号不是安全整数或返回的群号和请求不一致时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一个编号。不调用 `setChatTitle`。见 ADR 0426。

`/personal <chatId>` 调用 `readPersonalChat`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写个人频道的编号。没有 `personal_chat` 写无。标题、用户名和姓名不进回复，也不进日志。类型不是四种群、编号不是安全整数或返回的群号和请求不一致时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一个编号。不调用 `setChatTitle`。见 ADR 0427。

`/privacy <chatId>` 调用 `readPrivatePrivacy`。配了 token 时使用 `getChat`，只带 `chat_id`。回复写私密转发和语音视频限制。缺字段写未知。名字、简介和邀请链接不进回复，也不进日志。不是布尔值或返回的群号和请求不一致时整份回复是「参数无效」。配置里的管理员可以看任意群。接入目录里的人只能看自己的群。没有 token 时不编一份开关。不调用 `setChatPermissions`。见 ADR 0428。

`/evals` 读 `ReviewQueue.list`，再用 `buildFeedbackCase` 收成评测样本。`confirmed` 是 `spam`，`false_positive` 是 `ham`。文档不带原文，也不能送回检测器重放。放不下全部样本时返回最近的一页，并写上省略条数。见 ADR 0016 和 ADR 0330。形状在 `evals/cases/feedback.json`。

`llm` 检测器在 `packages/detectors-llm`。没有 `LlmClassifier` 时返回 null。分类器抛错或超时记 `llm_failed`，也返回 null。证据只写 `llm:` 加标签。默认模型和使用方式见 ADR 0015。评测在 `evals/cases/llm.json`。

`regex` 检测器在 `packages/detectors-regex`。配置是 1 到 8 条模式，每条最多 64 个字符，只用 `u`。创建时拒绝嵌套量词、分组量词、反向引用和 `{`。比较前会去掉零宽字符、双向控制符、非常规空白、换行、变体选择符和点状间隔号，并把全角拉丁字母、七个西里尔字母和乌克兰语 `і` 收成拉丁字母，模式本身不改。一层百分号编码的间隔号先收成对应字符再去掉。第二层和句号 `。` 的编码保留。普通空格、句号 `。`、全角数字和西里尔 `т` 保留。`test` 抛错记 `regex_failed` 并返回 null。证据固定是 `regex:hit`，不写匹配片段，也不写模式。默认规则 `regex_hint` 是关闭的。见 ADR 0023、ADR 0054、ADR 0060、ADR 0064、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0098 和 ADR 0099。评测在 `evals/cases/regex.json`。

关键词检测同样先做这层折叠，再做包含判断。除了一层间隔号编码，百分号编码不在这一层解释。只由这些字符组成的关键词不会匹配所有消息。证据里的词也折叠。点状间隔号去掉。全角拉丁字母收成半角。七个西里尔字母和乌克兰语 `і` 收成拉丁字母。普通空格、句号 `。`、全角数字和西里尔 `т` 保留。一层百分号编码的间隔号先收成对应字符再去掉。第二层和句号 `。` 的编码保留。见 ADR 0054、ADR 0060、ADR 0064、ADR 0093、ADR 0094、ADR 0095、ADR 0096、ADR 0098 和 ADR 0099。没有 `text` 和 `caption` 时，投票题干、抽奖奖品说明、清单标题、游戏标题、账单标题、场馆标题、文件名、音频标题、表演者、内联按钮文字或手动引用会先成为这段正文。几个按钮用一个普通空格分开。自动引用、被回复的原消息、选项、任务文字、说明、附加文字、地址、坐标、贴纸包名、文件 id、回复键盘和复制句子不进事件。见 ADR 0056、ADR 0057、ADR 0058、ADR 0059、ADR 0061、ADR 0062、ADR 0063 和 ADR 0092。没有更前面的正文时，作者签名整段成为正文。已有正文时签名不并进去。见 ADR 0101。没有更前面的正文时，成员标签也整段成为正文。已有正文或作者签名时，标签不并进去。见 ADR 0112。没有更前面的正文时，拒绝建议帖的说明也整段成为正文。已有正文时说明不并进去。嵌套的原帖不读。见 ADR 0113。

`forward` 检测器在 `packages/detectors-forward`。它只看 `message.forward`。Worker 默认只把 `channel` 当命中，证据是 `forward:channel`。用户、群和隐藏来源默认不命中。见 ADR 0025 和 ADR 0468。评测在 `evals/cases/forward.json`。

`forward_hidden`、`forward_chat` 和 `forward_user` 各认一种来源。默认规则 `hidden_forward`、`chat_forward`、`user_forward` 关闭。私聊 `/rule` 打开后只删除这一种。来源标题不进证据。见 ADR 0468。

`aggregateMetrics` 读取 `pipeline_completed`、`pipeline_exempt`、检测器失败和存储失败日志。dry-run 不计入拦截率。`log` 和 `report` 计入动作，不计入拦截。结果里没有原文和昵称。见 ADR 0017。最小例子在 `examples/minimal-pipeline`。

规则包订阅走 `RuleSubscriptionStore`、`RulePackSource` 和 `RulePackArchive`。默认关闭。`/packs <chatId> off` 下一条消息就不再读规则包。刷新失败时保留上一份通过 schema 的 `RuleSet`。配了 `POLICY_KV` 时订阅指针和上一份通过 schema 的规则按群放进这份 KV。规则没变不写，超过 16384 个字符不写。私聊 `/rules` 列出这份解析结果，已订阅时标题带上 pack id，每一行标明 `file` 或 `switch`。放不下全部规则时列出前面的若干条，并写上剩下的条数。见 ADR 0333。超额之后，不在基础检测器里的规则加上 `paused`，标题末尾带上窗口结束时间。超额的 `/quota` 在下一行列出这些基础检测器 id，顺序与策略一致，默认名单仍是 ADR 0026。同一条事件 id 在该群最近 64 次计数里只计一次。见 ADR 0337。状态行末尾带窗口结束时间。见 ADR 0019、ADR 0037、ADR 0038、ADR 0039、ADR 0040、ADR 0041、ADR 0042、ADR 0043、ADR 0044、ADR 0046 和 `examples/operator-commands`。私聊 `/rule` 还可以把这一条已有规则换成一个处置动作，`file` 回到文件。动作和开关分开存放。见 ADR 0458。私聊 `/report` 决定这个群的上报发到哪里。不设置时仍发给配置里的第一个管理员，不能发回本群。见 ADR 0459。私聊 `/flood` 改这个群的洪泛条数和秒数，不设置时仍是 10 秒 5 条。见 ADR 0460。私聊 `/keyword` 追加关键词，内置词还在。见 ADR 0461。

私聊 `/rules <chatId> skip <count>` 跳过前面的 `count` 条，再按原顺序往下列。不写 `skip` 时仍从第一条开始。见 ADR 0521。

私聊 `/rules <chatId> on` 只列打开的规则，`off` 只列关闭的规则。不写时仍列出全部。见 ADR 0522。

私聊 `/repeat` 改这个群的重复条数和秒数。不设置时仍是 60 秒 3 条。见 ADR 0462。

私聊 `/rulemute` 改这个群在规则命中后的禁言秒数。不设置时仍是 3600 秒。见 ADR 0463。

私聊 `/verifyfor` 改这个群的验证秒数。不设置时仍是 300 秒。入群验证和私聊 `/captcha` 用同一段时长。见 ADR 0464。

私聊 `/verifyfail` 决定验证到期后留下、移出或封禁。不设置时成员留下。见 ADR 0465。

私聊 `/allowhost` 让这个群放行指定主机。不添加时短链仍删除。见 ADR 0466。

`/allowhost <chatId> skip <count>` 先按原顺序跳过前面的 `count` 台再列。不写 `skip` 或 `count` 为 0 时回复不变。放不下时保留完整主机名。见 ADR 0524。

`/chats skip <count>` 先按目录顺序跳过前面的 `count` 个群再列。不写 `skip` 或 `count` 为 0 时回复不变。跳过的群不再读额度。见 ADR 0525。

`/whitelist <chatId> skip <count>` 先按原顺序跳过前面的 `count` 个 id 再列。不写 `skip` 或 `count` 为 0 时回复不变。见 ADR 0526。

`/admins <chatId> skip <count>` 先按返回顺序跳过前面的 `count` 个人再列。不写 `skip` 或 `count` 为 0 时回复不变。见 ADR 0527。

`/chats <chatId>` 列出这个群记下的人，先记下的在前。没有人时下一行是 `none`。不读额度。见 ADR 0528。

`/guard <chatId>` 还写出付费发言的星星数，以及频道是否接受付费媒体。缺字段写未知。显式的 0 写成 0。见 ADR 0529。

`/guard <chatId>` 还写出无限礼物、限量礼物、独特礼物、会员订阅和频道礼物是否接受。整份对象缺失时五行都写未知。见 ADR 0530。

`/guard <chatId>` 还写出这个群有没有绑定地点。没返回写关。地址和坐标不进回复。见 ADR 0531。

插件清单含 `id`、`version`、`kind`、`schema`、`integrity`，外部包还可以有 `signature`。完整性是 canonical JSON 的 sha256。签名是同一段 JSON 的 HMAC-SHA256。内置清单可以不签名。外部清单没有有效签名时不会进入流水线，除非自部署把 `ALLOW_UNSIGNED_PLUGINS` 设为 `true`。`DEPLOYMENT_MODE=cloud` 时这个变量无效。坏签名在两种模式下都拒绝。见 ADR 0018 和 `examples/plugin-manifest`。

平台包把 Telegram `Update` 收成 `Event`。参考 `packages/platform-telegram` 和 `examples/telegram-webhook`。Webhook 失败时不要调用 `onEvent`。私聊管理命令见 `examples/operator-commands` 和 ADR 0006。`/logs` 一行放不下全部规则或原因时，保留前面的若干个并写上剩下的个数。见 ADR 0334。回复只通过 `ReplyPort` 发送，不要在 core 里调用 Bot API。

提交前：

```sh
pnpm boundaries
pnpm test
pnpm eval
```
