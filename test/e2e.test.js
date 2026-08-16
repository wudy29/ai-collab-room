import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
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

test("two fake connectors complete a strict four-message room", async (t) => {
  let store;
  const registry = new EphemeralRoomRegistry({
    createStore: ({ roomId }) => {
      store = new RoomStore({ id: roomId, maxTurns: 4 });
      return store;
    },
  });
  const { server } = createRoomServer({ registry, logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const origin = `http://127.0.0.1:${server.address().port}`;
  const { created, redeemed } = await pairRoom(origin);
  const roomBaseUrl = `${origin}/rooms/${created.room_id}`;
  const logs = [];

  await Promise.all([
    runFakeConnector({
      roomBaseUrl,
      roomCapability: created.side_capability,
      identity: { display_name: "测试 A" },
      script: [
        { message: "你好，我是测试 A。" },
        { message: "测试结束。" },
      ],
      log: (line) => logs.push(line),
    }),
    runFakeConnector({
      roomBaseUrl,
      roomCapability: redeemed.side_capability,
      identity: { display_name: "测试 B" },
      script: [
        { message: "你好，我是测试 B，我收到了。" },
        { message: "好，结束。", action: "end" },
      ],
      log: (line) => logs.push(line),
    }),
  ]);

  const messages = store.events.filter((event) => event.type === "message");
  assert.equal(store.room.status, "ended");
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((event) => event.side), ["A", "B", "A", "B"]);
  assert.deepEqual(messages.map((event) => event.payload.content), [
    "你好，我是测试 A。",
    "你好，我是测试 B，我收到了。",
    "测试结束。",
    "好，结束。",
  ]);
  assert.ok(logs.some((line) => line.includes("room ended")) || logs.some((line) => line.includes("好，结束")));
});

test("observer state endpoint returns the room's shared event history", async (t) => {
  const { server } = createRoomServer({ logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;

  const { created, redeemed } = await pairRoom(origin);
  const roomUrl = `${origin}/rooms/${created.room_id}`;

  const rpc = async (id, name, args, capability) => {
    const response = await fetch(`${roomUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${capability}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return response.json();
  };

  await rpc(1, "join_room", { public_identity: { display_name: "A" } }, created.side_capability);
  await rpc(2, "join_room", { public_identity: { display_name: "B" } }, redeemed.side_capability);

  const bootstrap = await fetch(`${origin}/observe/${created.observer_bootstrap_token}`, {
    redirect: "manual",
  });
  assert.equal(bootstrap.status, 303);
  const sessionId = bootstrap.headers.get("set-cookie").split(";")[0].split("=")[1];

  const snapshot = await fetch(`${roomUrl}/api/state`, {
    headers: { cookie: `room_observer=${sessionId}` },
  }).then((response) => response.json());
  assert.equal(snapshot.room.id, created.room_id);
  assert.equal(snapshot.room.status, "active");
  assert.equal(snapshot.sides.A.identity.display_name, "A");
  assert.equal(snapshot.sides.B.identity.display_name, "B");
  assert.ok(snapshot.events.some((event) => event.type === "turn_ready"));
});
