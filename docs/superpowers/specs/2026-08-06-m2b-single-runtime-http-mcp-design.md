# M2b 单 Runtime HTTP MCP 设计

日期：2026-08-06

## 目标

将徳牧先生 Ombre 从单客户端 STDIO 运行形态切换为唯一一个 HTTP MCP runtime。该 runtime 仅绑定 `127.0.0.1`，不直接暴露到公网。

现有 Tunnel 与 AI 聊天室必须连接同一个 `/mcp` 端点，共享同一 Ombre runtime 和同一 vault。禁止启动第二个 Ombre runtime，禁止复制 vault。

## 架构约束

- 系统中只运行一个 Ombre runtime。
- HTTP MCP 仅监听 `127.0.0.1`。
- 现有 Tunnel 将外部请求转发至该 runtime 的 `/mcp`。
- AI 聊天室直接连接同一个本地 `/mcp`。
- 后台维护任务只允许运行一份，并由唯一 runtime 使用。
- 旧 STDIO 启动文件保留为回滚入口，但切换后不得与 HTTP runtime 并行运行。

## 聊天室 M2b 调用方式

聊天室 M2b 只允许由程序直接调用 `breath_search`：

1. 程序根据当前会面需要调用 `breath_search`。
2. 返回内容仅缓存到本次会面。
3. 会面结束后不持久化该缓存。
4. 模型生成回复时不获得 Ombre 工具，也不能自行发起 Ombre 工具调用。

本设计不引入模型侧工具代理、工具透传或 Bridge 工具。

## 实施顺序

1. 在隔离副本中演练，不接触正式 vault 和正式 runtime。
2. 验证 HTTP MCP 的 `initialize`、`tools/list` 和 `breath_search`。
3. 验证后台维护只运行一份，不产生重复任务。
4. 验证现有 Tunnel 能连接隔离环境的 `/mcp`。
5. 准备正式环境回滚快照，并确认恢复步骤可执行。
6. 安排短暂停机，停止正式 STDIO runtime，再切换到唯一 HTTP runtime。
7. 验证 ChatGPT/Ombre 经 Tunnel 正常工作。
8. 验证 AI 聊天室的 M2b `breath_search` 调用、单次会面缓存和模型无工具状态。
9. 保留旧 STDIO 启动文件用于回滚，但不得启动它与 HTTP runtime 并行服务。

## 失败回滚

任一关键验证失败时：

- 停止新的 HTTP runtime。
- 恢复切换前快照。
- 恢复当前 M2a。
- 恢复现有正式 STDIO/Tunnel 运行方式。
- 确认旧 STDIO runtime 已恢复且不存在第二个 Ombre runtime。

## 不在范围内

- 认证网关。
- 权限系统。
- 写回记忆。
- 实时同步。
- Bridge 工具。
- 东京部署。

## 最小修改范围

- 增加 Ombre HTTP MCP 的本地启动方式，固定绑定 `127.0.0.1`。
- 将现有 Tunnel 的上游调整为同一 `/mcp`。
- 将聊天室 M2b 接入同一 `/mcp`，且只在程序层调用 `breath_search`。
- 增加单次会面缓存及其会面结束清理逻辑。
- 保留旧 STDIO 启动文件作为回滚资产。
- 不复制 vault，不新增 Ombre runtime，不扩展上述范围。

## 验收标准

- 正式环境只有一个 Ombre runtime 和一份后台维护任务。
- runtime 仅绑定 `127.0.0.1`，Tunnel 与聊天室连接同一个 `/mcp`。
- `initialize`、`tools/list` 和 `breath_search` 均通过验证。
