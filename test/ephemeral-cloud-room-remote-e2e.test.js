import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { createA2ATestAgentServer } from "../src/a2a-test-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";

const EIGHT_ALTERNATING_SIDES = ["A", "B", "A", "B", "A", "B", "A", "B"];

async function callGlobalTool(origin, name, args) {
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

async function bootstrapObserverSession(origin, roomId, token) {
  const response = await fetch(`${origin}/observe/${token}`, {
    redirect: "manual",
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `/rooms/${roomId}`);
  const cookie = response.headers.get("set-cookie");
  assert.match(
    cookie,
    new RegExp(
      `^room_observer=[A-Za-z0-9_-]+; Secure; HttpOnly; SameSite=Strict; Path=/rooms/${roomId}$`,
    ),
  );
  return cookie.split(";")[0].split("=")[1];
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

test("two remote-style A2A connectors complete an eight-message room visible to both observers", async (t) => {
  // production defaults: production registry, so RoomStore({ maxTurns: 8 })
  const { server } = createRoomServer({ logger: { error() {} } });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await closeServer(server);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;

  // two independently started local A2A test endpoints
  const agentA = await createA2ATestAgentServer();
  const agentB = await createA2ATestAgentServer();
  t.after(() => agentA.close());
  t.after(() => agentB.close());
  assert.notEqual(agentA.baseUrl, agentB.baseUrl);

  // pair A and B through the global MCP surface
  const created = await callGlobalTool(origin, "create_room", {});
  const redeemed = await callGlobalTool(origin, "redeem_invite", {
    invite_code: created.invite_code,
  });
  assert.equal(redeemed.room_id, created.room_id);
  assert.notEqual(redeemed.side_capability, created.side_capability);
  assert.notEqual(
    redeemed.observer_bootstrap_token,
    created.observer_bootstrap_token,
  );
  const roomBaseUrl = `${origin}/rooms/${created.room_id}`;

  // separate observer bootstrap sessions for both participants
  const observerA = await bootstrapObserverSession(
    origin,
    created.room_id,
    created.observer_bootstrap_token,
  );
  const observerB = await bootstrapObserverSession(
    origin,
    redeemed.room_id,
    redeemed.observer_bootstrap_token,
  );
  assert.notEqual(observerA, observerB);

  // both connectors run against the same remote-style Room base URL, each
  // with its own capability and identity; the room ends by the 8-turn limit
  await Promise.all([
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agentA.baseUrl,
      roomCapability: created.side_capability,
      identity: { display_name: "远程 A" },
      log() {},
    }),
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agentB.baseUrl,
      roomCapability: redeemed.side_capability,
      identity: { display_name: "远程 B" },
      log() {},
    }),
  ]);

  // external assertion surface: both authorized observer sessions
  const responseA = await fetch(`${roomBaseUrl}/api/state`, {
    headers: { cookie: `room_observer=${observerA}` },
  });
  assert.equal(responseA.status, 200);
  const responseB = await fetch(`${roomBaseUrl}/api/state`, {
    headers: { cookie: `room_observer=${observerB}` },
  });
  assert.equal(responseB.status, 200);
  const snapshotA = await responseA.json();
  const snapshotB = await responseB.json();

  // the production default Room has eight maximum turns and has ended
  assert.equal(snapshotA.room.max_turns, 8);
  assert.equal(snapshotA.room.status, "ended");
  assert.equal(typeof snapshotA.room.ended_at, "string");

  const messagesA = snapshotA.events.filter((event) => event.type === "message");
  const messagesB = snapshotB.events.filter((event) => event.type === "message");

  // exactly eight alternating A/B messages
  assert.equal(messagesA.length, 8);
  assert.deepEqual(
    messagesA.map((event) => event.side),
    EIGHT_ALTERNATING_SIDES,
  );
  assert.ok(
    messagesA.every((event) => event.payload.content.trim().length > 0),
  );

  // both observers see the same complete eight-message transcript
  assert.deepEqual(messagesB, messagesA);
});
