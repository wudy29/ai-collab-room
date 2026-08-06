import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
import { createA2ATestAgentServer } from "../src/a2a-test-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";

test("A2A side A and fake side B complete the M0 room", async (t) => {
  const { server: roomServer, store } = createRoomServer({
    logger: { error() {} },
  });
  await new Promise((resolve) => {
    roomServer.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => closeServer(roomServer));

  const roomAddress = roomServer.address();
  const roomBaseUrl = `http://127.0.0.1:${roomAddress.port}`;
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
      side: "A",
      identity: { display_name: "A2A 测试 A" },
      log() {},
    }),
    runFakeConnector({
      baseUrl: roomBaseUrl,
      side: "B",
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
