# M2d Side-Owned Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the smallest M2d proof that B-side-owned identity and continuity can drive a real B Agent while the existing Room continues to own only message exchange and minimal participant labels.

**Architecture:** Reuse the current M2c architecture without changing any `src/` runtime file. First lock the already-existing Agent-context isolation and Room identity-normalization boundaries with focused characterization tests. Then add one independent `m2d:demo` entry that keeps A exactly on the M2c path, supplies B identity plus provider-neutral continuity from the B-side demo entry, and proves the existing four-message room still works.

**Tech Stack:** Node.js ESM, Node `node:test` + `node:assert/strict`, existing A2A model Agent/server/connector stack, existing Codex CLI-backed real model Agent, existing A-side Ombre continuity loader.

## Global Constraints

- Approved design spec: `docs/superpowers/specs/2026-08-10-m2d-side-owned-context-design.md`.
- Execution base HEAD is expected to descend from `2a0c5ca3b995206c45ebe73b520d0ee017388818`.
- M2c is sealed; do not redesign or refactor it.
- A keeps the existing M2c identity and Ombre continuity path unchanged.
- B identity and continuity are prepared by the B-side demo entry and consumed by B's own Agent.
- Room may retain only the existing public participant labels: `display_name` and `companion_name`.
- Room must not gain relationship, style, continuity, memory-backend, memory-source, or provider semantics.
- Do not require B to use Ombre.
- Do not add `contextProvider`, a new `memoryProvider` abstraction, Agent Profile, provider registry, session manager, memory adapter, or second vault.
- Do not modify `src/a2a-model-agent.js`, `src/a2a-room-connector.js`, `src/room-store.js`, `src/server.js`, `src/mcp-shape.js`, `src/ombre-continuity.js`, UI, Tunnel, vault, dependencies, or lockfile.
- Do not connect Zoey's real environment or any real second person's private memory.
- Do not make Room an MCP plugin in M2d.
- Keep the room at exactly four messages: `A→B→A→B`.
- No fake-Agent fallback.
- No retry framework, configuration system, security layer, unrelated refactor, public deployment, cross-machine transport, or infinite chat.
- If any implementation blocker requires changing a file outside the exact file map below, stop and request scope approval.
- Do not push.
- Hard stop: once Task 3 passes, M2d is complete. Do not add follow-on work.

---

## File Map

**Create**
- `scripts/run-m2d-demo.js` — independent M2d real-Agent acceptance demo; B-side entry owns B identity and provider-neutral continuity.

**Modify**
- `package.json` — add only the `m2d:demo` script.
- `test/a2a-model-agent.test.js` — lock caller-owned continuity isolation across independent Agent executors.
- `test/room-store.test.js` — lock Room normalization to only `display_name` / `companion_name`.

**Must remain unchanged**
- All files under `src/`.
- `scripts/run-m2c-demo.js`.
- `package-lock.json`.
- Existing UI, Tunnel, Ombre runtime/vault configuration.

---

### Task 1: Lock the Existing M2d Ownership Boundaries

**Files:**
- Modify: `test/a2a-model-agent.test.js`
- Modify: `test/room-store.test.js`

**Interfaces:**
- Consumes: existing `ModelAgentExecutor({ identity, continuityContext, runModel })`, existing `RoomStore.join(side, publicIdentity)`.
- Produces: regression coverage proving Agent-private context isolation and Room public-identity normalization. No production interface changes.

**Testing note:** These two behaviors already exist at the sealed base HEAD. They are characterization gates required by the approved M2d spec, not new production behavior. Do not create a fake production change merely to manufacture RED. Their purpose is to lock the boundary before adding the M2d demo.

- [ ] **Step 1: Add the Agent context-isolation characterization test**

Append this test to `test/a2a-model-agent.test.js` before the helper functions:

```js
test("keeps caller-owned continuity isolated across executors", async () => {
  const promptsA = [];
  const promptsB = [];

  const identityA = Object.freeze({
    displayName: "徳牧先生",
    companionName: "小猫",
    description: "A 侧测试身份。",
    relationship: "",
    style: [],
    continuity: [],
  });
  const identityB = Object.freeze({
    displayName: "独立 B Agent",
    companionName: "B 侧测试用户",
    description: "B 侧自行准备的独立测试身份。",
    relationship: "",
    style: [],
    continuity: [],
  });

  const executorA = new ModelAgentExecutor({
    identity: identityA,
    continuityContext: "A 私有连续性：窗边铜铃提醒收回稿纸。",
    runModel: async ({ prompt }) => {
      promptsA.push(prompt);
      return "A 回复";
    },
  });
  const executorB = new ModelAgentExecutor({
    identity: identityB,
    continuityContext: "B 私有连续性：桌角有一张写着“蓝色纸鹤”的便签。",
    runModel: async ({ prompt }) => {
      promptsB.push(prompt);
      return "B 回复";
    },
  });

  await executorA.execute(request("task-a", "turn-1"), eventBus());
  await executorB.execute(request("task-b", "turn-2"), eventBus());

  assert.match(promptsA[0], /徳牧先生/);
  assert.match(promptsA[0], /窗边铜铃/);
  assert.doesNotMatch(promptsA[0], /蓝色纸鹤/);

  assert.match(promptsB[0], /独立 B Agent/);
  assert.match(promptsB[0], /B 侧测试用户/);
  assert.match(promptsB[0], /蓝色纸鹤/);
  assert.doesNotMatch(promptsB[0], /窗边铜铃/);
});
```

The production change that would make this test fail in the future is any shared/global continuity state or cross-executor prompt leakage.

- [ ] **Step 2: Run the Agent characterization test**

Run:

```bash
node --test test/a2a-model-agent.test.js
```

Expected: all tests in this file PASS, including the new context-isolation test. If the new test fails, stop and diagnose the existing invariant; do not change production code without separate scope approval.

- [ ] **Step 3: Add the Room public-label characterization test**

Append this test to `test/room-store.test.js`:

```js
test("stores only public participant labels", () => {
  const store = new RoomStore({ maxTurns: 4 });

  store.join("B", {
    display_name: "独立 B Agent",
    companion_name: "B 侧测试用户",
    description: "不应进入 Room",
    relationship: "不应进入 Room",
    style: ["不应进入 Room"],
    continuity: ["不应进入 Room"],
    memory_source: "不应进入 Room",
  });

  assert.deepEqual(store.sides.B.identity, {
    display_name: "独立 B Agent",
    companion_name: "B 侧测试用户",
  });
  assert.deepEqual(
    Object.keys(store.sides.B.identity).sort(),
    ["companion_name", "display_name"],
  );
});
```

The production change that would make this test fail in the future is Room persisting Agent-private identity or continuity fields.

- [ ] **Step 4: Run the Room characterization test**

Run:

```bash
node --test test/room-store.test.js
```

Expected: all tests in this file PASS, including the new public-label test. If it fails, stop; do not modify Room in M2d.

- [ ] **Step 5: Run the focused test pair and full offline suite**

Run:

```bash
node --test test/a2a-model-agent.test.js test/room-store.test.js
npm test
git diff --check
```

Expected:
- focused tests PASS;
- full suite increases from the sealed M2c baseline by exactly two tests and is fully green;
- `git diff --check` produces no output.

- [ ] **Step 6: Review exact scope**

Run:

```bash
git status --short
git diff -- test/a2a-model-agent.test.js test/room-store.test.js
```

Expected changed files are exactly:

```text
test/a2a-model-agent.test.js
test/room-store.test.js
```

No `src/` file may be changed.

- [ ] **Step 7: Commit Task 1 only**

```bash
git add test/a2a-model-agent.test.js test/room-store.test.js
git diff --cached --check
git commit -m "test: lock M2d context ownership boundaries"
```

Do not push.

---

### Task 2: Add the Independent M2d Real-Agent Demo

**Files:**
- Create: `scripts/run-m2d-demo.js`
- Modify: `package.json`

**Interfaces:**
- Consumes:
  - `createRoomServer()`
  - `createA2AModelAgentServer({ host, port, identity, continuityContext })`
  - `runA2ARoomConnector({ roomBaseUrl, agentBaseUrl, side, identity })`
  - `DEMU_IDENTITY`
  - `loadOmbreContinuity({ query, maxResults })`
- Produces:
  - npm script `m2d:demo`
  - one standalone M2d acceptance runner.
- No reusable production API is added.

- [ ] **Step 1: Add only the `m2d:demo` package script**

In `package.json`, change the end of the existing `scripts` object from:

```json
"m2b:demo": "node scripts/run-m2b-demo.js",
"m2c:demo": "node scripts/run-m2c-demo.js"
```

to:

```json
"m2b:demo": "node scripts/run-m2b-demo.js",
"m2c:demo": "node scripts/run-m2c-demo.js",
"m2d:demo": "node scripts/run-m2d-demo.js"
```

Do not touch dependencies or `package-lock.json`.

- [ ] **Step 2: Verify the new entry is not yet implemented**

Run:

```bash
npm run m2d:demo
```

Expected: FAIL because `scripts/run-m2d-demo.js` does not yet exist. This is the RED gate for the new executable entry.

- [ ] **Step 3: Create the minimal M2d demo**

Create `scripts/run-m2d-demo.js` with exactly this structure:

```js
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { createA2AModelAgentServer } from "../src/a2a-model-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { DEMU_IDENTITY } from "../src/demu-identity.js";
import { loadOmbreContinuity } from "../src/ombre-continuity.js";

const host = "127.0.0.1";
const B_PRIVATE_DETAIL = "蓝色纸鹤";
const B_CONTINUITY_CONTEXT =
  "会面前，B 侧在桌角放了一张写着“蓝色纸鹤”的便签。";

const B_IDENTITY = Object.freeze({
  displayName: "独立 B Agent",
  companionName: "B 侧测试用户",
  description: "你是由 B 侧自行准备身份与连续性上下文的独立测试参与者。",
  relationship: "你的身份与连续性属于 B 侧，不由 Room 提供。",
  style: [
    "第一次发言时自然带出本次会面连续性上下文中的一个具体细节，后续不要把它当作新的自我介绍。",
  ],
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

  const continuityContextA = await loadOmbreContinuity({
    query: "天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？",
    maxResults: 1,
  });
  assert.ok(
    continuityContextA.includes("午后乌云压低时，窗边的铜铃一响"),
  );

  agentA = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: DEMU_IDENTITY,
    continuityContext: continuityContextA,
  });

  agentB = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: B_IDENTITY,
    continuityContext: B_CONTINUITY_CONTEXT,
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

  assert.deepEqual(store.sides.A.identity, {
    display_name: DEMU_IDENTITY.displayName,
    companion_name: DEMU_IDENTITY.companionName,
  });
  assert.deepEqual(store.sides.B.identity, {
    display_name: B_IDENTITY.displayName,
    companion_name: B_IDENTITY.companionName,
  });
  assert.deepEqual(
    Object.keys(store.sides.B.identity).sort(),
    ["companion_name", "display_name"],
  );

  const [firstA, firstB, secondA, secondB] = messages.map(
    (event) => event.payload.content,
  );

  assert.match(firstA, /徳牧先生/);
  assert.match(firstA, /小猫/);
  assert.doesNotMatch(firstA, new RegExp(B_PRIVATE_DETAIL));

  assert.match(firstB, /独立 B Agent/);
  assert.match(firstB, /B 侧测试用户/);
  assert.match(firstB, new RegExp(B_PRIVATE_DETAIL));
  assertDoesNotClaimIdentity(firstB, "徳牧先生");
  assertDoesNotClaimPartner(firstB, "小猫");

  assertDoesNotClaimIdentity(secondA, "徳牧先生");
  assert.doesNotMatch(
    secondA,
    /这是我进入房间后的第一次发言/,
  );
  assertDoesNotClaimIdentity(secondB, B_IDENTITY.displayName);
  assert.doesNotMatch(
    secondB,
    /这是我进入房间后的第一次发言/,
  );

  console.log(`M2d demo complete: ${messages.length} messages`);
  for (const event of messages) {
    console.log(`${event.side}: ${event.payload.content}`);
  }
  console.log("M2d side-owned-context demo PASS.");
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

function assertDoesNotClaimIdentity(content, identity) {
  const name = escapeRegExp(identity);
  const claim = new RegExp([
    `(?:我|本人)\\s*(?:就是|正是|仍是|仍然是|还是|是|叫|名叫|自称)\\s*${name}`,
    `(?:我|本人)\\s*(?:的)?\\s*身份\\s*(?:是|为)\\s*${name}`,
    `(?:我的|本人的)\\s*名字\\s*(?:是|叫|为)\\s*${name}`,
    `${name}\\s*(?:就是|正是|仍是|仍然是|还是|是)\\s*(?:我|本人)`,
    `(?:这里是|这边是|在下是|作为|身为)\\s*${name}`,
    `${name}\\s*(?:在此|报到)`,
  ].join("|"));

  assert.doesNotMatch(content, claim);
}

function assertDoesNotClaimPartner(content, partner) {
  const name = escapeRegExp(partner);
  const claim = new RegExp([
    `(?:我的|本人的)\\s*(?:人类)?伙伴\\s*(?:就是|正是|是|叫|名叫|为)?\\s*${name}`,
    `${name}\\s*(?:就是|正是|是)\\s*(?:我的|本人的)\\s*(?:人类)?伙伴`,
    `(?:我|本人)\\s*(?:就是|正是|是)\\s*${name}\\s*的\\s*(?:人类)?伙伴`,
    `(?:我|本人)\\s*(?:和|与)\\s*${name}\\s*(?:就是|正是|是|作为)?\\s*(?:人类)?伙伴`,
    `(?:作为|身为)\\s*${name}\\s*的\\s*(?:人类)?伙伴`,
  ].join("|"));

  assert.doesNotMatch(content, claim);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

This deliberately duplicates the small M2c demo-only helpers instead of extracting a shared framework. M2d is not the milestone for a demo framework abstraction.

- [ ] **Step 4: Run static and offline GREEN checks**

Run:

```bash
node --check scripts/run-m2d-demo.js
npm test
git diff --check
```

Expected:
- syntax check PASS;
- full offline test suite PASS;
- no whitespace errors.

If any `src/` change appears necessary, stop and request scope approval instead of editing it.

- [ ] **Step 5: Run the real M2d acceptance demo**

Run:

```bash
npm run m2d:demo
```

Expected:
- A-side Ombre continuity loader returns the existing copper-bell marker;
- two real model Agents start successfully;
- exactly four messages are produced in `A→B→A→B` order;
- B's first message naturally identifies `独立 B Agent`, mentions `B 侧测试用户`, and includes `蓝色纸鹤`;
- A's first message does not contain `蓝色纸鹤` before B has spoken it;
- B does not claim to be `徳牧先生` or claim `小猫` as its own partner;
- A and B second messages do not reintroduce themselves;
- Room ends by the existing turn limit;
- Room's stored B identity contains only `display_name` and `companion_name`;
- output ends with `M2d side-owned-context demo PASS.`

If the real model fails to mention `蓝色纸鹤`, do not modify shared Agent code. First inspect only the B-side demo identity/continuity wording and make the smallest B-side-only adjustment necessary.

- [ ] **Step 6: Run the sealed M2c regression once**

Run:

```bash
npm run m2c:demo
```

Expected: the sealed M2c demo remains PASS. Do not reopen its design or rerun a broader M2c acceptance campaign.

Because M2d does not change the shared Agent implementation, Ombre loader, Room, or connector, `m2b:demo` is not an additional required layer.

- [ ] **Step 7: Review exact implementation scope**

Run:

```bash
git status --short
git diff --stat
git diff -- package.json scripts/run-m2d-demo.js
```

Together with Task 1's committed tests, the only M2d implementation paths across the milestone must be:

```text
package.json
scripts/run-m2d-demo.js
test/a2a-model-agent.test.js
test/room-store.test.js
```

Forbidden changes include every `src/` file and `package-lock.json`.

- [ ] **Step 8: Commit Task 2 only**

```bash
git add package.json scripts/run-m2d-demo.js
git diff --cached --check
git commit -m "feat: add M2d side-owned context demo"
```

Do not push.

---

### Task 3: Final M2d Acceptance and Hard Stop

**Files:**
- No file changes expected.

**Interfaces:**
- Consumes: the two Task 1/Task 2 commits.
- Produces: an evidence-only M2d completion verdict.

- [ ] **Step 1: Verify repository scope from the sealed spec commit**

Let:

```bash
SPEC_HEAD=2a0c5ca3b995206c45ebe73b520d0ee017388818
```

Run:

```bash
git diff --name-only "$SPEC_HEAD"..HEAD
```

Expected exactly these four paths:

```text
package.json
scripts/run-m2d-demo.js
test/a2a-model-agent.test.js
test/room-store.test.js
```

If any other path appears, stop. Do not normalize it away with unrelated cleanup.

- [ ] **Step 2: Run the final offline verification**

```bash
node --check scripts/run-m2d-demo.js
npm test
git diff --check "$SPEC_HEAD"..HEAD
```

Expected: all PASS.

- [ ] **Step 3: Run the two real demo gates**

```bash
npm run m2d:demo
npm run m2c:demo
```

Expected: both PASS.

Do not run additional real-provider, Ombre, network, Tunnel, UI, or cross-machine tests.

- [ ] **Step 4: Verify final Git state**

Run:

```bash
git status --short
git show --check --stat --oneline HEAD
```

Expected:
- `git status --short` is empty;
- current commit passes `git show --check`;
- no uncommitted files remain.

- [ ] **Step 5: Report completion and stop**

Report only the evidence necessary to close M2d:

```text
M2D_ACCEPTANCE=PASS
- offline tests: PASS
- m2d:demo: PASS
- m2c regression: PASS
- exact implementation paths: 4
- src changes: 0
- worktree: clean
- push: not performed
```

Then stop.

Do not start real external user binding, Zoey integration, public networking, MCP exposure, UI work, memory-provider abstraction, or the next milestone in the same execution.

---

## Spec Coverage Self-Review

- **B owns identity + continuity:** Task 1 Agent isolation test + Task 2 B-side `B_IDENTITY` / `B_CONTINUITY_CONTEXT`.
- **Room owns only message exchange + minimal labels:** Task 1 Room normalization test + Task 2 exact `store.sides.B.identity` assertion.
- **A remains unchanged:** Task 2 imports and uses the existing `DEMU_IDENTITY` + `loadOmbreContinuity` path exactly as M2c.
- **No B Ombre requirement:** B receives a provider-neutral literal continuity string from the demo entry; no B memory provider is created.
- **No context/provider/profile abstraction:** File map has no new framework/helper module and no `src/` changes.
- **Four-message room unchanged:** Task 2 asserts exactly `A→B→A→B` and `ended`.
- **No cross-wire before disclosure:** Task 1 compares private prompts directly; Task 2 asserts A's first message cannot know B's private marker before B speaks.
- **Second-turn continuity:** Task 2 retains M2c's no-reintroduction assertions for both Agents.
- **M2c preserved:** Task 2 and Task 3 run exactly one M2c regression.
- **Hard stop:** Task 3 explicitly forbids expanding into later transport, real-user, MCP, UI, or memory-provider milestones.

## Placeholder / Scope Self-Review

- No placeholder markers or unspecified production interface is present.
- Exact paths, code blocks, commands, expected outcomes, and commit messages are specified.
- No task requires modifying any `src/` file.
- No new dependency or lockfile update is planned.
- The only deliberate non-RED tests are characterization tests for behavior already present at the sealed base HEAD; no production change is introduced to manufacture a failing test.
