import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  parseCloudRoomConfigurationCommand,
  readCloudRoomConfig,
  writeCloudRoomConfig,
} from "../local-agent-edge/cloud-room-config.js";
import {
  defaultOpenBrowser,
  runCloudRoomCreate,
  runCloudRoomJoin,
  runCloudRoomSetup,
} from "../local-agent-edge/cloud-room.js";
import { writeLocalAgentEdgeConfig } from "../local-agent-edge/onboarding-config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CREATE_RESULT = {
  room_id: "room-1",
  invite_code: "invite-1",
  side_capability: "cap-a-secret",
  observer_bootstrap_token: "bootstrap-a-secret",
};

const REDEEM_RESULT = {
  room_id: "room-1",
  side_capability: "cap-b-secret",
  observer_bootstrap_token: "bootstrap-b-secret",
};

async function tempConfigDir(t) {
  const configDir = await mkdtemp(path.join(tmpdir(), "cloud-room-"));
  t.after(() => rm(configDir, { recursive: true, force: true }));
  return configDir;
}

function capturedOutput() {
  const stream = new PassThrough();
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { text += chunk; });
  return { stream, text: () => text };
}

function stubGlobalMcp(t, results, order = null) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({
      url: String(url),
      name: request.params?.name,
      args: request.params?.arguments,
    });
    if (order) order.push(`mcp:${request.params?.name}`);
    const result = results[request.params?.name];
    if (result === undefined) {
      return {
        json: async () => ({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }),
      };
    }
    return {
      json: async () => ({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [], structuredContent: result },
      }),
    };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return calls;
}

function orderedStubs() {
  const order = [];
  const edge = {
    baseUrl: "http://127.0.0.1:9",
    close: async () => { order.push("edge-close"); },
  };
  return {
    order,
    edge,
    startEdge: async () => { order.push("edge"); return edge; },
    openBrowser: async () => { order.push("browser"); },
    runConnector: async () => { order.push("connector"); },
  };
}

test("cloud-room configuration parsing validates and normalizes", async () => {
  assert.deepEqual(
    await parseCloudRoomConfigurationCommand(
      'cloud-room:configure {"roomOrigin":"https://room.example","displayName":"Alice","companionName":"Bob"}',
    ),
    { roomOrigin: "https://room.example", displayName: "Alice", companionName: "Bob" },
  );

  assert.deepEqual(
    await parseCloudRoomConfigurationCommand(
      'cloud-room:configure {"roomOrigin":"https://room.example/","displayName":"  Alice  "}',
    ),
    { roomOrigin: "https://room.example", displayName: "Alice" },
  );

  assert.deepEqual(
    await parseCloudRoomConfigurationCommand(
      'cloud-room:configure {"roomOrigin":"https://room.example:8443/","displayName":"A"}',
    ),
    { roomOrigin: "https://room.example:8443", displayName: "A" },
  );
});

test("cloud-room configuration rejects every invalid input shape", async () => {
  const rejects = async (line, pattern) => {
    await assert.rejects(parseCloudRoomConfigurationCommand(line), pattern);
  };

  await rejects(undefined, /one cloud-room:configure/);
  await rejects("", /one cloud-room:configure/);
  await rejects("{}", /one cloud-room:configure/);
  await rejects("edge:configure {}", /one cloud-room:configure/);
  await rejects(
    'cloud-room:configure {}\ncloud-room:configure {}',
    /one cloud-room:configure/,
  );
  await rejects('cloud-room:configure {}\n', /one cloud-room:configure/);
  await rejects('cloud-room:configure {"roomOrigin":', /Configuration JSON is invalid/);
  await rejects('cloud-room:configure []', /only roomOrigin, displayName, and companionName/);
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example","displayName":"A","port":1}',
    /only roomOrigin, displayName, and companionName/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"http://room.example","displayName":"A"}',
    /HTTPS URL/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example/path","displayName":"A"}',
    /HTTPS URL/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example?x=1","displayName":"A"}',
    /HTTPS URL/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example#frag","displayName":"A"}',
    /HTTPS URL/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://","displayName":"A"}',
    /HTTPS URL/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example"}',
    /displayName/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example","displayName":""}',
    /displayName/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example","displayName":42}',
    /displayName/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example","displayName":"A","companionName":""}',
    /companionName/,
  );
  await rejects(
    'cloud-room:configure {"roomOrigin":"https://room.example","displayName":"A","companionName":7}',
    /companionName/,
  );
});

test("cloud-room configuration persists atomically with 0600 and is git-ignored", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: {
      roomOrigin: "https://room.example/",
      displayName: "Alice",
      companionName: "Bob",
    },
  });

  const configPath = path.join(configDir, ".cloud-room.json");
  const fileStat = await stat(configPath);
  if (process.platform !== "win32") {
    // Windows has no POSIX permission bits; stat().mode only distinguishes
    // read-only vs writable there, so 0600 is only assertable on POSIX.
    assert.equal(fileStat.mode & 0o777, 0o600);
  }

  const expected = {
    roomOrigin: "https://room.example",
    displayName: "Alice",
    companionName: "Bob",
  };
  assert.equal(
    (await readFile(configPath, "utf8")).trim(),
    JSON.stringify(expected, null, 2),
  );
  assert.deepEqual(await readCloudRoomConfig({ configDir }), expected);

  const leftovers = (await readdir(configDir)).filter(
    (name) => name.endsWith(".tmp"),
  );
  assert.deepEqual(leftovers, []);

  const gitignore = await readFile(path.join(REPO_ROOT, ".gitignore"), "utf8");
  assert.match(gitignore, /(^|\n)\.cloud-room\.json(\n|$)/);
});

test("readCloudRoomConfig reports missing and corrupt files", async (t) => {
  const configDir = await tempConfigDir(t);

  await assert.rejects(
    readCloudRoomConfig({ configDir }),
    /Unable to read cloud Room configuration/,
  );

  await writeFile(path.join(configDir, ".cloud-room.json"), "{not json", "utf8");
  await assert.rejects(
    readCloudRoomConfig({ configDir }),
    /is invalid/,
  );
});

test("package.json exposes runnable cloud-room scripts", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["cloud-room:setup"],
    "node local-agent-edge/cloud-room.js setup",
  );
  assert.equal(
    packageJson.scripts["cloud-room:create"],
    "node local-agent-edge/cloud-room.js create",
  );
  assert.equal(
    packageJson.scripts["cloud-room:join"],
    "node local-agent-edge/cloud-room.js join",
  );
});

test("runCloudRoomSetup prints the AI request and saves exactly one valid line", async (t) => {
  const configDir = await tempConfigDir(t);
  const output = capturedOutput();
  const input = new PassThrough();
  input.setEncoding("utf8");
  const pending = runCloudRoomSetup({
    input,
    output: output.stream,
    configDir,
  });
  input.write(
    'cloud-room:configure {"roomOrigin":"https://room.example","displayName":"Alice"}\n',
  );
  input.end();
  await pending;

  assert.match(output.text(), /cloud-room:configure \{JSON\}/);
  assert.match(output.text(), /Configuration saved\./);
  assert.deepEqual(await readCloudRoomConfig({ configDir }), {
    roomOrigin: "https://room.example",
    displayName: "Alice",
  });

  // an invalid input line rejects and writes nothing
  const secondDir = await tempConfigDir(t);
  const output2 = capturedOutput();
  const input2 = new PassThrough();
  input2.setEncoding("utf8");
  const pending2 = runCloudRoomSetup({
    input: input2,
    output: output2.stream,
    configDir: secondDir,
  });
  input2.write("not a configuration\n");
  input2.end();
  await assert.rejects(pending2, /one cloud-room:configure/);
  await assert.rejects(
    readCloudRoomConfig({ configDir: secondDir }),
    /Unable to read cloud Room configuration/,
  );
});

test("create follows config, edge, pairing, observer, connector order and prints only the invite code", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: {
      roomOrigin: "https://room.example",
      displayName: "Alice",
      companionName: "Bob",
    },
  });
  const stubs = orderedStubs();
  const mcp = stubGlobalMcp(t, { create_room: CREATE_RESULT }, stubs.order);
  const output = capturedOutput();

  await runCloudRoomCreate({
    configDir,
    startEdge: stubs.startEdge,
    openBrowser: stubs.openBrowser,
    runConnector: stubs.runConnector,
    output: output.stream,
  });

  assert.deepEqual(stubs.order, [
    "edge",
    "mcp:create_room",
    "browser",
    "connector",
    "edge-close",
  ]);
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0].url, "https://room.example/mcp");
  assert.deepEqual(mcp[0].args, {});
  assert.equal(output.text(), "Invite code: invite-1\n");
  assert.ok(!output.text().includes("cap-a-secret"));
  assert.ok(!output.text().includes("bootstrap-a-secret"));
  assert.ok(!output.text().includes("/observe/"));
});

test("join follows the same order, redeems the invite, and prints no authority", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: { roomOrigin: "https://room.example", displayName: "Bob" },
  });
  const stubs = orderedStubs();
  const mcp = stubGlobalMcp(t, { redeem_invite: REDEEM_RESULT }, stubs.order);
  const output = capturedOutput();

  await runCloudRoomJoin({
    inviteCode: " invite-1 ",
    configDir,
    startEdge: stubs.startEdge,
    openBrowser: stubs.openBrowser,
    runConnector: stubs.runConnector,
    output: output.stream,
  });

  assert.deepEqual(stubs.order, [
    "edge",
    "mcp:redeem_invite",
    "browser",
    "connector",
    "edge-close",
  ]);
  assert.equal(mcp.length, 1);
  assert.deepEqual(mcp[0].args, { invite_code: "invite-1" });
  assert.equal(output.text(), "");
  assert.ok(!output.text().includes("cap-b-secret"));
  assert.ok(!output.text().includes("bootstrap-b-secret"));

  await assert.rejects(
    runCloudRoomJoin({
      inviteCode: "   ",
      configDir,
      output: output.stream,
    }),
    /inviteCode must be a non-empty string/,
  );
});

test("edge startup failure performs zero MCP calls and directs to edge:setup", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: { roomOrigin: "https://room.example", displayName: "Alice" },
  });
  const mcp = stubGlobalMcp(t, { create_room: CREATE_RESULT });
  const output = capturedOutput();

  await assert.rejects(
    runCloudRoomCreate({
      configDir,
      startEdge: async () => { throw new Error("edge boom"); },
      openBrowser: async () => {},
      runConnector: async () => {},
      output: output.stream,
    }),
    /edge boom/,
  );
  assert.equal(mcp.length, 0);
  assert.equal(output.text(), "");

  // the real startConfiguredLocalAgentEdge with a missing edge configuration
  const secondDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir: secondDir,
    config: { roomOrigin: "https://room.example", displayName: "Alice" },
  });
  const output2 = capturedOutput();
  await assert.rejects(
    runCloudRoomCreate({ configDir: secondDir, output: output2.stream }),
    /Unable to read Local Agent Edge configuration/,
  );
  assert.equal(mcp.length, 0);
  assert.match(output2.text(), /npm run edge:setup/);
});

test("opener failure starts zero connectors and leaks no authority", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: { roomOrigin: "https://room.example", displayName: "Alice" },
  });
  const mcp = stubGlobalMcp(t, {
    create_room: CREATE_RESULT,
    redeem_invite: REDEEM_RESULT,
  });
  const output = capturedOutput();
  const edge = {
    baseUrl: "http://127.0.0.1:9",
    close: async () => {},
  };
  let connectorCalls = 0;

  await assert.rejects(
    runCloudRoomCreate({
      configDir,
      startEdge: async () => edge,
      openBrowser: async () => { throw new Error("browser boom"); },
      runConnector: async () => { connectorCalls += 1; },
      output: output.stream,
    }),
    /Failed to open the observer browser/,
  );
  assert.equal(connectorCalls, 0);
  assert.equal(mcp.length, 1);
  assert.ok(!output.text().includes("cap-a-secret"));
  assert.ok(!output.text().includes("bootstrap-a-secret"));
  assert.ok(!output.text().includes("/observe/"));

  await assert.rejects(
    runCloudRoomJoin({
      inviteCode: "invite-1",
      configDir,
      startEdge: async () => edge,
      openBrowser: async () => { throw new Error("browser boom"); },
      runConnector: async () => { connectorCalls += 1; },
      output: output.stream,
    }),
    /create a new Room/,
  );
  assert.equal(connectorCalls, 0);
  assert.equal(mcp.length, 2);
  assert.equal(mcp[1].name, "redeem_invite");
  assert.ok(!output.text().includes("cap-b-secret"));
  assert.ok(!output.text().includes("bootstrap-b-secret"));
});

test("connector failure still closes the edge", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: { roomOrigin: "https://room.example", displayName: "Alice" },
  });
  stubGlobalMcp(t, { create_room: CREATE_RESULT });
  let closeCalls = 0;
  const edge = {
    baseUrl: "http://127.0.0.1:9",
    close: async () => { closeCalls += 1; },
  };

  await assert.rejects(
    runCloudRoomCreate({
      configDir,
      startEdge: async () => edge,
      openBrowser: async () => {},
      runConnector: async () => { throw new Error("connector boom"); },
      output: capturedOutput().stream,
    }),
    /connector boom/,
  );
  assert.equal(closeCalls, 1);
});

test("create reuses the existing configured Local Agent Edge", async (t) => {
  const configDir = await tempConfigDir(t);
  await writeCloudRoomConfig({
    configDir,
    config: { roomOrigin: "https://room.example", displayName: "Alice" },
  });
  const fakeCli = path.join(configDir, "fake-cli.js");
  await writeFile(fakeCli, "process.stdin.pipe(process.stdout);\n");
  await writeLocalAgentEdgeConfig({
    configDir,
    config: {
      command: process.execPath,
      args: [fakeCli],
      cwd: configDir,
      env: {},
      port: 0,
    },
  });

  const mcp = stubGlobalMcp(t, { create_room: CREATE_RESULT });
  const output = capturedOutput();
  await runCloudRoomCreate({
    configDir,
    openBrowser: async () => {},
    runConnector: async () => {},
    output: output.stream,
  });

  const text = output.text();
  assert.match(text, /Local Agent Edge is ready/);
  assert.ok(
    text.indexOf("Local Agent Edge is ready") < text.indexOf("Invite code: invite-1"),
    "the edge must start before global pairing",
  );
  assert.equal(mcp.length, 1);
  assert.equal(mcp[0].name, "create_room");
});

test("browser opener uses the platform-specific execFile invocation", async () => {
  const calls = [];
  const exec = async (command, args) => { calls.push({ command, args }); };
  const url = "https://room.example/observe/token-value";

  await defaultOpenBrowser(url, { exec, platform: "darwin" });
  await defaultOpenBrowser(url, { exec, platform: "linux" });
  await defaultOpenBrowser(url, { exec, platform: "win32" });

  assert.deepEqual(calls, [
    { command: "open", args: [url] },
    { command: "xdg-open", args: [url] },
    { command: "cmd.exe", args: ["/c", "start", "", url] },
  ]);

  await assert.rejects(
    defaultOpenBrowser(url, { exec, platform: "freebsd" }),
    /Unsupported platform/,
  );
});
