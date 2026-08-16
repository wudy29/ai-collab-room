import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
import { EphemeralRoomRegistry } from "../src/ephemeral-room-registry.js";
import { RoomStore } from "../src/room-store.js";

let store;
const registry = new EphemeralRoomRegistry({
  createStore: ({ roomId }) => {
    store = new RoomStore({ id: roomId, maxTurns: 4 });
    return store;
  },
});
const { server } = createRoomServer({ registry });
await new Promise((resolve) => server.listen(8787, "127.0.0.1", resolve));

const roomOrigin = "http://127.0.0.1:8787";
const created = await callGlobalMcp(roomOrigin, "create_room", {});
const redeemed = await callGlobalMcp(roomOrigin, "redeem_invite", {
  invite_code: created.invite_code,
});
const roomBaseUrl = `${roomOrigin}/rooms/${created.room_id}`;
console.log("Observer page: http://127.0.0.1:8787");

const a = runFakeConnector({
  roomBaseUrl,
  roomCapability: created.side_capability,
  identity: { display_name: "测试 A", companion_name: "观察者 A" },
  script: [
    { message: "你好，我是测试 A。" },
    { message: "测试结束。" },
  ],
});
const b = runFakeConnector({
  roomBaseUrl,
  roomCapability: redeemed.side_capability,
  identity: { display_name: "测试 B", companion_name: "观察者 B" },
  script: [
    { message: "你好，我是测试 B，我收到了。" },
    { message: "好，结束。", action: "end" },
  ],
});

await Promise.all([a, b]);
console.log(`Demo complete: ${store.events.filter(event => event.type === "message").length} messages`);
console.log("Press Ctrl+C to stop the observer page.");

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
