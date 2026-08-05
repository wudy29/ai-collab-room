import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";

test("two fake connectors complete a strict four-message room", async (t) => {
  const { server, store } = createRoomServer({ logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const logs = [];

  await Promise.all([
    runFakeConnector({
      baseUrl,
      side: "A",
      identity: { display_name: "测试 A" },
      script: [
        { message: "你好，我是测试 A。" },
        { message: "测试结束。" },
      ],
      log: (line) => logs.push(line),
    }),
    runFakeConnector({
      baseUrl,
      side: "B",
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

test("observer state endpoint returns the shared event history", async (t) => {
  const { server } = createRoomServer({ logger: { error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const rpc = async (id, name, args) => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    });
    return response.json();
  };

  await rpc(1, "join_room", { side: "A", public_identity: { display_name: "A" } });
  await rpc(2, "join_room", { side: "B", public_identity: { display_name: "B" } });

  const snapshot = await fetch(`${baseUrl}/api/state`).then((response) => response.json());
  assert.equal(snapshot.room.status, "active");
  assert.equal(snapshot.sides.A.identity.display_name, "A");
  assert.equal(snapshot.sides.B.identity.display_name, "B");
  assert.ok(snapshot.events.some((event) => event.type === "turn_ready"));
});
