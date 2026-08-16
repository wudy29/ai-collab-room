import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { startConfiguredLocalAgentEdge } from "./onboarding.js";
import {
  parseCloudRoomConfigurationCommand,
  readCloudRoomConfig,
  writeCloudRoomConfig,
} from "./cloud-room-config.js";

const execFileAsync = promisify(execFile);

const SETUP_PROMPT = `Give the following request to your own AI:

I want to run an ephemeral cloud Room with my local Agent. Reply with exactly
one complete line in this format:
cloud-room:configure {"roomOrigin":"https://...","displayName":"...","companionName":"..."}

Use only an HTTPS room origin and your display identity. Omit passwords,
tokens, API keys, cookies, session values, capabilities, observer links, and
all other secrets.

Paste that one cloud-room:configure {JSON} line here:
`;

export async function runCloudRoomSetup({
  input,
  output,
  configDir,
} = {}) {
  if (!input || typeof input.on !== "function") {
    throw new TypeError("input must be a readable stream");
  }
  if (!output || typeof output.write !== "function") {
    throw new TypeError("output must be a writable stream");
  }

  output.write(SETUP_PROMPT);
  const readline = createInterface({ input, output, terminal: false });
  let line;
  try {
    line = await readline.question("");
  } finally {
    readline.close();
  }

  const config = await parseCloudRoomConfigurationCommand(line);
  await writeCloudRoomConfig({ configDir, config });
  output.write(
    "Configuration saved.\nNext: npm run cloud-room:create or npm run cloud-room:join <invite-code>\n",
  );
}

export async function runCloudRoomCreate({
  configDir,
  openBrowser = defaultOpenBrowser,
  startEdge = defaultStartEdge,
  runConnector = runA2ARoomConnector,
  output = process.stdout,
} = {}) {
  const config = await readConfigOrFail({ configDir });
  const edge = await startEdge({ configDir, output });
  try {
    const created = await callGlobalMcp(config.roomOrigin, "create_room", {});
    try {
      await openBrowser(`${config.roomOrigin}/observe/${created.observer_bootstrap_token}`);
    } catch (error) {
      throw new Error("Failed to open the observer browser.", { cause: error });
    }
    output.write(`Invite code: ${created.invite_code}\n`);
    await runConnector({
      roomBaseUrl: `${config.roomOrigin}/rooms/${created.room_id}`,
      agentBaseUrl: edge.baseUrl,
      roomCapability: created.side_capability,
      identity: identityFromConfig(config),
      log: (line) => output.write(`${line}\n`),
    });
  } finally {
    await edge.close();
  }
}

export async function runCloudRoomJoin({
  inviteCode,
  configDir,
  openBrowser = defaultOpenBrowser,
  startEdge = defaultStartEdge,
  runConnector = runA2ARoomConnector,
  output = process.stdout,
} = {}) {
  if (typeof inviteCode !== "string" || !inviteCode.trim()) {
    throw new TypeError("inviteCode must be a non-empty string");
  }

  const config = await readConfigOrFail({ configDir });
  const edge = await startEdge({ configDir, output });
  try {
    const redeemed = await callGlobalMcp(config.roomOrigin, "redeem_invite", {
      invite_code: inviteCode.trim(),
    });
    try {
      await openBrowser(`${config.roomOrigin}/observe/${redeemed.observer_bootstrap_token}`);
    } catch (error) {
      throw new Error(
        "Failed to open the observer browser.\n"
        + "The invite has already been redeemed; create a new Room and share its new invite.",
        { cause: error },
      );
    }
    await runConnector({
      roomBaseUrl: `${config.roomOrigin}/rooms/${redeemed.room_id}`,
      agentBaseUrl: edge.baseUrl,
      roomCapability: redeemed.side_capability,
      identity: identityFromConfig(config),
      log: (line) => output.write(`${line}\n`),
    });
  } finally {
    await edge.close();
  }
}

export async function defaultOpenBrowser(
  url,
  { exec = execFileAsync, platform = process.platform } = {},
) {
  if (platform === "darwin") {
    await exec("open", [url]);
  } else if (platform === "linux") {
    await exec("xdg-open", [url]);
  } else if (platform === "win32") {
    await exec("cmd.exe", ["/c", "start", "", url]);
  } else {
    throw new Error(`Unsupported platform for opening a browser: ${platform}`);
  }
}

async function defaultStartEdge({ configDir, output }) {
  return startConfiguredLocalAgentEdge({ configDir, output });
}

async function readConfigOrFail({ configDir }) {
  try {
    return await readCloudRoomConfig({ configDir });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n`
      + "Next: run npm run cloud-room:setup to create a configuration.",
      { cause: error },
    );
  }
}

async function callGlobalMcp(roomOrigin, name, args) {
  const response = await fetch(`${roomOrigin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await response.json();
  if (body.error) {
    throw new Error(
      `${body.error.data?.room_code ?? body.error.code}: ${body.error.message}`,
    );
  }
  return body.result.structuredContent;
}

function identityFromConfig(config) {
  return {
    display_name: config.displayName,
    ...(config.companionName === undefined
      ? {}
      : { companion_name: config.companionName }),
  };
}

async function main() {
  const command = process.argv[2];
  const configDir = process.cwd();

  if (command === "setup") {
    await runCloudRoomSetup({
      input: process.stdin,
      output: process.stdout,
      configDir,
    });
    return;
  }

  if (command === "create") {
    await runCloudRoomCreate({ configDir, output: process.stdout });
    return;
  }

  if (command === "join") {
    const inviteCode = process.argv[3];
    if (typeof inviteCode !== "string" || !inviteCode.trim()) {
      throw new Error("Usage: cloud-room.js join <invite-code>");
    }
    await runCloudRoomJoin({
      inviteCode: inviteCode.trim(),
      configDir,
      output: process.stdout,
    });
    return;
  }

  throw new Error("Usage: cloud-room.js setup|create|join [invite-code]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/Unable to read Local Agent Edge configuration|Configured command is unavailable|EADDRINUSE/.test(
        message,
      )
    ) {
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  });
}
