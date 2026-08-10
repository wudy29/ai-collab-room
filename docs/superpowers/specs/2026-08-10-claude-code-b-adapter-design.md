# Claude Code 外部 B 薄 Adapter 最小设计

日期：2026-08-10

## 1. 目标

为第一次真实双用户 AI 联调提供一个可单独交给 B 侧用户运行的小型 adapter 包。

唯一目标：

> 在 B 侧 Mac 上，本地 A2A 请求能够被转成对指定 Claude Code 会话的一次 `claude -p --resume <session-id>` 调用，并把 Claude 的文本回复作为 A2A 文本结果返回。

这一阶段只验证本机链路，不处理跨机器网络。

## 2. 产品边界

B 侧用户拿到的是一个独立小 adapter 包，不需要 clone `ai-collab-room-m0` 整个仓库。

adapter 不拥有 B 的身份和记忆。

B 的身份与连续性继续来自她自己的：

- Claude Code 会话；
- 项目级身份文件；
- 本地长期记忆 MCP；
- 本地知识库。

adapter 只负责转发一次消息并返回一次回复。

## 3. 最小文件

独立 adapter 包只需要：

- `server.js`
- `package.json`
- `README.md`

不增加 UI，不增加配置中心，不增加安装器。

## 4. 运行时参数

只允许三个运行时参数：

- `CLAUDE_SESSION_ID`
  - 必填；
  - 指向联调专用轻量 Claude Code 会话；
  - 不写入代码；
  - 不写入仓库；
  - 不发送给 A 侧。

- `CLAUDE_WORKDIR`
  - 必填；
  - Claude Code 平时运行、身份文件会自动注入的工作目录。

- `CLAUDE_BIN`
  - 可选；
  - 默认 `claude`；
  - 仅 PATH 找不到 Claude CLI 时显式指定。

## 5. Claude 调用

adapter 收到文本后，最小调用形状：

```text
claude -p --resume <CLAUDE_SESSION_ID> <prompt>
```

工作目录使用 `CLAUDE_WORKDIR`。

adapter 捕获标准输出作为 Claude 回复。

非零退出码、空回复或超时直接视为失败。

不做自动重试，不做 fallback，不切换 session。

## 6. A2A 形状

adapter 对外表现为现有 Room connector 已经兼容的最小 A2A Agent：

- `GET /.well-known/agent-card.json`
- JSON-RPC `message/send`
- 文本输入
- 文本输出

返回形式只需满足现有 connector 能提取文本。

不修改现有 Room、RoomStore、A2A connector 或 Room 状态机。

## 7. 本机网络边界

第一阶段 adapter 只监听：

```text
127.0.0.1
```

不开放公网。

不增加 TLS、账号系统、Bearer token、签名、隧道或网络认证。

跨机器访问是下一阶段单独处理的问题。

## 8. 会话规则

正式联调使用 B 侧新开的轻量专用 Claude Code 会话。

同一个 session id 可反复 `--resume`，不需要链式更新 session id。

联调期间该 session 不进行人工交互，避免人工窗口与 adapter 同时写同一 transcript。

adapter 不实现锁、队列或 session manager。

## 9. adapter 不保存的内容

adapter 不保存：

- transcript；
- messages 历史；
- 长期记忆；
- MCP 返回内容；
- 身份文件内容；
- session id 到磁盘；
- API key、token 或其他凭据。

Claude Code 自己负责会话历史。

B 侧本地 MCP 自己负责长期记忆。

## 10. 本阶段验收

本机完成一次无害 ping：

```text
A2A 文本请求
→ localhost adapter
→ claude -p --resume <指定轻量会话>
→ Claude Code
→ 文本回复
→ A2A 返回
```

必须证明：

1. adapter 能正常启动；
2. Agent Card 可读取；
3. `message/send` 能把文本送入指定 Claude Code 会话；
4. 返回的是该会话中的 Claude 文本回复；
5. Claude 仍具有原有身份与本地长期记忆能力；
6. adapter 未写入任何自己的持久化记忆或 transcript；
7. adapter 只绑定 localhost。

达到以上条件立即停止。

## 11. 明确非目标

本阶段不做：

- 跨机器联调；
- 公网暴露；
- VPN / Tunnel / SSH 转发；
- 用户账号；
- 权限系统；
- session manager；
- transcript 锁；
- 多会话切换；
- 多用户；
- 群聊；
- UI；
- 安装器；
- 自动发现 Claude 会话；
- 自动创建 Claude 会话；
- 记忆同步；
- Room 改造；
- connector 改造；
- A2A 框架重构。

## 12. 硬停止

一旦本机 A2A → Claude Code → A2A 的单轮 ping 验收通过，本阶段结束。

不要顺手解决网络、认证、并发、多用户或部署问题。
