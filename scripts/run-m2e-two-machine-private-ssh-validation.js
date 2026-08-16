import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createRoomServer } from "../src/server.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { EphemeralRoomRegistry } from "../src/ephemeral-room-registry.js";
import { RoomStore } from "../src/room-store.js";

const host = "127.0.0.1";

export async function runM2ETwoMachinePrivateSshValidation({
  agentAUrl,
  agentBUrl,
  log = console.log,
}) {
  assertA2ABaseUrl("agentAUrl", agentAUrl);
  assertA2ABaseUrl("agentBUrl", agentBUrl);

  let store;
  const registry = new EphemeralRoomRegistry({
    createStore: ({ roomId }) => {
      store = new RoomStore({ id: roomId, maxTurns: 4 });
      return store;
    },
  });
  const { server: roomServer } = createRoomServer({ registry });
  await listen(roomServer, 0, host);

  try {
    const roomAddress = roomServer.address();
    const roomOrigin = `http://${host}:${roomAddress.port}`;

    const created = await callGlobalMcp(roomOrigin, "create_room", {});
    const redeemed = await callGlobalMcp(roomOrigin, "redeem_invite", {
      invite_code: created.invite_code,
    });
    assert.equal(redeemed.room_id, created.room_id);
    const roomBaseUrl = `${roomOrigin}/rooms/${created.room_id}`;

    await Promise.all([
      runA2ARoomConnector({
        roomBaseUrl,
        agentBaseUrl: agentAUrl,
        roomCapability: created.side_capability,
        identity: {
          display_name: "Agent A",
          companion_name: "User A",
        },
        log,
      }),
      runA2ARoomConnector({
        roomBaseUrl,
        agentBaseUrl: agentBUrl,
        roomCapability: redeemed.side_capability,
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
      roomOrigin,
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
  console.log(`Observer page: ${validation.roomOrigin}`);
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

async function callGlobalMcp(origin, name, args) {
  const response = await fetch(`${origin}/mcp`, {
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
    throw new Error(`${body.error.data?.room_code ?? body.error.code}: ${body.error.message}`);
  }
  return body.result.structuredContent;
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
