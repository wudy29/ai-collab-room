# M2d Side-Owned Context 最小设计

日期：2026-08-10

## 1. 背景

当前仓库：`/Users/mac/Downloads/ai-collab-room-m0`

M2c 已正式完成并封口，当前已知基线 HEAD：

`9f21de3044903ce5ae1a9c2ef11a31ddc11727c4`

M2c 已证明：

- A、B 均可作为真实 Codex model Agent 进入同一房间；
- 严格完成四条消息 `A→B→A→B`；
- A 使用既有“徳牧先生 / 小猫”身份与 M2b Ombre continuity；
- B 仍是项目内测试身份“测试 B / 对方伙伴”；
- A/B 第二轮均能延续本次会面；
- Room 最终 `ended`。

M2d 不重新打开、修改目标或重复验收 M2c。M2d 只处理 M2c 之后尚未证明的一件事：**B 侧应拥有自己的身份与连续性上下文，而 Room 不应拥有或规定 B 如何形成这些上下文。**

## 2. 核心原则

> **Room owns messages, not agents.**  
> **房间负责消息交换，不拥有 Agent。**

更精确地说：

- Room 可以继续保存既有的最小参会标签，例如 `display_name` / `companion_name`，用于识别房间参与者；
- B 的完整身份上下文属于 B Agent 自己，包括 description、relationship、style、continuity 等；
- Room 不解析、不生成、不管理 B 的 continuity；
- Room 不知道也不规定 B 是否使用 Ombre、原生 session、MCP、数据库、长期记忆系统、静态上下文或其他机制；
- A 保持既有 M2b/M2c 路线，不为了形式对称而重构。

## 3. M2d 唯一目标

证明：

> **一个由 B 侧自行准备好 identity + continuity context 的真实 Agent，可以进入现有房间，与 A 完成既有四消息会面；Room 只处理消息与最小参会标签，不需要知道 B 的连续性来自哪里。**

M2d 不负责证明 B 的记忆系统本身可靠，也不负责调用或验证 B 的 memory backend。

## 4. 最小数据流

```text
B 侧自己的入口
    │
    ├─ displayName
    ├─ companionName
    ├─ description
    ├─ relationship
    ├─ style
    └─ continuity
          │
          ▼
    B Real Agent
          │
          │ 生成最终消息
          ▼
    A2A connector
          │
          ├─ 给 Room：消息
          └─ 给 Room：最小参会标签
                     display_name / companion_name
          ▼
        Room
```

A 侧保持既有链路：

```text
A 侧既有身份 + Ombre continuity
          │
          ▼
    A Real Agent
          │
          ▼
    A2A connector
          │
          ▼
        Room
```

M2d 不把 A/B 做成强制对称架构。

## 5. B 侧上下文所有权

M2d demo 中，B 的 identity + continuity 由 **B 侧 demo 入口**准备，并在创建 B Agent 时交给现有 Agent 创建入口。

M2d 不新增统一的：

- `contextProvider`
- `memoryProvider` 抽象层
- Agent Profile 协议
- provider registry
- session manager
- memory adapter

若当前 HEAD 已有足以承载 B identity/continuity 的既有 identity 字段，则直接复用，不新增第二套 context 接口。

B 的测试 continuity 使用一条**确定性的、仅属于 B 的上下文细节**，用于验收 B Agent 确实消费了自己一侧提供的 continuity。该细节不伪装成 Ombre 记忆，也不声明来自任何真实人物或真实记忆系统。

## 6. Room 边界

Room / RoomStore / A2A connector 的职责保持不变：

- 接收参与者；
- 保存既有最小参与者标签；
- 交换消息；
- 维持既有四消息顺序与结束状态。

Room 不得获得或新增以下 B 侧信息：

- relationship 正文；
- style 正文；
- continuity 正文；
- memory backend 类型；
- memory backend 地址或凭据；
- continuity 来源；
- B 侧如何准备上下文的实现信息。

因此，“Room 不拥有 B 的身份”在 M2d 中的准确含义是：

> **Room 可以知道 B 叫什么，但不拥有 B 是谁、如何形成自己、如何记得。**

## 7. 共享 Agent 语义

M2d 优先复用 M2c 已存在的真实 Agent 实现。

原则上不修改 `src/a2a-model-agent.js`。

只有在实施前对当前 HEAD 的只读检查明确证明：**共享 Agent prompt 对通用 continuity 字段仍存在 Ombre 专属来源表述，并且该表述会直接把 B 的非 Ombre continuity 错误描述为 Ombre 内容**，才允许做一处最小语义泛化。

允许的修正仅限：

- 把 provider-specific 的“Ombre 记忆上下文”改成 provider-neutral 的“会面连续性上下文”或同义中性表述。

不允许借此：

- 抽象 provider；
- 新增 memory interface；
- 改写 A 的 Ombre loader；
- 改变已有 meeting/session 行为；
- 重构 prompt builder。

如果当前 HEAD 已无该问题，则 `src/a2a-model-agent.js` 保持零改动。

## 8. 预计最小改动范围

预期：

1. `package.json`
   - 仅新增 `m2d:demo` script。

2. `scripts/run-m2d-demo.js`
   - 新增独立 M2d demo；
   - A 沿用 M2c 现状；
   - B 在 B 侧入口准备自己的 identity + continuity；
   - B 使用现有真实 Agent 创建入口；
   - 不修改 M2c demo。

3. 现有测试文件中的最小测试
   - 证明 B Agent 消费 B 侧提供的 continuity；
   - 证明 Room 只得到既有最小参会标签；
   - 证明 A/B context 不串线。

4. `src/a2a-model-agent.js`
   - 默认不改；
   - 仅在第 7 节定义的“现有共享 prompt 把通用 continuity 错写成 Ombre 来源”这一直接 blocker 被当前 HEAD 证实时，允许一处纯语义泛化。

不得因为实现方便扩大到其他文件。若出现第 7 节之外的 blocker，停止并重新批准范围。

## 9. 验收标准

M2d 完成必须同时满足：

1. A 保持 M2c 既有真实 Agent、身份与 Ombre continuity 路线，不为 M2d 做对称性重构。
2. B 是真实 model Agent，不再以 M2c 的“测试 B / 对方伙伴”作为 M2d 的最终测试身份。
3. B 的完整 identity + continuity 由 B 侧 demo 入口提供给 B Agent，而不是由 Room 生成。
4. B 首轮回复自然体现 B 自己的身份，并体现一条由 B 侧提供的确定性 continuity 细节。
5. A 不得说出 B 的私有 continuity 细节；B 不得把 A 的“徳牧先生 / 小猫 / 铜铃”连续性当成自己的身份或记忆。
6. Room 中 B 的参与者元数据仍只使用既有最小标签；Room 不新增 relationship/style/continuity/memory-source 字段。
7. 消息仍严格为四条 `A→B→A→B`。
8. A、B 第二轮均延续当前会面，不重复首次自我介绍。
9. Room 最终状态为 `ended`。
10. `npm test` 全绿。
11. `npm run m2d:demo` PASS。
12. 现有 `m2c:demo` 回归 PASS。
13. 如第 7 节触发共享 prompt 的一处语义泛化，现有 `m2b:demo` 额外回归 PASS；若未触发，则不为了“更完整”额外增加回归层。
14. 工作树在最终 commit 后干净。

## 10. 明确非目标

M2d 不做：

- 不给 B 接 Ombre；
- 不启动或唤醒“执”；
- 不接任何真实第二人物的私人记忆；
- 不验证 B 的 memory backend；
- 不规定 B 应使用何种记忆系统；
- 不新增第二套 Ombre / vault；
- 不新增统一 memory/provider/context framework；
- 不建立 Agent Profile 标准；
- 不建立 provider registry；
- 不建立 session manager；
- 不做真实第二用户绑定；
- 不接 Zoey 的真实环境；
- 不做公网或跨机器接入；
- 不把 Room MCP 化；
- 不改 UI；
- 不增加消息轮数；
- 不做无限聊天；
- 不改 Room state machine；
- 不改 Tunnel；
- 不新增安全层、权限系统或配置中心；
- 不重构 M2c；
- 不重新验收已经封口的 M2c，只做必要的 M2d 回归。

## 11. 错误处理

沿用现有 demo 的直接失败策略：

- 任一真实 Agent 启动失败：M2d demo 失败；
- 任一 Agent 回复失败：M2d demo 失败；
- 四消息顺序、身份、continuity 隔离或结束状态不符合验收：M2d demo 失败；
- 不静默降级为 fake Agent；
- 不为了失败场景新增重试系统、fallback provider 或恢复框架。

## 12. 测试策略与硬停止

测试只证明 M2d 新增语义：

- B 侧拥有自己的 identity + continuity；
- Room 不拥有 B 的完整 context；
- A/B 不串线；
- 既有四消息房间仍成立。

达到第 9 节验收标准后立即停止。

不得因为以下理由继续增加工作：

- “以后可能跨机器”；
- “以后可能接 Claude / ChatGPT / 其他 Agent”；
- “以后可能需要统一 profile”；
- “以后可能每回合动态查记忆”；
- “以后可能做 MCP 插件”；
- “左右两边最好架构完全对称”。

这些属于后续独立里程碑，只有真实需求出现后再设计。

## 13. M2d 完成后的意义

M2d 不是“让 B 也拥有 Ombre”。

M2d 证明的是更基础也更重要的边界：

> **双方 Agent 在进入 Room 之前已经各自成为自己。Room 只负责让他们见面和交换消息。**

因此未来真实 B 侧可以自行选择 Ombre、原生 session、其他 MCP、数据库、长期上下文或任何别的连续性实现，而不需要修改 Room 核心。
