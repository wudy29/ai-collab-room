# Ephemeral Cloud Room Invite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two users pair local Agents through one ephemeral HTTPS Room and one invite code, while each user automatically receives a private browser observation session.

**Architecture:** Add an in-memory `EphemeralRoomRegistry` around independent existing `RoomStore` instances. Global `/mcp` performs only invite pairing; capability-scoped `/rooms/:roomId/mcp` continues the existing Room MCP protocol and derives the side from its Bearer capability. Local `cloud-room` commands start the user's configured loopback Edge before pairing, automatically open an observer session, then run the existing browser-agnostic A2A connector.

**Tech Stack:** Node.js 20 built-ins, existing `@a2a-js/sdk`, existing Room MCP JSON-RPC shape, `node:test`, existing Local Agent Edge onboarding.

## Global Constraints

- Preserve the literal invariant: `Room owns messages, not agents.`
- Do not modify `src/room-store.js`.
- Add no database, accounts, OAuth, friends, permanent Rooms, reconnect/resume, human input, continue flow, public Edge, NAT/tunnel, scaling, admin feature, transport, dependency, or unrelated refactor.
- Registry state contains no participant identity. Identity remains side-owned and is supplied only to `join_room`.
- Server restart intentionally loses ephemeral Rooms. There is no timer, worker, background expiry loop, or 30-minute test wait; access-boundary operations call `sweep()`.
- Maintain the current MCP HTTP and JSON-RPC error envelope. Use only `ROOM_UNAVAILABLE: room unavailable or authorization invalid` and `INVITE_UNAVAILABLE: invite is invalid or unavailable` for unavailable authorization/invite cases.
- Keep production Rooms at `maxTurns: 8`; preserve historical four-message tests and M2E validation through injected `createStore` factories with `maxTurns: 4`.
- Use TDD for each source change: run the named focused test first and observe its failure, then implement the smallest change that passes it.
- Do not push. Tasks 1–6 each end in the exact commit command shown; Task 7 is validation only and creates no commit.

---

## Files and interfaces

- `src/ephemeral-room-registry.js` owns opaque IDs, invite/capability issuance, one-time pairing, observer bootstrap/session state, and deterministic sweeping.
- `src/server.js` owns global pairing MCP, capability-scoped Room MCP, scoped observer routes, scoped SSE fan-out, and generic invalid-observer responses.
- `src/mcp-shape.js` preserves the existing MCP JSON-RPC envelope while accepting the server-authorized Room context.
- `src/a2a-room-connector.js` owns the browser-agnostic outbound Room/A2A loop using a Room capability.
- `src/fake-connector.js` and every current direct connector caller migrate to the scoped Room URL and capability contract.
- `local-agent-edge/cloud-room-config.js` owns strict `.cloud-room.json` parsing, validation, reading, and `0600` writing.
- `local-agent-edge/cloud-room.js` owns AI-guided setup, loopback Edge lifecycle, global pairing MCP calls, internal observer bootstrap, platform browser opening, and connector launch.
- `test/ephemeral-room-registry.test.js`, `test/ephemeral-room-server.test.js`, `test/cloud-room.test.js`, and `test/ephemeral-cloud-room-remote-e2e.test.js` own focused coverage.
- `docs/operations/ephemeral-cloud-room-https.md` owns the bounded HTTPS deployment and acceptance procedure.

The registry API is exact:

```js
new EphemeralRoomRegistry({
  createStore = ({ roomId }) => new RoomStore({ id: roomId, maxTurns: 8 }),
  now = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {})

createRoom() // -> { roomId, inviteCode, sideCapability, observerBootstrapToken }
redeemInvite(inviteCode) // -> { roomId, sideCapability, observerBootstrapToken }
authorize(roomId, sideCapability) // -> { roomId, side, store }
consumeObserverBootstrap(observerBootstrapToken) // -> { roomId, observerSessionId }
authorizeObserver(roomId, observerSessionId) // -> { roomId, store }
sweep() // -> number
```

The connector signature is exact:

```js
runA2ARoomConnector({
  roomBaseUrl,
  agentBaseUrl,
  roomCapability,
  identity,
  log = console.log,
})
```

`roomBaseUrl` is `${roomOrigin}/rooms/${roomId}`. The connector sends `Authorization: Bearer <roomCapability>` on every Room MCP request, supplies identity only to `join_room`, and never sends a caller-provided side.

### Task 1: Add the ephemeral Room registry

**Files:**

- Create: `src/ephemeral-room-registry.js`
- Create: `test/ephemeral-room-registry.test.js`

**Interfaces:**

- Produces exactly the `EphemeralRoomRegistry` constructor and methods listed above.
- Consumes `RoomStore` without changing it.
- Uses injected `now` and `randomBytes` in tests; production defaults use `Date.now()` and `crypto.randomBytes`.

- [ ] **RED — add deterministic registry lifecycle tests**

Add focused tests that create a registry with a monotonically controlled clock, deterministic random bytes, and a recording `createStore`. Require:

- `createRoom()` returns opaque, distinct room ID, invite code, A-side capability, and A observer bootstrap token; only the created RoomStore is held by the registry.
- `redeemInvite()` succeeds exactly once and returns the same room ID, a distinct B-side capability, and a distinct B observer bootstrap token.
- A and B capabilities authorize only their issued sides; a wrong capability and a valid capability against another room fail with `ROOM_UNAVAILABLE`.
- A bootstrap token is single-use and yields an opaque observer session ID; only that session authorizes its room, and wrong/cross-room/reused sessions fail generically.
- An unpaired Room is deleted at `createdAt + 30 minutes`, including when A already joined. `pairedAtMs` is set only after successful B redemption, so a paired Room is not subject to unpaired expiry.
- A completed paired Room is retained until exactly 30 minutes after `store.snapshotFor("A").room.ended_at`, then removed. A paired unfinished Room remains available.
- `sweep()` returns the number deleted and never requires a timer or human-time wait.

Run:

```bash
node --test test/ephemeral-room-registry.test.js
```

Expected: FAIL because the registry module does not exist.

- [ ] **GREEN — implement only in-memory pairing and expiry state**

Implement `EphemeralRoomRegistry` with maps keyed by opaque values generated from `randomBytes`. Store only Room metadata, issued opaque credentials, timestamps, and the existing `RoomStore`; do not retain display names, companion names, Agent endpoints, or any other participant identity.

Run `sweep()` at the start of every public registry operation. Set `pairedAtMs` only after a successful first invite redemption. For ended retention, inspect `store.snapshotFor("A").room.ended_at`; do not add lifecycle data to `RoomStore`. Remove every room-owned capability, invite, and observer token/session index when deleting a Room.

Run:

```bash
node --test test/ephemeral-room-registry.test.js
git diff --check
git add src/ephemeral-room-registry.js test/ephemeral-room-registry.test.js && git commit -m "feat: add ephemeral room registry"
```

Expected: focused registry tests PASS and the committed diff is whitespace-clean.

### Task 2: Scope MCP transport to capabilities and migrate direct callers

**Files:**

- Modify: `src/server.js`
- Modify: `src/mcp-shape.js`
- Modify: `src/a2a-room-connector.js`
- Modify: `src/fake-connector.js`
- Modify: `scripts/run-a2a-demo.js`
- Modify: `scripts/run-demo.js`
- Modify: `scripts/run-m1-demo.js`
- Modify: `scripts/run-m2a-demo.js`
- Modify: `scripts/run-m2b-demo.js`
- Modify: `scripts/run-m2c-demo.js`
- Modify: `scripts/run-m2d-demo.js`
- Modify: `scripts/run-m2e-two-machine-private-ssh-validation.js`
- Modify: `test/a2a-e2e.test.js`
- Modify: `test/e2e.test.js`
- Modify: `test/m2e-two-machine-private-ssh-validation.test.js`
- Create: `test/ephemeral-room-server.test.js`

**Interfaces:**

- `createRoomServer({ registry = new EphemeralRoomRegistry(), logger = console } = {})` returns the server and registry needed by tests.
- Global `POST /mcp` exposes only MCP tools `create_room` with no arguments and `redeem_invite({ invite_code })`.
- Global create result is exactly `{ room_id, invite_code, side_capability, observer_bootstrap_token }`; redeem result is exactly `{ room_id, side_capability, observer_bootstrap_token }`.
- `POST /rooms/:roomId/mcp` requires `Authorization: Bearer <sideCapability>`, calls `registry.authorize`, and passes the server-derived side and store to Room MCP handling.
- `runFakeConnector` uses `{ roomBaseUrl, roomCapability, identity, script, log }`; it derives logging side from `join_room` output rather than accepting authority as a caller side.

- [ ] **RED — specify pairing, capability, and caller regressions**

Add server tests that issue A through global `create_room`, redeem B through global `redeem_invite`, and call Room MCP through each scoped Room URL. Require:

- `/mcp` rejects Room tools and accepts no REST pairing equivalent.
- create/redeem use the existing HTTP status and JSON-RPC response/error envelope, with snake_case result fields exactly as specified.
- redeeming an invalid or already-redeemed invite reports `INVITE_UNAVAILABLE` with the exact locked message and does not mutate any Room.
- missing, malformed, wrong, or cross-room Bearer capability reports `ROOM_UNAVAILABLE` with the exact locked message and does not reveal Room state.
- `join_room` accepts only identity; `wait_turn`, `submit_turn`, and end authorization use the server-derived side, rejecting supplied/forged side information and cross-room access.
- successful authorized A/B exchange preserves the existing turn protocol, including unauthorized end rejection.

Update the existing A2A, fake-connector, demo (including `scripts/run-demo.js`), and M2E tests/scripts to obtain A/B authority through the global pairing tools and use `${baseUrl}/rooms/${roomId}` plus Bearer capability. Keep all historical four-message fixtures and M2E behavior by injecting `createStore: ({ roomId }) => new RoomStore({ id: roomId, maxTurns: 4 })`; do not enlarge the private-SSH product surface.

Run:

```bash
node --test test/ephemeral-room-server.test.js test/a2a-e2e.test.js test/e2e.test.js test/m2e-two-machine-private-ssh-validation.test.js
```

Expected: FAIL before the server, MCP shape, connector, and direct callers are migrated.

- [ ] **GREEN — implement global pairing and capability-scoped Room MCP**

Replace fixed-store server selection with registry lookup while preserving the existing JSON-RPC dispatch and error wrapping. Global `/mcp` remains the only pairing transport. It must expose exactly `create_room` and `redeem_invite`; do not add REST pairing routes or additional pairing tools.

Require a Bearer side capability for every `POST /rooms/:roomId/mcp` request. Authorize before dispatch, derive the side internally, and make it impossible for JSON-RPC arguments to select or impersonate a side. Broadcast SSE only to clients attached to the affected Room. Migrate every listed actual direct caller rather than leaving old `/mcp` Room calls behind.

Run:

```bash
node --test test/ephemeral-room-server.test.js test/a2a-e2e.test.js test/e2e.test.js test/m2e-two-machine-private-ssh-validation.test.js
npm test
git diff --check
git add src/server.js src/mcp-shape.js src/a2a-room-connector.js src/fake-connector.js scripts/run-a2a-demo.js scripts/run-demo.js scripts/run-m1-demo.js scripts/run-m2a-demo.js scripts/run-m2b-demo.js scripts/run-m2c-demo.js scripts/run-m2d-demo.js scripts/run-m2e-two-machine-private-ssh-validation.js test/a2a-e2e.test.js test/e2e.test.js test/m2e-two-machine-private-ssh-validation.test.js test/ephemeral-room-server.test.js && git commit -m "feat: scope room MCP by invite capability"
```

Expected: focused compatibility tests and the full regression suite PASS.

### Task 3: Add private observer bootstrap and Room-scoped browser surfaces

**Files:**

- Modify: `src/server.js`
- Modify: `public/index.html`
- Modify: `test/ephemeral-room-server.test.js`

**Interfaces:**

- `GET /observe/:token` consumes the bootstrap token, sets `room_observer=<session>; Secure; HttpOnly; SameSite=Strict; Path=/rooms/<actual-id>`, sets `Referrer-Policy: no-referrer`, and responds `303 Location: /rooms/<id>`.
- `GET /rooms/:id` serves the existing observation shell only after cookie authorization.
- `GET /rooms/:id/api/state` and `GET /rooms/:id/events` authorize the room-specific observer cookie before reading state or attaching SSE.

- [ ] **RED — add observer isolation and no-root-surface tests**

Extend server tests to require that a valid bootstrap token redirects once, emits the exact cookie attributes and `Referrer-Policy`, and creates a session usable only for its actual Room. Require invalid, reused, missing-cookie, and cross-room observer access to return a generic `404`.

Require the shell, state, and event paths to be exactly `/rooms/:id`, `/rooms/:id/api/state`, and `/rooms/:id/events`. Require no root state/events/end route and no HTTP end route. Verify the served page contains no end button and that its fetch/EventSource paths are relative to the scoped shell.

Run:

```bash
node --test test/ephemeral-room-server.test.js
```

Expected: FAIL because observer state is currently global and bootstrap/session authorization does not exist.

- [ ] **GREEN — serve only scoped, cookie-authorized observation**

Implement the bootstrap redirect as the sole observer credential handoff. Consume before redirecting, never expose the token in the target URL, and use generic 404 responses for every invalid observer case. Scope state lookup, event replay, live SSE client bookkeeping, and page JavaScript to the authorized Room.

Remove root `/`, `/api/state`, `/events`, and `/api/end` behavior rather than retaining aliases. Do not add an end button or a new HTTP end mechanism.

Run:

```bash
node --test test/ephemeral-room-server.test.js
npm test
git diff --check
git add src/server.js public/index.html test/ephemeral-room-server.test.js && git commit -m "feat: add scoped room observation sessions"
```

Expected: observer isolation tests and the full regression suite PASS.

### Task 4: Add AI-guided local cloud Room setup, create, and join

**Files:**

- Create: `local-agent-edge/cloud-room-config.js`
- Create: `local-agent-edge/cloud-room.js`
- Create: `test/cloud-room.test.js`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- `parseCloudRoomConfigurationCommand(line)` accepts exactly one `cloud-room:configure {...}` line and returns normalized configuration.
- `readCloudRoomConfig({ configDir })` and `writeCloudRoomConfig({ configDir, config })` read/write `${configDir}/.cloud-room.json`.
- `runCloudRoomSetup({ input, output, configDir })` prints the AI request and accepts exactly one valid configuration line.
- `runCloudRoomCreate({ configDir, openBrowser, startEdge, runConnector, output })` and `runCloudRoomJoin({ inviteCode, configDir, openBrowser, startEdge, runConnector, output })` support dependency injection for focused tests.

- [ ] **RED — add configuration and local orchestration tests**

Add tests requiring `.cloud-room.json` to contain only normalized HTTPS `roomOrigin`, `displayName`, and optional `companionName`; reject HTTP, paths/query/fragments, extra properties, malformed JSON, and every input not consisting of exactly one `cloud-room:configure {...}` line. Require atomic `0600` writes and `.cloud-room.json` Git ignore.

Test the required local order for both create and join:

1. read configuration;
2. start and verify the caller's configured loopback Edge using the existing exported `startConfiguredLocalAgentEdge`;
3. only then call global `create_room` or `redeem_invite`;
4. open the internal observer bootstrap URL;
5. run `runA2ARoomConnector`;
6. close only that Edge in `finally`.

Require no MCP call when Edge startup fails, and require missing Edge configuration to tell the user's AI to run the existing `npm run edge:setup`. Require an opener failure to avoid connector launch and never print a capability or observer URL. If B already redeemed when the opener fails, report the local failure and direct the user to create a new Room; do not add retry/resume behavior.

Require the real browser opener to use imported/promisified `execFile` from `node:child_process`: `open [url]` on darwin, `xdg-open [url]` on linux, and `cmd.exe ["/c", "start", "", url]` on win32. Require creator stdout to be exactly one authority line, `Invite code: <code>`, and require join stdout to print no authority.

Run:

```bash
node --test test/cloud-room.test.js
```

Expected: FAIL because cloud Room configuration and commands do not exist.

- [ ] **GREEN — implement the minimal private local flow**

Implement only setup/create/join scripts exposed as `cloud-room:setup`, `cloud-room:create`, and `cloud-room:join`. Reuse `startConfiguredLocalAgentEdge` without changing its onboarding schema. Keep every secret-like value out of `.cloud-room.json`, stdout, errors, and README instructions: humans configure only the Room origin and display identity, share only the invite code, and never manually edit JSON, run `edge:start`, copy capabilities, or copy observer links.

Use global MCP only for pairing. Build the scoped URL from the returned room ID, open `/observe/<bootstrap-token>` internally, and pass the returned side capability only in-memory to the connector. Ensure the finally block closes the Edge instance started for this invocation, including connector failure.

Run:

```bash
node --test test/cloud-room.test.js
npm test
git diff --check
git add local-agent-edge/cloud-room-config.js local-agent-edge/cloud-room.js test/cloud-room.test.js .gitignore package.json README.md && git commit -m "feat: add guided cloud room commands"
```

Expected: focused local-flow tests and the full regression suite PASS.

### Task 5: Add the remote-style two-connector end-to-end acceptance test

**Files:**

- Create: `test/ephemeral-cloud-room-remote-e2e.test.js`

**Interfaces:**

- The test uses global MCP create/redeem, two independently started local A2A endpoints, and two `runA2ARoomConnector` calls against one remote-style Room base origin.
- It uses the production registry default `RoomStore({ maxTurns: 8 })`.

- [ ] **RED — add a real integration contract, not a fake failure**

Create the new default test that starts the Room app and two independent local A2A test Agents. Pair A and B through global MCP, issue separate observer bootstrap sessions, run two connectors with their scoped Room URLs and different side capabilities, and require exactly A, B, A, B, A, B, A, B messages.

Require both authorized observer sessions to return the same complete eight-message transcript after the Room ends. This test is post-integration expected PASS; do not manufacture a RED failure by stubbing production behavior. If writing it reveals a source defect, stop for human review before editing production source.

Run:

```bash
node --test test/ephemeral-cloud-room-remote-e2e.test.js
```

Expected: PASS after Tasks 1–4 are integrated.

- [ ] **GREEN — make only test-fixture corrections if needed**

Correct only the test's startup, cleanup, or assertion fixture code necessary to express the established production contract. Do not alter application source or add test-only bypasses. Keep both connectors independently configured and outbound to the same remote-style base URL.

Run:

```bash
node --test test/ephemeral-cloud-room-remote-e2e.test.js
npm test
git diff --check
git add test/ephemeral-cloud-room-remote-e2e.test.js && git commit -m "test: cover remote ephemeral room pairing"
```

Expected: the new remote-style E2E and full regression suite PASS.

### Task 6: Document the bounded HTTPS deployment procedure

**Files:**

- Create: `docs/operations/ephemeral-cloud-room-https.md`

- [ ] **RED — write the operational acceptance assertions**

Document the required command/response checks before claiming a public deployment: the Room application starts on loopback with `PORT`, public use requires an already-existing same-host HTTPS/TLS route to that loopback upstream, and the route must preserve SSE. Do not assume a host, hostname, certificate, TLS process, or deployment mechanism exists.

Specify a curl check using:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$ROOM_ORIGIN/mcp"
```

State that a non-`000` result is only network/TLS reachability evidence; it is not a successful MCP request and the command must not use `--fail` or `HEAD`.

- [ ] **GREEN — add only the operations guide**

Write the guide with no infrastructure automation. Explain that the executor, not a nontechnical user, must use the established host-access/deployment procedure if and only if an existing same-host HTTPS/TLS route is available. Preserve SSE and keep Local Agent Edge loopback-only.

Include the final two-computer acceptance sequence: auto Edge setup/start, automatic browser observation, one invite, outbound HTTPS from both computers, exactly eight alternating Agent messages, and matching observer transcripts. State no 30-minute live wait; expiry uses deterministic tests. Allow only an optional short restart-loss confirmation.

Run:

```bash
git diff --check
git add docs/operations/ephemeral-cloud-room-https.md && git commit -m "docs: add ephemeral room HTTPS operations"
```

Expected: documentation-only commit is whitespace-clean.

### Task 7: Final regression, host inspection, deployment, and live acceptance

**Files:**

- No source or documentation changes.

- [ ] **Validation only — run final local evidence**

Run:

```bash
npm test
git diff --check
git status --short
```

Expected: the complete suite PASS, `git diff --check` produces no output, and status is clean after Task 6's commit.

- [ ] **Validation only — inspect before external deployment**

Inspect the user's existing cloud host, hostname, TLS, and established deployment/access procedure. If any required host, hostname, TLS route, or safe same-host loopback upstream procedure is absent, unavailable, or unsafe, HARD STOP and ask the user for direction. Do not create infrastructure, certificates, tunnels, NAT rules, public Edge exposure, or an alternative transport.

If all existing prerequisites are confirmed, the executor—not the nontechnical user—uses that established procedure to start the current Room app on loopback `PORT` and connect only the already-existing TLS route/upstream while preserving SSE. Verify the non-`000` curl result from Task 6, treating it only as network/TLS evidence.

- [ ] **Validation only — perform live acceptance and stop**

From two computers, perform one creator create and one join with automatic local Edge lifecycle and automatic browser observation. Verify each local connector makes only outbound HTTPS Room traffic, complete exactly eight alternating A/B Agent messages, and verify both observer sessions display the same transcript. Do not wait 30 minutes; deterministic tests cover expiry. An optional short restart-loss check may confirm that restart invalidates active/ended Rooms.

HARD STOP after the live acceptance passes. Do not push, add follow-up features, or make any further change.
