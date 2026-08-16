import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
import { createA2ATestAgentServer } from "../src/a2a-test-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { EphemeralRoomRegistry } from "../src/ephemeral-room-registry.js";
import { RoomStore } from "../src/room-store.js";

async function pairRoom(origin) {
  const rpc = async (name, args) => {
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
  };

  const created = await rpc("create_room", {});
  const redeemed = await rpc("redeem_invite", {
    invite_code: created.invite_code,
  });
  return { created, redeemed };
}

test("A2A side A and fake side B complete the M0 room", async (t) => {
  let store;
  const registry = new EphemeralRoomRegistry({
    createStore: ({ roomId }) => {
      store = new RoomStore({ id: roomId, maxTurns: 4 });
      return store;
    },
  });
  const { server: roomServer } = createRoomServer({
    registry,
    logger: { error() {} },
  });
  await new Promise((resolve) => {
    roomServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeServer(roomServer));

  const origin = `http://127.0.0.1:${roomServer.address().port}`;
  const { created, redeemed } = await pairRoom(origin);
  const roomBaseUrl = `${origin}/rooms/${created.room_id}`;
  const agent = await createA2ATestAgentServer();
  t.after(() => agent.close());

  const cardResponse = await fetch(
    `${agent.baseUrl}/.well-known/agent-card.json`,
  );
  assert.equal(cardResponse.status, 200);
  const card = await cardResponse.json();
  assert.equal(card.name, "M0.5 Test Agent");
  assert.ok(
    card.supportedInterfaces.some(
      (entry) => entry.protocolBinding === "JSONRPC",
    ),
  );

  await Promise.all([
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agent.baseUrl,
      roomCapability: created.side_capability,
      identity: { display_name: "A2A 测试 A" },
      log() {},
    }),
    runFakeConnector({
      roomBaseUrl,
      roomCapability: redeemed.side_capability,
      identity: { display_name: "测试 B" },
      script: [
        { message: "你好，我是测试 B，我收到了。" },
        { message: "好，结束。", action: "end" },
      ],
      log() {},
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
  assert.deepEqual(
    messages.map((event) => event.payload.content),
    [
      "你好，我是通过 A2A 接入的测试 A。",
      "你好，我是测试 B，我收到了。",
      "A2A 适配验证完成。",
      "好，结束。",
    ],
  );
});

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
