# Local Agent Edge Three-Step Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-technical user configure and start the existing Local Agent Edge through copy/paste without learning CLI parameters.

**Architecture:** Add a small local JSON configuration reader/writer and one Node entrypoint with `setup` and `start` commands. `start` composes the saved configuration through the existing `createGenericCliDriver` and `createLocalAgentEdge` factories; it adds no new runtime abstraction.

**Tech Stack:** Node.js 20 built-ins, existing `@a2a-js/sdk`, existing Express dependency, `node:test`.

## Global Constraints

- Keep the scope to setup, local configuration, launcher, npm scripts, tests, and README onboarding.
- Add no dependencies unless a built-in Node API cannot perform the required work.
- Add no UI, driver registry, auto-detection, Room/core change, tunnel/network layer, adapter framework, plugin system, session manager, or automatic repair.
- Store only `command`, `args`, `cwd`, non-secret environment variables, and optional `port`; reject secret-bearing environment variable names.
- Write `.local-agent-edge.json` with mode `0600` and ignore it in Git; never print stored environment values.
- Reuse `createGenericCliDriver` and `createLocalAgentEdge`; preserve their existing localhost behavior.
- Follow TDD: observe each targeted failure before the smallest implementation that makes it pass.
- Stop after the three-step flow, regression suite, and external blind copy/paste check pass.

---

## Files and interfaces

- `local-agent-edge/onboarding-config.js` owns strict parsing, validation, reading, and writing of `.local-agent-edge.json`.
- `local-agent-edge/onboarding.js` owns the interactive setup prompt and human-readable start lifecycle.
- `test/local-agent-edge-onboarding.test.js` owns setup, validation, start, and error-output coverage.
- `package.json` exposes `edge:setup` and `edge:start`.
- `README.md` documents the exact three-step experience.
- `.gitignore` excludes `.local-agent-edge.json`.

`parseConfigurationCommand(line)` accepts only `edge:configure ` followed by one JSON object with `command`, `args`, `cwd`, optional `env`, and optional `port`, and returns `{ command, args, cwd, env, port }`. `readLocalAgentEdgeConfig({ configDir })` and `writeLocalAgentEdgeConfig({ configDir, config })` read and write `${configDir}/.local-agent-edge.json`. `startConfiguredLocalAgentEdge({ configDir, env, output })` returns the created edge after composing `createGenericCliDriver` and `createLocalAgentEdge`.

### Task 1: Config/setup flow

**Files:**
- Create: `local-agent-edge/onboarding-config.js`
- Create: `local-agent-edge/onboarding.js`
- Create: `test/local-agent-edge-onboarding.test.js`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Node `fs/promises`, `path`, and `readline/promises`.
- Produces: `parseConfigurationCommand`, `readLocalAgentEdgeConfig`, `writeLocalAgentEdgeConfig`, and `runEdgeSetup({ input, output, configDir })`.

- [ ] **RED — add focused configuration tests**

Add tests using a temporary `configDir` that require this accepted pasted line:

```text
edge:configure {"command":"node","args":["-e","process.stdout.write('ok')"],"cwd":"/tmp","env":{"TERM":"dumb"},"port":0}
```

Require rejection of a missing command, non-string arguments, nonexistent working directory, invalid port, unknown JSON property, malformed `edge:configure` line, and `env` names matching `token`, `secret`, `password`, `credential`, `api_key`, `private_key`, `authorization`, `cookie`, or `session` case-insensitively. Require `runEdgeSetup` to print the copyable AI prompt, accept the complete line from stdin, write the exact validated JSON with mode `0600`, and print a success next action. Run:

```bash
node --test test/local-agent-edge-onboarding.test.js
```

Expected: FAIL because the onboarding exports and entrypoint do not exist.

- [ ] **GREEN — implement the smallest strict local configuration flow**

Implement only the four interfaces above. The setup prompt must instruct the user to give their own AI the printed request, require that AI to return one `edge:configure {JSON}` line, state that passwords, tokens, API keys, cookies, and session values must be omitted, and ask the user to paste that line back into setup. Validate before writing, retain no input other than the allowed configuration object, use atomic overwrite semantics, and add `.local-agent-edge.json` to `.gitignore`.

Run:

```bash
node --test test/local-agent-edge-onboarding.test.js
```

Expected: PASS for all configuration and interactive setup cases.

### Task 2: Generic launcher/start flow and npm scripts

**Files:**
- Modify: `local-agent-edge/onboarding.js`
- Modify: `test/local-agent-edge-onboarding.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `readLocalAgentEdgeConfig`, `createGenericCliDriver({ command, args, cwd, env })`, and `createLocalAgentEdge({ driver, port })`.
- Produces: `startConfiguredLocalAgentEdge({ configDir, env, output })` and main-module commands `setup` and `start`.

- [ ] **RED — add launcher and command-output tests**

Add tests that save a valid temporary configuration with an executable fake CLI, start an edge on port `0`, and assert readiness output contains `Local Agent Edge is ready`, its localhost URL, and its Agent Card URL. Add separate cases for no configuration, a command absent from `PATH`, and a port already occupied; each must include the original reason plus a plain-language next action. Assert the saved non-secret `env` is merged over the process environment and passed to the generic driver.

Run:

```bash
node --test test/local-agent-edge-onboarding.test.js
```

Expected: FAIL because `startConfiguredLocalAgentEdge` and the npm commands do not yet exist.

- [ ] **GREEN — compose the existing factories without another framework**

Implement `start` by loading the local configuration, checking that the configured executable is available through its absolute path or `PATH`, merging `process.env` with saved non-secret variables, calling `createGenericCliDriver`, then calling `createLocalAgentEdge`. On success print readiness and both returned URLs; on missing config, unavailable command, or launch failure print the original reason and the single corrective next action. Keep the process alive and close the returned edge once on `SIGINT` or `SIGTERM`.

Add exactly these scripts:

```json
"edge:setup": "node local-agent-edge/onboarding.js setup",
"edge:start": "node local-agent-edge/onboarding.js start"
```

Run:

```bash
node --test test/local-agent-edge-onboarding.test.js
npm run edge:setup
```

Expected: tests PASS; setup prints the AI prompt and waits for one complete `edge:configure {JSON}` line.

### Task 3: README three-step onboarding and final regression verification

**Files:**
- Modify: `README.md`
- Modify: `test/local-agent-edge-onboarding.test.js`

**Interfaces:**
- Consumes: `npm run edge:setup`, the setup-generated `edge:configure {JSON}` line, and `npm run edge:start`.
- Produces: a documented, manually repeatable three-step onboarding flow.

- [ ] **RED — add the end-to-end command contract**

Extend the onboarding test to execute the main entrypoint in a temporary configuration directory: feed a valid `edge:configure {JSON}` line to `setup`, then execute `start`, wait for `Local Agent Edge is ready`, and fetch the printed Agent Card URL. Assert the card responds with HTTP 200 and the process closes cleanly on `SIGTERM`.

Run:

```bash
node --test test/local-agent-edge-onboarding.test.js
```

Expected: FAIL until the documented command contract is implemented end to end.

- [ ] **GREEN — document and verify only the three required steps**

Add a README section titled `Local Agent Edge: three steps` with: (1) run `npm run edge:setup`; (2) copy its prompt to the user's own AI and paste that AI's one complete `edge:configure {JSON}` response into the still-running setup command; (3) run `npm run edge:start` and use the printed Agent Card URL. State Node.js 20 and `npm install` are prerequisites, and state that configuration must not contain secrets.

Run:

```bash
node --test test/local-agent-edge-onboarding.test.js
npm test
git diff --check
git diff --name-only
```

Expected: all tests and `git diff --check` PASS; the changed implementation paths are only `.gitignore`, `README.md`, `local-agent-edge/onboarding-config.js`, `local-agent-edge/onboarding.js`, `package.json`, and `test/local-agent-edge-onboarding.test.js`.

Have a person who did not implement the change follow the README from a clean checkout using their own AI. Expected: they complete setup by copy/paste, `edge:start` prints readiness, and the Agent Card URL opens; stop if that check fails rather than expanding scope.
