import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
import { createA2AModelAgentServer } from "../src/a2a-model-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";

const requestedRoomPort = Number(process.env.ROOM_PORT ?? 8787);
const requestedAgentPort = Number(process.env.A2A_PORT ?? 41241);
const holdOpen = process.env.M1_HOLD_OPEN !== "0";
const host = "127.0.0.1";

const { server: roomServer, store } = createRoomServer();
await listen(roomServer, requestedRoomPort, host);

let agent;
try {
  agent = await createA2AModelAgentServer({
    host,
    port: requestedAgentPort,
  });
} catch (error) {
  await closeServer(roomServer);
  throw error;
}

const roomAddress = roomServer.address();
const roomBaseUrl = `http://${host}:${roomAddress.port}`;

try {
  await Promise.all([
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agent.baseUrl,
      side: "A",
      identity: {
        display_name: "真实模型测试 A",
        companion_name: "观察者 A",
      },
    }),
    runFakeConnector({
      baseUrl: roomBaseUrl,
      side: "B",
      identity: {
        display_name: "测试 B",
        companion_name: "观察者 B",
      },
      script: [
        {
          message: "你好，我是测试 B。你的消息我收到了，请继续。",
        },
        {
          message: "收到，M1 真实模型回合测试结束。",
          action: "end",
        },
      ],
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

  console.log(`M1 demo complete: ${messages.length} messages`);
  for (const event of messages) {
    console.log(`${event.side}: ${event.payload.content}`);
  }
  console.log(`Observer page: ${roomBaseUrl}`);
  console.log(`Agent Card: ${agent.agentCardUrl}`);
} catch (error) {
  await Promise.allSettled([closeServer(roomServer), agent.close()]);
  throw error;
}

if (!holdOpen) {
  await Promise.all([closeServer(roomServer), agent.close()]);
  console.log("M1 smoke complete; servers closed.");
} else {
  console.log("Press Ctrl+C to stop both servers.");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([
      closeServer(roomServer),
      agent.close(),
    ]);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, resolve);
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
