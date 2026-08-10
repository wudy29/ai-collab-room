# M2c 双真实 Agent 最小设计

## 背景
M0、M0.5、M1、M2a 均已验收。M2b 已于 commit `949aba6684f73d48ae0e3cbddf067197ba918129` 完成并验收：A 侧“徳牧先生”在进入房间前由程序级 Ombre HTTP 预加载获得本次会面连续性，模型本身不获得 Ombre 工具；当前 B 侧仍为 fake connector。M2c 只解决把 B 侧替换为第二个真实模型 Agent。

## 目标
在不改变 M2b 已验收架构的前提下，把 fake B 替换成第二个真实、无记忆、无工具的独立模型 Agent，并证明双真实 Agent 可以完成既有四消息房间。

## 设计选择
- 新增独立 `m2c:demo`。
- 保留 `m2b:demo` 原样作为回归基线。
- 复用现有 `createA2AModelAgentServer` 与 `runA2ARoomConnector`。
- 不复制 Agent 实现。
- 不抽象新的双 Agent framework。

## Agent 设计
### A 侧
- 沿用 M2b 的真实 Codex model Agent。
- identity 为“徳牧先生”，companion 为“小猫”。
- 进入房间前程序调用既有 Ombre continuity loader 一次。
- 模型不获得 Ombre 工具。
- M2c 继续复用 M2b 的确定性连续性验收标记：查询“天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？”，结果必须包含“午后乌云压低时，窗边的铜铃一响”。不得为 M2c 另造第二套 continuity 机制。

### B 侧
- 第二个真实 Codex model Agent。
- 使用固定中性静态测试 identity：`displayName="测试 B"`，`companionName="对方伙伴"`。
- 不接记忆。
- 不接工具。
- 不绑定真实用户。
- identity 直接内联在 M2c demo 中，当前不单独建立配置体系。

## 房间流程
Room → A connector → 真实 A Agent；Room → B connector → 真实 B Agent。消息顺序仍严格为 A→B→A→B，共四条消息。第 4 条后由既有 `RoomStore` `maxTurns=4` 自动 `ended`。不得为了 B 修改 room state machine 或结束协议。

## 共享行为的唯一必要修正
现有 `a2a-model-agent.js` 不能再用全局 `turn-1` 判断首次发言。改为每个 `ModelAgentExecutor` 实例记录自己是否已经完整成功回复过：
- 该实例第一次 `execute` 完整成功前按首次发言处理。
- 第一次 `execute` 完整成功后，后续请求按延续对话处理。
- 若 `execute` 抛错或未完整成功，不改变该实例的首次发言状态；失败后的重试仍视为首次。
- 不引入 side 概念、session manager 或新 provider 抽象。

## 最小预计改动范围
1. 新增 `scripts/run-m2c-demo.js`。
2. 修改 `src/a2a-model-agent.js` 的首次发言判断。
3. 修改 `package.json`，只新增 `m2c:demo`。
4. 在现有测试体系中补首次发言语义的最小测试，覆盖：实例级首次成功、后续延续、失败重试。

不得修改 Ombre continuity、B fake connector、`RoomStore`、server、A2A connector、UI、Tunnel、vault、依赖或 lockfile。若实现时出现可证实的直接 blocker，必须另行批准后才能扩大范围。

## 错误处理
任何一个真实 Agent 启动或回复失败，M2c demo 都直接失败，并清理两个 Agent server 与 room server。绝不静默降级到 fake B。

## 验收标准
1. A、B 都是真实 Codex model Agent。
2. 严格产生 4 条消息，顺序 A→B→A→B。
3. A 首次发言明确自己是“徳牧先生”，并提到“小猫”。
4. A 继续使用 M2b 已验收的 Ombre continuity，并通过同一铜铃确定性召回标记。
5. B 首次发言明确“测试 B”的中性测试身份，不冒充“徳牧先生”，不把“小猫”说成自己的伙伴。
6. 第二次发言时，A、B 都延续本次房间对话，不重复首次自我介绍。
7. 房间最终状态为 `ended`。
8. `npm test` 全绿。
9. 现有 `m2b:demo` 再运行一次仍 PASS。

## 测试层级与硬停止条件
第一层：`npm test` 回归。第二层：真实 `m2c:demo` 双真实 Agent 验收。第三层：`m2b:demo` 回归。三层全部 PASS 即 M2c 完成，随后立即停止，不追加改动或扩张范围。

## 明确非目标
不给 B 接长期记忆；不给 B 接工具；不做真实用户绑定；不抽象双 Agent framework；不改 UI；不做公网部署；不做无限轮聊天；不接 Engineering Bridge；不新增安全层或配置系统；不重构无关代码。

## YAGNI / 边界自检
每个新增步骤都必须直接对应上述改动范围或验收标准。若某一步不是完成既定验收直接所需，则默认不做；不得以未来扩展、通用化、顺手重构或预防性设计为理由扩大 M2c 范围。
