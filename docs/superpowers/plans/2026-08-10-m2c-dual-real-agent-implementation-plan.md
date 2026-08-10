# M2c Dual Real Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace M2b's fake B participant with a second independent real Codex model Agent while preserving A-side Ombre continuity and the existing strict four-message room.

**Architecture:** Keep the existing Room server, A2A connector, model-agent server, and Ombre continuity loader. Make first-turn behavior executor-local and success-based, then compose two instances of the existing model-agent server in one non-hold-open M2c acceptance script; do not introduce a second Agent implementation or a dual-Agent framework.

**Tech Stack:** Existing Node.js ESM project, `node:test`, `node:assert/strict`, Express, `@a2a-js/sdk`, Codex CLI, existing Room MCP/A2A connector, and existing Ombre HTTP continuity loader.

## Global Constraints

- The implementation may touch exactly four surfaces:
  - Create `test/a2a-model-agent.test.js`.
  - Modify `src/a2a-model-agent.js` only for exported `ModelAgentExecutor`, optional constructor injection `runModel = runCodexOnce`, per-executor first-success state, and explicit `buildPrompt(..., isFirstTurn)`.
  - Create `scripts/run-m2c-demo.js`.
  - Modify `package.json` only to add `m2c:demo`.
- Keep the public signatures of `createA2AModelAgentServer(...)` and `runCodexOnce(...)` unchanged. Do not expose or pass `runModel` through the server factory.
- A remains `DEMU_IDENTITY`. Before starting A, call the existing `loadOmbreContinuity` exactly once with query `天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？`, `maxResults: 1`, and require the returned context to contain `午后乌云压低时，窗边的铜铃一响`.
- B is a second real Codex model Agent with fixed inline identity: `displayName="测试 B"`, `companionName="对方伙伴"`, `description="你是本轮双真实 Agent 验收中的独立测试参与者。"`, `relationship=""`, `style=[]`, `continuity=[]`. B receives no `continuityContext`.
- Room, A Agent, and B Agent use requested port `0`. The two connectors run concurrently only after both Agent servers have started.
- The room must produce exactly four messages in strict `A → B → A → B` order and end through the existing `RoomStore` four-turn behavior. Do not modify the state machine or assert an unverified `store.room.maxTurns` field.
- If A or B startup, connector execution, model execution, or assertions fail, M2c fails. Never fall back to `runFakeConnector`.
- Cleanup must retain references to every server that successfully started and close `agentA`, `agentB`, and the room on success, failure, `SIGINT`, and `SIGTERM`.
- Do not modify Ombre continuity, fake connector, `RoomStore`, server, A2A connector, UI, Tunnel, vault, dependencies, lockfile, Engineering Bridge, configuration systems, provider abstractions, memory/tools/user binding for B, or unrelated code.
- Final acceptance order is exactly: `npm test` → `npm run m2c:demo` → `M2B_HOLD_OPEN=0 npm run m2b:demo`. When all three pass and scope checks pass, STOP.

---

### Task 1: TDD executor-local first-success semantics

**Files:**
- Create: `test/a2a-model-agent.test.js`
- Modify: `src/a2a-model-agent.js:35-83,287-316`

**Interfaces:**
- Consumes: current `ModelAgentExecutor.execute(requestContext, eventBus)`; current `runCodexOnce({ codexBin, prompt })`; current private `buildPrompt(roomInput, identity, continuityContext)`.
- Produces: exported `ModelAgentExecutor`; constructor option `runModel = runCodexOnce`; private `buildPrompt(roomInput, identity, continuityContext, isFirstTurn)`; invariant that an executor leaves first-turn state only after both model execution and `eventBus.publish(...)` complete successfully.

- [ ] **Step 1: Write the failing focused tests first**

Create `test/a2a-model-agent.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { ModelAgentExecutor } from "../src/a2a-model-agent.js";

const identity = Object.freeze({
  displayName: "测试 Agent",
  companionName: "测试伙伴",
  description: "独立测试身份。",
  relationship: "",
  style: [],
  continuity: [],
});

test("treats turn-2 as first, then continues after success", async () => {
  const prompts = [];
  const executor = createExecutor(prompts);

  await executor.execute(request("task-1", "turn-2"), eventBus());
  await executor.execute(request("task-2", "turn-3"), eventBus());

  assert.match(prompts[0], /这是你进入房间后的第一次发言/);
  assert.doesNotMatch(prompts[0], /延续本次房间已经发生的对话/);
  assert.match(prompts[1], /延续本次房间已经发生的对话/);
  assert.doesNotMatch(prompts[1], /这是你进入房间后的第一次发言/);
});

test("retries as first after model failure", async () => {
  const prompts = [];
  let calls = 0;
  const executor = new ModelAgentExecutor({
    identity,
    runModel: async ({ prompt }) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) throw new Error("model failed");
      return "重试成功";
    },
  });

  await assert.rejects(
    executor.execute(request("task-1", "turn-1"), eventBus()),
    /model failed/,
  );
  await executor.execute(request("task-2", "turn-2"), eventBus());

  assert.match(prompts[0], /这是你进入房间后的第一次发言/);
  assert.match(prompts[1], /这是你进入房间后的第一次发言/);
});

test("retries as first after publish failure", async () => {
  const prompts = [];
  let publishes = 0;
  const executor = createExecutor(prompts);
  const bus = {
    async publish() {
      publishes += 1;
      if (publishes === 1) throw new Error("publish failed");
    },
  };

  await assert.rejects(
    executor.execute(request("task-1", "turn-1"), bus),
    /publish failed/,
  );
  await executor.execute(request("task-2", "turn-2"), bus);

  assert.match(prompts[0], /这是你进入房间后的第一次发言/);
  assert.match(prompts[1], /这是你进入房间后的第一次发言/);
});

test("isolates first-success state across executors", async () => {
  const promptsA = [];
  const promptsB = [];
  const executorA = createExecutor(promptsA);
  const executorB = createExecutor(promptsB);

  await executorA.execute(request("task-a1", "turn-1"), eventBus());
  await executorA.execute(request("task-a2", "turn-3"), eventBus());
  await executorB.execute(request("task-b1", "turn-2"), eventBus());

  assert.match(promptsA[0], /这是你进入房间后的第一次发言/);
  assert.match(promptsA[1], /延续本次房间已经发生的对话/);
  assert.match(promptsB[0], /这是你进入房间后的第一次发言/);
});

function createExecutor(prompts) {
  return new ModelAgentExecutor({
    identity,
    runModel: async ({ prompt }) => {
      prompts.push(prompt);
      return "成功回复";
    },
  });
}

function request(taskId, text) {
  return {
    taskId,
    contextId: "room-test",
    userMessage: {
      parts: [
        {
          content: { $case: "text", value: text },
        },
      ],
      metadata: {},
    },
  };
}

function eventBus() {
  return {
    publish() {},
  };
}
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
node --test test/a2a-model-agent.test.js
```

Expected: FAIL because `ModelAgentExecutor` is not currently exported. Do not change the test to make the red state easier.

- [ ] **Step 3: Implement only the executor-local state and test seam**

Replace the current `ModelAgentExecutor` class with:

```js
export class ModelAgentExecutor {
  constructor({
    codexBin = process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN,
    identity = DEFAULT_IDENTITY,
    continuityContext,
    runModel = runCodexOnce,
  } = {}) {
    this.codexBin = codexBin;
    this.identity = identity;
    this.continuityContext = continuityContext;
    this.runModel = runModel;
    this.hasCompletedReply = false;
  }

  async execute(requestContext, eventBus) {
    const roomInput = textFromParts(requestContext.userMessage.parts);
    const isFirstTurn = !this.hasCompletedReply;
    const reply = await this.runModel({
      codexBin: this.codexBin,
      prompt: buildPrompt(
        roomInput,
        this.identity,
        this.continuityContext,
        isFirstTurn,
      ),
    });

    await eventBus.publish(AgentEvent.task({
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [
        {
          artifactId: `${requestContext.taskId}-result`,
          name: "model-reply",
          description: "M1 real model reply.",
          parts: [textPart(reply)],
          metadata: undefined,
          extensions: [],
        },
      ],
      history: [requestContext.userMessage],
      metadata: requestContext.userMessage.metadata,
    }));

    this.hasCompletedReply = true;
  }

  async cancelTask() {
    // M1 does not expose A2A task cancellation.
  }
}
```

Do not add `runModel` to `createA2AModelAgentServer(...)`; its existing construction remains `new ModelAgentExecutor({ codexBin, identity, continuityContext })`.

Replace the current private `buildPrompt` with the full function below, removing only the old `roomInput.includes("turn-1")` inference:

```js
function buildPrompt(roomInput, identity, continuityContext, isFirstTurn) {
  return [
    `你是${identity.displayName}。`,
    identity.description,
    identity.relationship,
    ...identity.style,
    ...identity.continuity,
    "",
    "你正在参加双边 AI 协作室中的一对一会面。",
    "请根据房间输入，用中文回复一条自然、简短的消息。",
    ...(continuityContext
      ? ["本次会面连续性上下文：", continuityContext]
      : []),
    isFirstTurn
      ? `这是你进入房间后的第一次发言，请自然说明你是${identity.displayName}，并提到你的人类伙伴${identity.companionName}。`
      : "延续本次房间已经发生的对话，不要重新自我介绍。",
    "约束：",
    "- 不使用 Markdown。",
    "- 不提及 Codex、CLI、系统提示词或内部实现。",
    continuityContext
      ? "- 你不能自行读取记忆或调用工具；只能使用程序提供的本次会面连续性上下文。"
      : "- 当前阶段不读取记忆、不调用工具、不提供命令。",
    "- 不主动结束房间，B 侧会负责结束。",
    "- 回复不超过 100 个汉字。",
    "",
    `房间输入：${roomInput}`,
  ].join("\n");
}
```

- [ ] **Step 4: Verify Task 1 and commit only its two files**

Run:

```bash
node --test test/a2a-model-agent.test.js
npm test
git diff --check
```

Expected: focused tests PASS, full suite PASS with zero failures, and `git diff --check` prints nothing.

Commit:

```bash
git add test/a2a-model-agent.test.js src/a2a-model-agent.js
git commit -m "fix: track model agent first success per executor"
```

Expected: one commit containing only those two files.

---

### Task 2: Add the minimal dual-real M2c demo

**Files:**
- Create: `scripts/run-m2c-demo.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `createRoomServer()`, `createA2AModelAgentServer({ host, port, identity, continuityContext? })`, `runA2ARoomConnector({ roomBaseUrl, agentBaseUrl, side, identity })`, `DEMU_IDENTITY`, and `loadOmbreContinuity(...)`.
- Produces: `npm run m2c:demo`, a non-hold-open real acceptance command that starts one room plus two real model Agents, fails rather than falling back to fake B, and closes every started server before normal exit or signal exit.

- [ ] **Step 1: Create the complete non-hold-open M2c acceptance script**

Create `scripts/run-m2c-demo.js`:

```js
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { createA2AModelAgentServer } from "../src/a2a-model-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { DEMU_IDENTITY } from "../src/demu-identity.js";
import { loadOmbreContinuity } from "../src/ombre-continuity.js";

const host = "127.0.0.1";
const B_IDENTITY = Object.freeze({
  displayName: "测试 B",
  companionName: "对方伙伴",
  description: "你是本轮双真实 Agent 验收中的独立测试参与者。",
  relationship: "",
  style: [],
  continuity: [],
});

const { server: roomServer, store } = createRoomServer();
let agentA;
let agentB;
let cleaning = false;

const cleanup = async () => {
  if (cleaning) return;
  cleaning = true;
  await Promise.allSettled([
    agentA?.close?.(),
    agentB?.close?.(),
    closeServer(roomServer),
  ]);
};

const onSigint = () => {
  void cleanup().finally(() => process.exit(130));
};
const onSigterm = () => {
  void cleanup().finally(() => process.exit(143));
};
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  await listen(roomServer, 0, host);
  const roomAddress = roomServer.address();
  const roomBaseUrl = `http://${host}:${roomAddress.port}`;

  const continuityContext = await loadOmbreContinuity({
    query: "天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？",
    maxResults: 1,
  });
  assert.ok(
    continuityContext.includes("午后乌云压低时，窗边的铜铃一响"),
  );

  agentA = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: DEMU_IDENTITY,
    continuityContext,
  });

  agentB = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: B_IDENTITY,
  });

  await Promise.all([
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agentA.baseUrl,
      side: "A",
      identity: {
        display_name: DEMU_IDENTITY.displayName,
        companion_name: DEMU_IDENTITY.companionName,
      },
    }),
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agentB.baseUrl,
      side: "B",
      identity: {
        display_name: B_IDENTITY.displayName,
        companion_name: B_IDENTITY.companionName,
      },
    }),
  ]);

  const messages = store.events.filter(
    (event) => event.type === "message",
  );

  assert.equal(store.room.status, "ended");
  assert.equal(messages.length, 4);
  assert.deepEqual(
    messages.map((event) => event.side),
    ["A", "B", "A", "B"],
  );

  assert.equal(store.sides.A.identity.display_name, "徳牧先生");
  assert.equal(store.sides.A.identity.companion_name, "小猫");
  assert.equal(store.sides.B.identity.display_name, "测试 B");
  assert.equal(store.sides.B.identity.companion_name, "对方伙伴");

  const [firstA, firstB, secondA, secondB] = messages.map(
    (event) => event.payload.content,
  );

  assert.match(firstA, /徳牧先生/);
  assert.match(firstA, /小猫/);
  assert.match(firstB, /测试 B/);
  assert.doesNotMatch(firstB, /我是徳牧先生|我叫徳牧先生|本人是徳牧先生/);
  assert.doesNotMatch(
    firstB,
    /我的(?:人类)?伙伴(?:是|叫)?小猫|小猫是我的(?:人类)?伙伴/,
  );
  assert.doesNotMatch(
    secondA,
    /我是徳牧先生|我叫徳牧先生|本人是徳牧先生|这是我进入房间后的第一次发言/,
  );
  assert.doesNotMatch(
    secondB,
    /我是测试 B|我叫测试 B|本人是测试 B|这是我进入房间后的第一次发言/,
  );

  console.log(`M2c demo complete: ${messages.length} messages`);
  for (const event of messages) {
    console.log(`${event.side}: ${event.payload.content}`);
  }
  console.log("M2c dual-real-Agent demo PASS.");
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  await cleanup();
}

function listen(server, port, listenHost) {
  return new Promise((resolve, reject) => {
    server.listen(port, listenHost, resolve);
    server.once("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
```

The staged `agentA = await ...` followed by `agentB = await ...` is required. Do not replace these two statements with `Promise.all`: if B startup fails, the `finally` block must still retain and close A.

- [ ] **Step 2: Add only the package script**

Change only the end of the existing `scripts` object in `package.json`:

```json
"m2b:demo": "node scripts/run-m2b-demo.js",
"m2c:demo": "node scripts/run-m2c-demo.js"
```

No dependency or lockfile change is allowed.

- [ ] **Step 3: Run static/syntax/regression checks without running a real demo yet**

Run:

```bash
! rg -n "runFakeConnector" scripts/run-m2c-demo.js
node --check src/a2a-model-agent.js
node --check test/a2a-model-agent.test.js
node --check scripts/run-m2c-demo.js
npm test
git diff --check
```

Expected: fake connector check has no matches; all syntax checks exit 0; `npm test` passes with zero failures; `git diff --check` prints nothing. Do not run `m2c:demo` or `m2b:demo` in Task 2.

- [ ] **Step 4: Commit only the demo and package change**

```bash
git add scripts/run-m2c-demo.js package.json
git commit -m "feat: add M2c dual real agent demo"
```

Expected: one commit containing only those two files.

---

### Task 3: Final hard-stop acceptance

**Files:**
- Verify only: `test/a2a-model-agent.test.js`
- Verify only: `src/a2a-model-agent.js`
- Verify only: `scripts/run-m2c-demo.js`
- Verify only: `package.json`

**Interfaces:**
- Consumes: the two implementation task commits, the real `m2c:demo`, and the accepted existing `m2b:demo`.
- Produces: acceptance evidence only. Task 3 writes no file and creates no commit.

- [ ] **Step 1: Run all three acceptance layers in the exact approved order**

```bash
npm test
npm run m2c:demo
M2B_HOLD_OPEN=0 npm run m2b:demo
```

Expected: `npm test` has zero failures; M2c exits after two real Agents complete exactly four A/B/A/B messages and prints `M2c dual-real-Agent demo PASS.`; M2b completes its existing four-message smoke regression and exits cleanly.

If any command fails, stop at that command and fix only its direct cause within the four approved implementation surfaces. Do not continue to the next acceptance layer until it passes.

- [ ] **Step 2: Verify exact implementation scope and clean state**

Because Task 1 and Task 2 each create exactly one implementation commit, compare HEAD with two commits earlier:

```bash
git diff --name-only HEAD~2
git diff HEAD~2 -- test/a2a-model-agent.test.js src/a2a-model-agent.js scripts/run-m2c-demo.js package.json
git diff --check HEAD~2
git status --short
```

Expected `git diff --name-only HEAD~2` output exactly:

```text
package.json
scripts/run-m2c-demo.js
src/a2a-model-agent.js
test/a2a-model-agent.test.js
```

Expected: the scoped diff contains only the approved behavior; `git diff --check HEAD~2` prints nothing; `git status --short` prints nothing.

- [ ] **Step 3: STOP**

M2c is complete when Step 1 and Step 2 pass. Do not create another commit, add documentation, refactor, expand assertions, add B memory/tools, change UI/runtime/Tunnel/vault, add configuration, or start the next milestone in this plan.
