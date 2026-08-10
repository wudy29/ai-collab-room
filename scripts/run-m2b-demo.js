import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";
import { createA2AModelAgentServer } from "../src/a2a-model-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { DEMU_IDENTITY } from "../src/demu-identity.js";
import { loadOmbreContinuity } from "../src/ombre-continuity.js";

const requestedRoomPort = Number(process.env.ROOM_PORT ?? 8787);
const requestedAgentPort = Number(process.env.A2A_PORT ?? 41241);
const holdOpen = process.env.M2B_HOLD_OPEN !== "0";
const host = "127.0.0.1";

const { server: roomServer, store } = createRoomServer();
await listen(roomServer, requestedRoomPort, host);

let agent;
let continuityContext;
try {
  continuityContext = await loadOmbreContinuity({
    query: "天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？",
    maxResults: 1,
  });
  assert.ok(
    continuityContext.includes("午后乌云压低时，窗边的铜铃一响"),
  );
  agent = await createA2AModelAgentServer({
    host,
    port: requestedAgentPort,
    identity: DEMU_IDENTITY,
    continuityContext,
  });
} catch (error) {
  await closeServer(roomServer);
  throw error;
} finally {
  continuityContext = undefined;
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
        display_name: DEMU_IDENTITY.displayName,
        companion_name: DEMU_IDENTITY.companionName,
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
          message:
            "你好，徳牧先生。我是测试 B，很高兴认识你和小猫。",
        },
        {
          message:
            "收到。你的身份表达和房间连续性已经验证，本次会面结束。",
          action: "end",
        },
      ],
    }),
  ]);

  const messages = store.events.filter(
    (event) => event.type === "message",
  );

  assert.equal(store.room.status, "ended");
  assert.equal(store.sides.A.identity.display_name, "徳牧先生");
  assert.equal(store.sides.A.identity.companion_name, "小猫");
  assert.equal(messages.length, 4);
  assert.deepEqual(
    messages.map((event) => event.side),
    ["A", "B", "A", "B"],
  );

  const firstReply = messages[0].payload.content;
  assert.match(firstReply, /徳牧先生/);
  assert.match(firstReply, /小猫/);

  const secondReply = messages[2].payload.content;
  assert.doesNotMatch(secondReply, /真实模型测试 A|M1 Real Model Agent/);

  console.log(`M2b demo complete: ${messages.length} messages`);
  for (const event of messages) {
    console.log(`${event.side}: ${event.payload.content}`);
  }
  console.log(`Observer page: ${roomBaseUrl}`);
  console.log(`Agent Card: ${agent.agentCardUrl}`);

  await agent.close();
  agent = undefined;
  console.log("M2b meeting agent closed; continuity context released.");
} catch (error) {
  await Promise.allSettled([
    closeServer(roomServer),
    agent?.close?.(),
  ]);
  throw error;
}

if (!holdOpen) {
  await closeServer(roomServer);
  console.log("M2b smoke complete; servers closed.");
} else {
  console.log("Observer page remains open; A agent is already closed.");
  console.log("Press Ctrl+C to stop the observer server.");

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await closeServer(roomServer);
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
