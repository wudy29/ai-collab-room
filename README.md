# 双边 AI 协作室 M0

这是第一条可运行的纵向切片，只验证：

> 一间本地房间、两个假连接器、两个旁观窗口，严格轮流完成四条消息并成功结束。

## 当前包含

- 三个 Room 工具：`join_room`、`wait_turn`、`submit_turn`
- 两个脚本型假连接器
- 严格 A/B 轮流
- `request_id` 幂等，避免重试产生重复消息
- 一页旁观界面，可同时打开两个浏览器窗口
- SSE 房间事件推送
- 人类结束按钮
- Node 内置测试与端到端四轮验收

## 当前刻意不包含

- 真实模型或身份恢复
- Ombre / Engineering Bridge
- 东京部署
- SQLite、账户、附件、权限配置页
- 暂停恢复、任务看板、核验状态系统

房间状态暂存内存中；进程退出后清空。这是 M0 的刻意取舍。

## 关于 MCP

`/mcp` 当前实现的是用于 M0 验证的最小 JSON-RPC / MCP 形状端点，包含初始化、工具列表和三项工具调用。它用于先验证房间语义和持续连接器循环，不宣称已经通过完整 MCP 一致性测试。

下一步接入真实 Agent 前，将使用官方 TypeScript SDK 替换这层传输适配；房间核心 `RoomStore` 和 M0 验收无需重写。

## 要求

- Node.js 20 或更新版本
- 仅运行 M0 演示不需要安装 npm 依赖；运行完整测试或 M0.5 前需要安装依赖

## 运行测试

```bash
npm test
```

## 运行演示

```bash
npm run demo
```

## Local Agent Edge: three steps

Prerequisites: Node.js 20 or later, then install the project dependencies:

```bash
npm install
```

### 非技术用户：请让你的 AI 一步步带你完成

把这一节 README 交给你自己的 AI，并请它按以下方式指导你：

- 你不需要理解代码、命令/参数、cwd 或 session 参数。
- 让 AI 根据你的环境确认当前可用的 CLI Agent，以及其准确的非交互/恢复调用方式。
- 当 setup 打印提示词时，AI 必须只返回一整行可粘贴的 `edge:configure {JSON}`。
- 配置中绝不能包含密码、token、API key、cookie、session 值或其他秘密。
- 不要为了让引导通过而修改或重构本项目；如被阻塞，请停止并报告准确的失败步骤和原始错误。
- 一次只指导一个操作，优先让你直接复制粘贴。

1. Start setup:

   ```bash
   npm run edge:setup
   ```

2. Copy the prompt printed by setup to your own AI. Paste its one complete
   `edge:configure {JSON}` response back into the still-running setup command.

3. Start the edge:

   ```bash
   npm run edge:start
   ```

   Use the printed Agent Card URL to connect to the local edge.

Do not include passwords, tokens, API keys, cookies, session values, or other
secrets in the configuration.

然后在两个浏览器窗口打开：

```text
http://127.0.0.1:8787
```

终端会自动运行两个假连接器并完成四条消息。演示结束后页面继续保留，按 `Ctrl+C` 停止。

## 单独运行

终端一：

```bash
npm start
```

终端二：

```bash
node src/fake-connector.js A
```

终端三：

```bash
node src/fake-connector.js B
```

## M0 验收

- 双方加入前房间保持 `waiting`
- 双方加入后从 A 开始
- 消息顺序固定为 A → B → A → B
- 第四条由 B 结束房间
- 两个旁观窗口看到同一事件序列
- 相同 `request_id` 不会产生第二条消息

## M0.5 A2A experiment

M0.5 只验证官方 A2A JavaScript SDK 的薄适配，不替换 M0，也不接入模型、MCP 工具或东京部署。

安装依赖后运行：

```bash
npm install
npm test
npm run a2a:demo
```
