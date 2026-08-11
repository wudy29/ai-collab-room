# Claude Code External B Adapter — Implementation Plan

**Goal:** Build a three-file, zero-dependency localhost A2A adapter that forwards one Room text turn to one existing Claude Code session via `claude -p --resume`.

**Base HEAD:** `cb29fece6443b6d149025191c2350a0b9d38908e`

**Hard scope:** No Room/connector/existing `src/` changes; no lockfile, tunnel, auth, UI, persistence, retries, session manager, or memory sync.
## Files
Distributable:
- `adapters/claude-code-b/server.js`
- `adapters/claude-code-b/package.json`
- `adapters/claude-code-b/README.md`

Repo-only test:
- `test/claude-code-b-adapter.test.js`
## Task 1 — RED black-box test
Create `test/claude-code-b-adapter.test.js`.

The test creates a temporary fake `claude` executable and starts:

```text
node adapters/claude-code-b/server.js
```

with:

```text
CLAUDE_SESSION_ID=test-session
CLAUDE_WORKDIR=<temp-dir>
CLAUDE_BIN=<fake-claude>
```

Verify:
- Agent Card is reachable at `/.well-known/agent-card.json`.
- Card advertises JSONRPC 1.0 at `http://127.0.0.1:8767`.
- JSON-RPC `SendMessage` with `hello-room` returns the same id and fake Claude text.
- fake Claude receives `-p --resume test-session`.
- Room text reaches Claude through stdin.
- process cwd is `CLAUDE_WORKDIR`.
- non-zero Claude exit becomes JSON-RPC error.
- child processes/temp files are cleaned up.
Run before creating adapter production files:

```bash
node --test test/claude-code-b-adapter.test.js
```

Expected RED: adapter cannot become ready because `server.js` does not exist.
## Task 2 — GREEN adapter package

### `adapters/claude-code-b/package.json`
```json
{
  "name": "claude-code-b-adapter",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "start": "node server.js" }
}
```

No dependencies. No lockfile.

### `adapters/claude-code-b/server.js`
Use only:

```js
import http from "node:http";
import { spawn } from "node:child_process";
```

Runtime:

```js
const sessionId = process.env.CLAUDE_SESSION_ID;
const workdir = process.env.CLAUDE_WORKDIR;
const claudeBin = process.env.CLAUDE_BIN || "claude";
const host = "127.0.0.1";
const port = 8767;
```

Fail fast if session id or workdir is missing.

Expose:
- `GET /.well-known/agent-card.json`
- `POST /`

Card must advertise:
- name `Claude Code B Adapter`
- version `0.0.1`
- interface URL `http://127.0.0.1:8767`
- `protocolBinding=JSONRPC`
- `protocolVersion=1.0`
- no streaming/push
- text input/output

For `SendMessage`:
- read non-empty `params.message.parts[].text`;
- join multiple text parts with newline;
- preserve request id;
- reject empty input as invalid params.

Run exactly once:

```text
claude -p --resume <CLAUDE_SESSION_ID>
```

Pass Room text through stdin. Spawn with:

```js
{ cwd: workdir, env: process.env, stdio: ["pipe","pipe","pipe"], shell: false }
```

Timeout: 120s.

Success response:

```json
{
  "jsonrpc": "2.0",
  "id": "<same-id>",
  "result": { "message": { "parts": [{ "text": "<Claude reply>" }] } }
}
```

Non-zero exit, timeout, or empty stdout => JSON-RPC server error. No retry.

Never persist session id, prompts, replies, transcript, memory, MCP output, or credentials. Bind only `127.0.0.1:8767`.

### `adapters/claude-code-b/README.md`
Document only:
- Node 20+ and Claude Code required;
- `CLAUDE_SESSION_ID` required;
- `CLAUDE_WORKDIR` required;
- `CLAUDE_BIN` optional;
- start command:

```bash
CLAUDE_SESSION_ID="..." CLAUDE_WORKDIR="/path/to/project" npm start
```

- session id stays on B machine;
- adapter stores no history/memory;
- do not manually use the same Claude session during联调.
Run:

```bash
node --check adapters/claude-code-b/server.js
node --test test/claude-code-b-adapter.test.js
npm test
git diff --check
```

Allowed implementation paths only:

```text
adapters/claude-code-b/server.js
adapters/claude-code-b/package.json
adapters/claude-code-b/README.md
test/claude-code-b-adapter.test.js
```

Commit:

```bash
git add adapters/claude-code-b test/claude-code-b-adapter.test.js
git diff --cached --check
git commit -m "feat: add Claude Code B adapter"
```

Do not push.
## Task 3 — real B-side localhost ping
On the B-side Mac mini:
1. use a fresh lightweight Claude Code session in the normal identity workdir;
2. confirm identity files and local memory MCP are active;
3. keep that session idle during联调;
4. keep session id local;
5. start adapter;
6. GET Agent Card locally;
7. send one harmless A2A `SendMessage`;
8. verify target session, identity, read-only memory, no adapter persistence, localhost-only bind.

Acceptance:

```text
CLAUDE_B_LOCAL_PING=PASS
agent card=PASS
SendMessage=PASS
target session=PASS
identity=PASS
memory MCP read=PASS
adapter persistence=NONE
bind=127.0.0.1:8767
```

Then stop. Do not begin networking/auth/Room changes/multi-user work.
