# ADR 0005：预过滤策略的存储

- 状态：已接受
- 日期：2026-11-01

## 背景

管理员豁免和白名单原先写死在 Worker 里：每个群都豁免管理员，白名单是空的。P0-05 要求按 tenant 和 chat 存放，并且可以关掉管理员豁免。热路径不能为了这份小文档去打 D1。

## 决策

- 新增端口 `PolicyStore`：`get` 返回该群的 `PrefilterPolicy` 或 null；`put` 用 `prefilterPolicySchema` 校验后整份替换。
- `loadPolicy` 先读 `Cache`。命中且 schema 通过就直接返回。缓存损坏时再读存储，不把损坏当成「没有策略」。
- 存储返回 null 时使用调用方传入的 fallback，并缓存这份 fallback。Worker 的 fallback 是 `{ exemptAdmins: true, allowActorIds: [] }`。
- 存储抛错时记 `policy_store_failed`，返回 fallback 并缓存。不记录异常文本。
- `put` 不主动删除缓存。默认 TTL 60 秒。管理命令改完策略后，最迟在 TTL 之后生效。
- 白名单每群最多 200 个 id，每个 id 最长 128 字符，和 Event 的 actor id 上限一致。
- 内存适配器现在给 Worker 用。Cloudflare 包提供 `createKvPolicyStore(StringStore)`，测试用内存 map 充当 KV。真正的 KV 绑定留到 P0-08。core 不出现 Workers 类型。
- 两个适配器都调用 `bindPolicyStoreContract`（`@tasb/core/testing`）。这个入口不从包根导出，避免 Worker 打包进 Vitest。

## 备选

| 方案 | 放弃原因 |
| --- | --- |
| 把 get/put 加到 `Storage` | 白名单会和审计绑在同一个存储上。热路径会变成一次 D1 读。 |
| 继续在 Worker 里写死豁免 | 不能满足「按群关闭豁免」，也没法让两种适配器共用行为测试。 |
| 每条消息都读 KV，不缓存 | 免费额度下读次数和延迟都会被白名单拖高。见 `docs/limits.md`。 |

## 后果

- 没有存过策略的群行为和现在一样：管理员豁免，空白名单。
- 关掉豁免只影响写入的那个 tenant 和 chat。
- 只调用 `PolicyStore.put` 时，最多约 60 秒仍走旧缓存。私聊命令通过 `savePolicy` 在写入后立刻覆盖同一条缓存。
- KV 里如果放了通不过 schema 的文档，`get` 返回 null，调用方使用 fallback。原始文档留在 KV 里，但不会进入返回值或日志。
