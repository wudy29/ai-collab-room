import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";

async function configApi() {
  return import("../local-agent-edge/onboarding-config.js");
}

async function onboardingApi() {
  return import("../local-agent-edge/onboarding.js");
}

test("configuration parser validates pasted commands and rejects secret-like keys", async () => {
  const { parseConfigurationCommand } = await configApi();
  const valid = {
    command: "node",
    args: ["-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    env: { TERM: "dumb" },
    port: 0,
  };

  assert.deepEqual(
    await parseConfigurationCommand(`edge:configure ${JSON.stringify(valid)}`),
    valid,
  );

  const invalid = [
    {},
    { ...valid, args: ["ok", 1] },
    { ...valid, cwd: path.join(tmpdir(), "does-not-exist") },
    { ...valid, port: 65_536 },
    { ...valid, extra: true },
    { ...valid, env: { API_KEY: "must-not-store" } },
  ].map((config) => `edge:configure ${JSON.stringify(config)}`);
  invalid.push("edge:configure not-json", `configure ${JSON.stringify(valid)}`);

  for (const line of invalid) {
    await assert.rejects(() => parseConfigurationCommand(line));
  }
});

test("configuration storage is private and setup prints a copy/paste prompt", async (t) => {
  const {
    readLocalAgentEdgeConfig,
    writeLocalAgentEdgeConfig,
  } = await configApi();
  const { runEdgeSetup } = await onboardingApi();
  const configDir = await mkdtemp(path.join(tmpdir(), "edge-onboarding-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const config = {
    command: "node",
    args: ["-e", "process.stdout.write('ok')"],
    cwd: process.cwd(),
    env: { TERM: "dumb" },
    port: 0,
  };

  await writeLocalAgentEdgeConfig({ configDir, config });
  assert.deepEqual(await readLocalAgentEdgeConfig({ configDir }), config);
  if (process.platform !== "win32") {
    // Windows has no POSIX permission bits; stat().mode only distinguishes
    // read-only vs writable there, so 0600 is only assertable on POSIX.
    assert.equal(
      (await stat(path.join(configDir, ".local-agent-edge.json"))).mode & 0o777,
      0o600,
    );
  }

  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => text += chunk);
  await runEdgeSetup({
    input: Readable.from([`edge:configure ${JSON.stringify(config)}\n`]),
    output,
    configDir,
  });

  assert.match(text, /edge:configure/i);
  assert.match(text, /paste/i);
  assert.match(text, /Next:/);
  assert.deepEqual(await readLocalAgentEdgeConfig({ configDir }), config);
});

test("configured edge serves an A2A reply through the fake CLI with merged env", async (t) => {
  const { writeLocalAgentEdgeConfig } = await configApi();
  const { startConfiguredLocalAgentEdge } = await onboardingApi();
  const configDir = await mkdtemp(path.join(tmpdir(), "edge-launch-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const fakeCli = path.join(configDir, "fake-cli.js");
  await writeFile(fakeCli, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => process.stdout.write(JSON.stringify({
  input,
  inherited: process.env.EDGE_INHERITED,
  saved: process.env.EDGE_SAVED,
})));
`);
  await writeLocalAgentEdgeConfig({
    configDir,
    config: {
      command: process.execPath,
      args: [fakeCli],
      cwd: configDir,
      env: { EDGE_SAVED: "saved-value" },
      port: 0,
    },
  });

  const edge = await startConfiguredLocalAgentEdge({
    configDir,
    env: { ...process.env, EDGE_INHERITED: "inherited-value" },
    output: new PassThrough(),
  });
  t.after(() => edge.close());

  const client = await new ClientFactory().createFromUrl(edge.baseUrl);
  const result = await client.sendMessage(messageRequest("onboarding-message", "hello edge"));
  assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(JSON.parse(resultText(result)), {
    input: "hello edge",
    inherited: "inherited-value",
    saved: "saved-value",
  });
});

test("start reports missing config, unavailable commands, and occupied ports with next actions", async (t) => {
  const { writeLocalAgentEdgeConfig } = await configApi();
  const { startConfiguredLocalAgentEdge } = await onboardingApi();
  const configDir = await mkdtemp(path.join(tmpdir(), "edge-errors-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));

  const missing = await failedStart(startConfiguredLocalAgentEdge, { configDir });
  assert.match(missing, /config/i);
  assert.match(missing, /Next:/);

  await writeLocalAgentEdgeConfig({
    configDir,
    config: {
      command: "definitely-not-an-installed-command",
      args: [],
      cwd: configDir,
      env: {},
      port: 0,
    },
  });
  const unavailable = await failedStart(startConfiguredLocalAgentEdge, { configDir });
  assert.match(unavailable, /definitely-not-an-installed-command/);
  assert.match(unavailable, /Next:/);

  const occupied = createServer();
  await listen(occupied);
  t.after(() => close(occupied));
  await writeLocalAgentEdgeConfig({
    configDir,
    config: {
      command: process.execPath,
      args: [],
      cwd: configDir,
      env: {},
      port: occupied.address().port,
    },
  });
  const conflict = await failedStart(startConfiguredLocalAgentEdge, { configDir });
  assert.match(conflict, /EADDRINUSE|address.*in use/i);
  assert.match(conflict, /Next:/);
});

test("main setup and start entrypoint exposes an Agent Card and closes on SIGTERM", async (t) => {
  const configDir = await mkdtemp(path.join(tmpdir(), "edge-main-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  const fakeCli = path.join(configDir, "fake-cli.js");
  await writeFile(fakeCli, "process.stdin.pipe(process.stdout);\n");
  const config = {
    command: process.execPath,
    args: [fakeCli],
    cwd: configDir,
    env: {},
    port: 0,
  };
  const entrypoint = path.resolve("local-agent-edge/onboarding.js");
  const setup = startNode([entrypoint, "setup"], configDir);
  setup.child.stdin.end(`edge:configure ${JSON.stringify(config)}\n`);
  const setupResult = await setup.exited;
  assert.equal(setupResult.code, 0);

  const start = startNode([entrypoint, "start"], configDir);
  const agentCardUrl = await waitForCardUrl(start.child);
  const response = await fetch(agentCardUrl);
  assert.equal(response.status, 200);
  start.child.kill("SIGTERM");
  const result = await start.exited;
  if (process.platform === "win32") {
    // On Windows, child.kill() terminates via TerminateProcess; the child
    // never runs its SIGTERM handler and does not exit normally, so Node
    // reports code === null per the documented 'exit' semantics.
    assert.equal(result.code, null);
  } else {
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  }
});

async function failedStart(startConfiguredLocalAgentEdge, options) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => text += chunk);
  await assert.rejects(() => startConfiguredLocalAgentEdge({
    ...options,
    env: process.env,
    output,
  }));
  return text;
}

function messageRequest(messageId, text) {
  return {
    tenant: "",
    message: {
      messageId,
      contextId: "onboarding-test-context",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [{
        content: { $case: "text", value: text },
        metadata: undefined,
        filename: "",
        mediaType: "text/plain",
      }],
      extensions: [],
      metadata: {},
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: {},
  };
}

function resultText(result) {
  const parts = result.artifacts?.flatMap((artifact) => artifact.parts) ?? result.parts ?? [];
  return parts
    .map((part) => part.content?.$case === "text" ? part.content.value : "")
    .filter(Boolean)
    .join("\n");
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function startNode(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout += chunk);
  child.stderr.on("data", (chunk) => stderr += chunk);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, exited };
}

function waitForCardUrl(child) {
  return new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\.well-known\/agent-card\.json/);
      if (match) resolve(match[0]);
    });
    child.once("error", reject);
    child.once("close", (code) => reject(new Error(`start exited before ready: ${code}`)));
  });
}
