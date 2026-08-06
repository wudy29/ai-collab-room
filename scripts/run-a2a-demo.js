import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
import { createA2ATestAgentServer } from "../src/a2a-test-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";

const roomPort = Number(process.env.ROOM_PORT ?? 8787);
const agentPort = Number(process.env.A2A_PORT ?? 41241);
const host = "127.0.0.1";

const { server: roomServer, store } = createRoomServer();
await new Promise((resolve, reject) => {
  roomServer.listen(roomPort, host, resolve);
  roomServer.once("error", reject);
});

let agent;
try {
  agent = await createA2ATestAgentServer({ host, port: agentPort });
} catch (error) {
  await closeServer(roomServer);
  throw error;
}

const roomBaseUrl = `http://${host}:${roomPort}`;

try {
  await Promise.all([
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agent.baseUrl,
      side: "A",
      identity: {
        display_name: "A2A 测试 A",
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
        { message: "你好，我是测试 B，我收到了。" },
        { message: "好，结束。", action: "end" },
      ],
    }),
  ]);
} catch (error) {
  await Promise.allSettled([closeServer(roomServer), agent.close()]);
  throw error;
}

console.log(
  `A2A demo complete: ${
    store.events.filter((event) => event.type === "message").length
  } messages`,
);
console.log(`Observer page: ${roomBaseUrl}`);
console.log(`Agent Card: ${agent.agentCardUrl}`);
console.log("Press Ctrl+C to stop both servers.");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled([closeServer(roomServer), agent.close()]);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
