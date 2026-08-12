# M2E Two-Machine Private SSH Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one manual M2E validation command that consumes two already-running A2A Agent base URLs, starts only a local existing Room surface, and proves exactly four non-empty messages flow in `A → B → A → B` order.

**Architecture:** The runner starts `createRoomServer()` on `127.0.0.1` with an ephemeral port, then runs two existing `runA2ARoomConnector(...)` instances concurrently against caller-provided `AGENT_A_URL` and `AGENT_B_URL`. It neither creates A2A Agents nor configures transport. The executable keeps only the completed local Room open for human observation until `SIGINT` or `SIGTERM`; the exported runner is independently testable and returns its Room closer.

**Tech Stack:** Node.js ESM, Node `node:test` and `node:assert/strict`, existing Room server, existing A2A Room connector, existing deterministic A2A test-Agent fixture.

## Global Constraints

- Approved design spec: `docs/superpowers/specs/2026-08-12-m2e-two-machine-private-ssh-validation-design.md`.
- Keep this strictly to today's two-machine validation window.
- Add no Room-core, Room-MCP, Local Agent Edge, Generic CLI Driver, onboarding, dependency, lockfile, UI, tunnel, pairing, invite, authentication, cloud, or deployment change.
- The runner must consume exactly two existing A2A base URLs from `AGENT_A_URL` and `AGENT_B_URL`; it must not start real, fake, model, or test A2A Agents.
- The regression test may start existing deterministic A2A test-Agent fixtures before calling the runner. Those fixtures are test setup, not runner behavior.
- Reuse `runA2ARoomConnector({ roomBaseUrl, agentBaseUrl, side, identity })` unchanged. Do not copy or alter connector protocol semantics.
- The Room remains limited by its existing default `maxTurns: 4`; success requires exactly four `message` events in `A`, `B`, `A`, `B` order, each with non-empty trimmed `payload.content`.
- SSH reverse forwarding, SSH local forwarding, and all Edge lifecycle actions remain manual external setup. Do not add shell automation, configuration, process management, or tunnel commands to project code.
- On normal manual stop, close only the Room started by this runner. Do not close either externally owned Agent endpoint.
- Do not add retries, fallback Agents, transport probing, a reusable validation framework, or a second conversation mode.
- If implementation requires changing a file outside the exact file map below, stop and request scope approval.
- Do not push.
- Hard stop: once this task's focused regression, full suite, diff check, and manual teardown validation pass, M2E is complete.

## File Map

**Create**

- `scripts/run-m2e-two-machine-private-ssh-validation.js` — thin Room-only M2E validation runner and manual executable.
- `test/m2e-two-machine-private-ssh-validation.test.js` — focused runner regression using two pre-started existing deterministic A2A endpoints.

**Modify**

- `package.json` — add one `m2e:validate` script.

**Must remain unchanged**

- `src/room-store.js`
- `src/server.js`
- `src/a2a-room-connector.js`
- all `local-agent-edge/` files
- all existing demo scripts, including `scripts/run-m2c-demo.js`
- `package-lock.json`
- all onboarding, UI, tunnel, cloud, and deployment files

---

### Task 1: Add the Thin Two-Endpoint Validation Runner, Regression Test, and Manual Command

**Files:**

- Create: `scripts/run-m2e-two-machine-private-ssh-validation.js`
- Create: `test/m2e-two-machine-private-ssh-validation.test.js`
- Modify: `package.json`

**Interfaces:**

- Consumes: `createRoomServer()` from `src/server.js`.
- Consumes: `runA2ARoomConnector({ roomBaseUrl, agentBaseUrl, side, identity, log })` from `src/a2a-room-connector.js`.
- Consumes at manual execution: required `AGENT_A_URL` and `AGENT_B_URL` environment variables.
- Produces: `runM2ETwoMachinePrivateSshValidation({ agentAUrl, agentBUrl, log })`, returning `{ roomBaseUrl, messages, close }`.
- Produces: `npm run m2e:validate`, which keeps the completed local Room available until the operator stops it.

- [ ] **RED — add the focused runner regression first**

Create `test/m2e-two-machine-private-ssh-validation.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createA2ATestAgentServer } from "../src/a2a-test-agent.js";
import {
  runM2ETwoMachinePrivateSshValidation,
} from "../scripts/run-m2e-two-machine-private-ssh-validation.js";

test("consumes two existing A2A endpoints for four non-empty A-B-A-B messages", async (t) => {
  const agentA = await createA2ATestAgentServer();
  const agentB = await createA2ATestAgentServer();
  t.after(() => agentA.close());
  t.after(() => agentB.close());

  const validation = await runM2ETwoMachinePrivateSshValidation({
    agentAUrl: agentA.baseUrl,
    agentBUrl: agentB.baseUrl,
    log() {},
  });
  t.after(() => validation.close());

  assert.match(validation.roomBaseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(validation.messages.length, 4);
  assert.deepEqual(
    validation.messages.map((event) => event.side),
    ["A", "B", "A", "B"],
  );
  assert.ok(
    validation.messages.every(
      (event) => event.payload.content.trim().length > 0,
    ),
  );
});
```

Run:

```bash
node --test test/m2e-two-machine-private-ssh-validation.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` because the runner does not yet exist. Do not add a test-only fallback or start Agents from the future runner.

- [ ] **GREEN — implement the Room-only runner**

Create `scripts/run-m2e-two-machine-private-ssh-validation.js`:

```js
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRoomServer } from "../src/server.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";

const host = "127.0.0.1";

export async function runM2ETwoMachinePrivateSshValidation({
  agentAUrl,
  agentBUrl,
  log = console.log,
}) {
  assertA2ABaseUrl("agentAUrl", agentAUrl);
  assertA2ABaseUrl("agentBUrl", agentBUrl);

  const { server: roomServer, store } = createRoomServer();
  await listen(roomServer, 0, host);

  try {
    const roomAddress = roomServer.address();
    const roomBaseUrl = `http://${host}:${roomAddress.port}`;

    await Promise.all([
      runA2ARoomConnector({
        roomBaseUrl,
        agentBaseUrl: agentAUrl,
        side: "A",
        identity: {
          display_name: "Agent A",
          companion_name: "User A",
        },
        log,
      }),
      runA2ARoomConnector({
        roomBaseUrl,
        agentBaseUrl: agentBUrl,
        side: "B",
        identity: {
          display_name: "Agent B",
          companion_name: "User B",
        },
        log,
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
    assert.ok(
      messages.every(
        (event) => event.payload.content.trim().length > 0,
      ),
    );

    return {
      roomBaseUrl,
      messages,
      close: () => closeServer(roomServer),
    };
  } catch (error) {
    await closeServer(roomServer);
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const validation = await runM2ETwoMachinePrivateSshValidation({
    agentAUrl: process.env.AGENT_A_URL,
    agentBUrl: process.env.AGENT_B_URL,
  });

  console.log(
    `M2E private SSH validation complete: ${validation.messages.length} messages`,
  );
  console.log(`Observer page: ${validation.roomBaseUrl}`);
  console.log("M2E two-machine private SSH validation PASS.");
  console.log("Press Ctrl+C to close the local Room.");

  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    void validation.close().finally(() => process.exit(code));
  };

  process.once("SIGINT", () => stop(130));
  process.once("SIGTERM", () => stop(143));
}

function assertA2ABaseUrl(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty A2A base URL`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid A2A base URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http: or https:`);
  }
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

The runner has no import of `createA2AModelAgentServer`, `createA2ATestAgentServer`, `createLocalAgentEdge`, or SSH tooling. It starts and later closes only `roomServer`.

- [ ] **GREEN — expose exactly one manual npm command**

In `package.json`, add this one entry immediately after the existing `m2d:demo` entry:

```json
"m2e:validate": "node scripts/run-m2e-two-machine-private-ssh-validation.js"
```

Do not alter any other script, dependency, or lockfile entry.

- [ ] **Verify the focused regression and executable syntax**

Run:

```bash
node --check scripts/run-m2e-two-machine-private-ssh-validation.js
node --test test/m2e-two-machine-private-ssh-validation.test.js
```

Expected: syntax check exits `0`; the focused test passes after pre-starting its two fixture endpoints and proves the runner returns exactly four non-empty `A → B → A → B` messages.

- [ ] **Run the full automated regression and whitespace validation**

Run:

```bash
npm test
git diff --check
```

Expected: the full suite passes with the new focused test included, and `git diff --check` produces no output.

- [ ] **Perform the manual two-machine validation and teardown**

1. Outside this repository, start each participant's existing Local Agent Edge on its own computer and establish the already-approved private SSH forwarding manually so this Mac can reach both A2A base URLs. Do not add or run project automation for that transport.
2. Set `AGENT_A_URL` and `AGENT_B_URL` in the terminal to the two reachable A2A base URLs, then run:

```bash
npm run m2e:validate
```

3. Confirm the command prints `M2E two-machine private SSH validation PASS.`, reports exactly four messages, and leaves the printed `Observer page` available for the humans to inspect the completed exchange.
4. Stop the runner with `Ctrl+C`. Confirm the local Room process exits and the observer page no longer responds. Confirm neither externally owned Agent process was stopped by the runner.
5. In the separate terminals that own the private SSH reverse and local forwards, stop those forwards manually. Confirm the forwarded remote Edge is no longer reachable from this Mac and that neither Local Agent Edge is publicly exposed.

- [ ] **Review exact scope and commit the completed task**

Run:

```bash
git status --short
git diff --check
git diff -- package.json scripts/run-m2e-two-machine-private-ssh-validation.js test/m2e-two-machine-private-ssh-validation.test.js
```

Expected changed files are exactly:

```text
package.json
scripts/run-m2e-two-machine-private-ssh-validation.js
test/m2e-two-machine-private-ssh-validation.test.js
```

Then commit the task:

```bash
git add package.json scripts/run-m2e-two-machine-private-ssh-validation.js test/m2e-two-machine-private-ssh-validation.test.js
git diff --cached --check
git commit -m "feat: add M2E private SSH validation runner"
```

Do not push.
