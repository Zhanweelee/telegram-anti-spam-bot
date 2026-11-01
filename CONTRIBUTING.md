# 贡献

先读 `AGENTS.md` 和 `ROADMAP.md`。一次 PR 只做路线图里的一个任务。

```sh
pnpm install
pnpm check
```

- 提交信息用 Conventional Commits：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`。
- 公共接口变更加一个 Changeset：`pnpm changeset`。
- 架构或新依赖加 `docs/adr/NNNN-title.md`。
- 新检测器带 fixtures，并跑 `pnpm eval`。基线下降就不要提交。
- 不要提交密钥，不要在日志或测试快照里放消息原文。

许可证还没定。在维护者选定之前，贡献即表示你同意以后项目采用的开源许可证，但不要自行添加 `LICENSE`。
