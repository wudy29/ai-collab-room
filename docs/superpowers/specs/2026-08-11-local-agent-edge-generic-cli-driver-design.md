# Local Agent Edge + Generic CLI Driver 最小设计

日期：2026-08-11

本设计正式取代并删除旧的：
- `docs/superpowers/specs/2026-08-10-claude-code-b-adapter-design.md`
- `docs/superpowers/plans/2026-08-10-claude-code-b-adapter.md`

## 目标

核心原则仍是：**Room owns messages, not agents.**

正式链路：

`Room → A2A → Local Agent Edge → Generic CLI Driver → 用户自己的 Agent`

Room、RoomStore、现有 A2A connector/core 不修改。

## 边界

Local Agent Edge 只监听 `127.0.0.1`，把一轮 A2A 文本交给注入的 driver，再把文本结果包装成现有 connector 可读取的 A2A task。driver 失败则返回 failed task。

Generic CLI Driver 唯一接口是 `run(prompt) -> Promise<string>`。固定配置只有 `command`、`args`、`cwd`、`timeoutMs`、`env`；prompt 走 stdin，reply 走 stdout；spawn error、非零退出、timeout、空 stdout 直接失败。Driver 不知道 Claude、A2A、身份、记忆或 session，不重试、不 fallback、不持久化、不自动发现。

Claude Code 只是第一个 runtime profile，参数必须精确为 `-p --resume <session-id>`。session id 运行时提供，只存在进程内，不落盘；workdir 位于 B 侧。身份文件、原有 Claude session、长期记忆 MCP 全部继续留在用户自己的 Agent/runtime 内。

## 文件

- `local-agent-edge/generic-cli-driver.js`
- `local-agent-edge/a2a-edge.js`
- `local-agent-edge/claude-code.js`
- `test/local-agent-edge.test.js`

复用仓库现有依赖，不建立独立 package。

## 明确不做

不做万能 adapter framework、driver registry、插件市场、UI、HTTP/API Driver、AG-UI、OpenAI-compatible driver、自动发现 Agent/session、session manager、统一记忆层、多用户平台化或 Room core 重构。

## 本轮验收

只完成代码与自动测试：CLI argv/stdin/cwd/stdout/失败行为、A2A contract、Claude 精确 resume 参数、零持久化、`npm test` 和范围检查。通过后停止；真实 Claude localhost ping 与两机 Room 联调留到下一步。
