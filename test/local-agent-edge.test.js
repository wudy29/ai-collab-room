import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import { createGenericCliDriver } from "../local-agent-edge/generic-cli-driver.js";
import { mergeEffectiveEnv } from "../local-agent-edge/command-resolution.js";
import { createLocalAgentEdge } from "../local-agent-edge/a2a-edge.js";
import { createClaudeCodeDriver } from "../local-agent-edge/claude-code.js";

test("generic CLI driver passes fixed argv, stdin and cwd and returns stdout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-driver-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workdir = path.join(root, "workdir");
  await mkdir(workdir);
  const fakeCli = path.join(root, "fake-cli.js");
  await writeFile(fakeCli, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    stdin: input,
    cwd: process.cwd(),
  }));
});
`);

  const driver = createGenericCliDriver({
    command: process.execPath,
    args: [fakeCli, "--alpha", "two"],
    cwd: workdir,
    timeoutMs: 2_000,
  });

  const result = JSON.parse(await driver.run("hello\\nroom"));

  assert.deepEqual(result.args, ["--alpha", "two"]);
  assert.equal(result.stdin, "hello\\nroom");
  assert.equal(await canonicalPath(result.cwd), await canonicalPath(workdir));
});

test("generic CLI driver rejects nonzero exit, empty stdout and timeout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workdir = path.join(root, "workdir");
  await mkdir(workdir);

  const nonzero = path.join(root, "nonzero.js");
  await writeFile(nonzero, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("boom");
  process.exit(7);
});
`);
  await assert.rejects(
    createGenericCliDriver({
      command: process.execPath,
      args: [nonzero],
      cwd: workdir,
      timeoutMs: 2_000,
    }).run("x"),
    /code 7: boom/,
  );

  const empty = path.join(root, "empty.js");
  await writeFile(empty, `
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
  await assert.rejects(
    createGenericCliDriver({
      command: process.execPath,
      args: [empty],
      cwd: workdir,
      timeoutMs: 2_000,
    }).run("x"),
    /empty stdout/,
  );

  const slow = path.join(root, "slow.js");
  await writeFile(slow, `
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
  await assert.rejects(
    createGenericCliDriver({
      command: process.execPath,
      args: [slow],
      cwd: workdir,
      timeoutMs: 80,
    }).run("x"),
    /timed out/,
  );
});

test("generic CLI driver rejects child stdin EPIPE instead of returning stdout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-epipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workdir = path.join(root, "workdir");
  await mkdir(workdir);
  const closesStdin = path.join(root, "closes-stdin.js");
  await writeFile(closesStdin, `
const { closeSync } = require("node:fs");
closeSync(0);
process.stdout.write("false-success");
setTimeout(() => process.exit(0), 200);
`);

  await assert.rejects(
    createGenericCliDriver({
      command: process.execPath,
      args: [closesStdin],
      cwd: workdir,
      timeoutMs: 2_000,
    }).run("x".repeat(16 * 1024 * 1024)),
    (error) => {
      assert.equal(error.code, "EPIPE");
      return true;
    },
  );
});

test(
  "generic CLI driver rejects on timeout when a descendant inherits stdio",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-group-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const workdir = path.join(root, "workdir");
    await mkdir(workdir);
    const exitsWithDescendant = path.join(root, "exits-with-descendant.js");
    await writeFile(exitsWithDescendant, `
const { spawn } = require("node:child_process");
process.stdin.resume();
process.stdin.on("end", () => {
  spawn(
    process.execPath,
    ["-e", "setTimeout(() => process.exit(0), 1_000)"],
    { stdio: "inherit" },
  );
  process.exit(0);
});
`);

    const driver = createGenericCliDriver({
      command: process.execPath,
      args: [exitsWithDescendant],
      cwd: workdir,
      timeoutMs: 80,
    });

    let guardTimer;
    const pendingGuard = new Promise((_, reject) => {
      guardTimer = setTimeout(() => {
        reject(new Error("driver remained pending after timeout"));
      }, 500);
    });

    try {
      await assert.rejects(
        Promise.race([driver.run("x"), pendingGuard]),
        /timed out/,
      );
    } finally {
      clearTimeout(guardTimer);
    }
  },
);

test("Local Agent Edge exposes localhost A2A and returns driver text", async (t) => {
  const prompts = [];
  const edge = await createLocalAgentEdge({
    driver: {
      async run(prompt) {
        prompts.push(prompt);
        return "edge-reply";
      },
    },
    port: 0,
  });
  t.after(() => edge.close());

  assert.match(edge.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(edge.server.address().address, "127.0.0.1");

  const cardResponse = await fetch(edge.agentCardUrl);
  assert.equal(cardResponse.status, 200);
  const card = await cardResponse.json();
  assert.equal(card.supportedInterfaces[0].url, edge.baseUrl);
  assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");

  const client = await new ClientFactory().createFromUrl(edge.baseUrl);
  const result = await client.sendMessage(
    messageRequest("edge-message-1", "hello-edge"),
  );

  assert.deepEqual(prompts, ["hello-edge"]);
  assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(extractResultText(result), "edge-reply");
});

test("Local Agent Edge maps driver rejection to an A2A failed task", async (t) => {
  let calls = 0;
  const edge = await createLocalAgentEdge({
    driver: {
      async run() {
        calls += 1;
        throw new Error("driver-boom");
      },
    },
    port: 0,
  });
  t.after(() => edge.close());

  const client = await new ClientFactory().createFromUrl(edge.baseUrl);
  const result = await client.sendMessage(
    messageRequest("edge-message-2", "fail-edge"),
  );

  assert.equal(calls, 1);
  assert.equal(result.status?.state, TaskState.TASK_STATE_FAILED);
  assert.equal(extractResultText(result), "");
});

test(
  "Claude Code composition uses exact resume argv and does not persist session state",
  // The legacy composition test executes a fake executable directly, which
  // requires POSIX executable semantics; on Windows the fake CLI cannot be
  // launched without expanding the production API, so it is skipped there
  // (Windows command resolution/launch is covered by the dedicated tests).
  { skip: process.platform === "win32" },
  async (t) => {
    assert.throws(
      () => createClaudeCodeDriver({ sessionId: "", workdir: "/tmp" }),
      /sessionId/,
    );
    assert.throws(
      () => createClaudeCodeDriver({ sessionId: "session", workdir: "" }),
      /workdir/,
    );

    const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-claude-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const workdir = path.join(root, "workdir");
    await mkdir(workdir);
    const fakeClaude = path.join(root, "fake-claude");
    await writeExecutable(fakeClaude, `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    stdin: input,
    cwd: process.cwd(),
  }));
});
`);

    const before = await readdir(workdir);
    const driver = createClaudeCodeDriver({
      sessionId: "test-session",
      workdir,
      claudeBin: fakeClaude,
      timeoutMs: 2_000,
    });

    const result = JSON.parse(await driver.run("room-prompt"));
    const after = await readdir(workdir);

    assert.deepEqual(result.args, ["-p", "--resume", "test-session"]);
    assert.equal(result.stdin, "room-prompt");
    assert.equal(await canonicalPath(result.cwd), await canonicalPath(workdir));
    assert.deepEqual(after, before);
  },
);

test("generic CLI driver launches .cmd/.bat through ComSpec on win32 with the approved command line", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return realSpawn(process.execPath, [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('batch-reply'))",
    ], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    });
  };

  const effectiveEnv = mergeEffectiveEnv({
    baseEnv: { Path: "C:\\tools", TERM: "x" },
    overrideEnv: { PATH: "C:\\tools", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    platform: "win32",
  });
  const driver = createGenericCliDriver({
    command: "C:\\tools\\my tool.cmd",
    commandType: "batch",
    args: ["--alpha", "two"],
    cwd: root,
    env: effectiveEnv,
    timeoutMs: 2_000,
    platform: "win32",
    spawnFn: spawn,
  });

  const reply = await driver.run("prompt");
  assert.equal(reply, "batch-reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(calls[0].args, [
    "/d",
    "/s",
    "/c",
    '""C:\\tools\\my tool.cmd" "--alpha" "two""',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(calls[0].options.cwd, root);
  // the launcher receives the same effective env the resolver used
  assert.equal(calls[0].options.env, effectiveEnv);
});

test("generic CLI driver falls back to cmd.exe when ComSpec is absent", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-comspec-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return realSpawn(process.execPath, [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('ok'))",
    ], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    });
  };

  const driver = createGenericCliDriver({
    command: "C:\\tools\\run.cmd",
    commandType: "batch",
    args: [],
    cwd: root,
    env: {},
    timeoutMs: 2_000,
    platform: "win32",
    spawnFn: spawn,
  });

  await driver.run("x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "cmd.exe");
  assert.deepEqual(calls[0].args, ["/d", "/s", "/c", '""C:\\tools\\run.cmd""']);
});

test("generic CLI driver rejects dangerous argv before spawning a batch", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-badargv-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  let spawnCalls = 0;
  const spawn = () => {
    spawnCalls += 1;
    return realSpawn(process.execPath, [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'))",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  };

  const driver = createGenericCliDriver({
    command: "C:\\tools\\run.cmd",
    commandType: "batch",
    args: ['say"hi'],
    cwd: root,
    env: { ComSpec: "cmd.exe" },
    timeoutMs: 2_000,
    platform: "win32",
    spawnFn: spawn,
  });

  await assert.rejects(driver.run("x"), /Windows command processor/);
  assert.equal(spawnCalls, 0);
});

test("generic CLI driver keeps native spawn on win32 and never routes through ComSpec", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return realSpawn(process.execPath, [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('native-reply'))",
    ], {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio,
    });
  };

  const driver = createGenericCliDriver({
    command: "C:\\tools\\native.exe",
    args: ["--flag"],
    cwd: root,
    env: { PATH: "C:\\tools" },
    timeoutMs: 2_000,
    platform: "win32",
    spawnFn: spawn,
  });

  const reply = await driver.run("x");
  assert.equal(reply, "native-reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "C:\\tools\\native.exe");
  assert.deepEqual(calls[0].args, ["--flag"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
});

function messageRequest(messageId, text) {
  return {
    tenant: "",
    message: {
      messageId,
      contextId: "local-edge-test-context",
      taskId: "",
      role: Role.ROLE_USER,
      parts: [textPart(text)],
      extensions: [],
      metadata: {},
      referenceTaskIds: [],
    },
    configuration: undefined,
    metadata: {},
  };
}

function textPart(text) {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function extractResultText(result) {
  if (result?.status?.state === TaskState.TASK_STATE_COMPLETED) {
    for (const artifact of result.artifacts ?? []) {
      const text = textFromParts(artifact.parts);
      if (text) return text;
    }
  }
  return textFromParts(result?.parts);
}

function textFromParts(parts = []) {
  return parts
    .map((part) => {
      if (part.content?.$case === "text") return part.content.value;
      if (part.kind === "text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function canonicalPath(value) {
  const { realpath } = await import("node:fs/promises");
  return realpath(value);
}

async function writeExecutable(file, body) {
  await writeFile(file, `#!/usr/bin/env node\n${body}`);
  await chmod(file, 0o755);
}
