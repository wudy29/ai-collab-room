import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { createA2AModelAgentServer } from "../src/a2a-model-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { DEMU_IDENTITY } from "../src/demu-identity.js";
import { loadOmbreContinuity } from "../src/ombre-continuity.js";

const host = "127.0.0.1";
const B_IDENTITY = Object.freeze({
  displayName: "测试 B",
  companionName: "对方伙伴",
  description: "你是本轮双真实 Agent 验收中的独立测试参与者。",
  relationship: "",
  style: [],
  continuity: [],
});

const { server: roomServer, store } = createRoomServer();
let agentA;
let agentB;
let cleaning = false;

const cleanup = async () => {
  if (cleaning) return;
  cleaning = true;
  await Promise.allSettled([
    agentA?.close?.(),
    agentB?.close?.(),
    closeServer(roomServer),
  ]);
};

const onSigint = () => {
  void cleanup().finally(() => process.exit(130));
};
const onSigterm = () => {
  void cleanup().finally(() => process.exit(143));
};
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  await listen(roomServer, 0, host);
  const roomAddress = roomServer.address();
  const roomBaseUrl = `http://${host}:${roomAddress.port}`;

  const continuityContext = await loadOmbreContinuity({
    query: "天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？",
    maxResults: 1,
  });
  assert.ok(
    continuityContext.includes("午后乌云压低时，窗边的铜铃一响"),
  );

  agentA = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: DEMU_IDENTITY,
    continuityContext,
  });

  agentB = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: B_IDENTITY,
  });

  await Promise.all([
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agentA.baseUrl,
      side: "A",
      identity: {
        display_name: DEMU_IDENTITY.displayName,
        companion_name: DEMU_IDENTITY.companionName,
      },
    }),
    runA2ARoomConnector({
      roomBaseUrl,
      agentBaseUrl: agentB.baseUrl,
      side: "B",
      identity: {
        display_name: B_IDENTITY.displayName,
        companion_name: B_IDENTITY.companionName,
      },
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

  assert.equal(store.sides.A.identity.display_name, "徳牧先生");
  assert.equal(store.sides.A.identity.companion_name, "小猫");
  assert.equal(store.sides.B.identity.display_name, "测试 B");
  assert.equal(store.sides.B.identity.companion_name, "对方伙伴");

  const [firstA, firstB, secondA, secondB] = messages.map(
    (event) => event.payload.content,
  );

  assert.match(firstA, /徳牧先生/);
  assert.match(firstA, /小猫/);
  assert.match(firstB, /测试 B/);
  assertDoesNotClaimIdentity(firstB, "徳牧先生");
  assertDoesNotClaimPartner(firstB, "小猫");
  assertDoesNotClaimIdentity(secondA, "徳牧先生");
  assert.doesNotMatch(
    secondA,
    /这是我进入房间后的第一次发言/,
  );
  assertDoesNotClaimIdentity(secondB, "测试 B");
  assert.doesNotMatch(
    secondB,
    /这是我进入房间后的第一次发言/,
  );

  console.log(`M2c demo complete: ${messages.length} messages`);
  for (const event of messages) {
    console.log(`${event.side}: ${event.payload.content}`);
  }
  console.log("M2c dual-real-Agent demo PASS.");
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  await cleanup();
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

function assertDoesNotClaimIdentity(content, identity) {
  const name = escapeRegExp(identity);
  const claim = new RegExp([
    `(?:我|本人)\\s*(?:就是|正是|仍是|仍然是|还是|是|叫|名叫|自称)\\s*${name}`,
    `(?:我|本人)\\s*(?:的)?\\s*身份\\s*(?:是|为)\\s*${name}`,
    `(?:我的|本人的)\\s*名字\\s*(?:是|叫|为)\\s*${name}`,
    `${name}\\s*(?:就是|正是|仍是|仍然是|还是|是)\\s*(?:我|本人)`,
    `(?:这里是|这边是|在下是|作为|身为)\\s*${name}`,
    `${name}\\s*(?:在此|报到)`,
  ].join("|"));

  assert.doesNotMatch(content, claim);
}

function assertDoesNotClaimPartner(content, partner) {
  const name = escapeRegExp(partner);
  const claim = new RegExp([
    `(?:我的|本人的)\\s*(?:人类)?伙伴\\s*(?:就是|正是|是|叫|名叫|为)?\\s*${name}`,
    `${name}\\s*(?:就是|正是|是)\\s*(?:我的|本人的)\\s*(?:人类)?伙伴`,
    `(?:我|本人)\\s*(?:就是|正是|是)\\s*${name}\\s*的\\s*(?:人类)?伙伴`,
    `(?:我|本人)\\s*(?:和|与)\\s*${name}\\s*(?:就是|正是|是|作为)?\\s*(?:人类)?伙伴`,
    `(?:作为|身为)\\s*${name}\\s*的\\s*(?:人类)?伙伴`,
  ].join("|"));

  assert.doesNotMatch(content, claim);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
