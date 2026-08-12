import assert from "node:assert/strict";
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
import { createLocalAgentEdge } from "../local-agent-edge/a2a-edge.js";
import { createClaudeCodeDriver } from "../local-agent-edge/claude-code.js";

test("generic CLI driver passes fixed argv, stdin and cwd and returns stdout", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "local-agent-edge-driver-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workdir = path.join(root, "workdir");
  await mkdir(workdir);
  const fakeCli = path.join(root, "fake-cli");
  await writeExecutable(fakeCli, `
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
    command: fakeCli,
    args: ["--alpha", "two"],
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

  const nonzero = path.join(root, "nonzero");
  await writeExecutable(nonzero, `
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("boom");
  process.exit(7);
});
`);
  await assert.rejects(
    createGenericCliDriver({
      command: nonzero,
      cwd: workdir,
      timeoutMs: 2_000,
    }).run("x"),
    /code 7: boom/,
  );

  const empty = path.join(root, "empty");
  await writeExecutable(empty, `
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
  await assert.rejects(
    createGenericCliDriver({
      command: empty,
      cwd: workdir,
      timeoutMs: 2_000,
    }).run("x"),
    /empty stdout/,
  );

  const slow = path.join(root, "slow");
  await writeExecutable(slow, `
process.stdin.resume();
setInterval(() => {}, 1_000);
`);
  await assert.rejects(
    createGenericCliDriver({
      command: slow,
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
  const closesStdin = path.join(root, "closes-stdin");
  await writeExecutable(closesStdin, `
const { closeSync } = require("node:fs");
closeSync(0);
process.stdout.write("false-success");
setTimeout(() => process.exit(0), 200);
`);

  await assert.rejects(
    createGenericCliDriver({
      command: closesStdin,
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
    const exitsWithDescendant = path.join(root, "exits-with-descendant");
    await writeExecutable(exitsWithDescendant, `
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
      command: exitsWithDescendant,
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

test("Claude Code composition uses exact resume argv and does not persist session state", async (t) => {
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
