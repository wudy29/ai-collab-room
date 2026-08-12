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
