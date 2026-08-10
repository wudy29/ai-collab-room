import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { createA2AModelAgentServer } from "../src/a2a-model-agent.js";
import { runA2ARoomConnector } from "../src/a2a-room-connector.js";
import { DEMU_IDENTITY } from "../src/demu-identity.js";
import { loadOmbreContinuity } from "../src/ombre-continuity.js";

const host = "127.0.0.1";
const B_PRIVATE_DETAIL = "蓝色纸鹤";
const B_CONTINUITY_CONTEXT =
  "会面前，B 侧在桌角放了一张写着“蓝色纸鹤”的便签。";

const B_IDENTITY = Object.freeze({
  displayName: "独立 B Agent",
  companionName: "B 侧测试用户",
  description: "你是由 B 侧自行准备身份与连续性上下文的独立测试参与者。",
  relationship: "你的身份与连续性属于 B 侧，不由 Room 提供。",
  style: [
    "第一次发言时自然带出本次会面连续性上下文中的一个具体细节，后续不要把它当作新的自我介绍。",
  ],
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

  const continuityContextA = await loadOmbreContinuity({
    query: "天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？",
    maxResults: 1,
  });
  assert.ok(
    continuityContextA.includes("午后乌云压低时，窗边的铜铃一响"),
  );

  agentA = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: DEMU_IDENTITY,
    continuityContext: continuityContextA,
  });

  agentB = await createA2AModelAgentServer({
    host,
    port: 0,
    identity: B_IDENTITY,
    continuityContext: B_CONTINUITY_CONTEXT,
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

  assert.deepEqual(store.sides.A.identity, {
    display_name: DEMU_IDENTITY.displayName,
    companion_name: DEMU_IDENTITY.companionName,
  });
  assert.deepEqual(store.sides.B.identity, {
    display_name: B_IDENTITY.displayName,
    companion_name: B_IDENTITY.companionName,
  });
  assert.deepEqual(
    Object.keys(store.sides.B.identity).sort(),
    ["companion_name", "display_name"],
  );

  const [firstA, firstB, secondA, secondB] = messages.map(
    (event) => event.payload.content,
  );

  assert.match(firstA, /徳牧先生/);
  assert.match(firstA, /小猫/);
  assert.doesNotMatch(firstA, new RegExp(B_PRIVATE_DETAIL));

  assert.match(firstB, /独立 B Agent/);
  assert.match(firstB, /B 侧测试用户/);
  assert.match(firstB, new RegExp(B_PRIVATE_DETAIL));
  assertDoesNotClaimIdentity(firstB, "徳牧先生");
  assertDoesNotClaimPartner(firstB, "小猫");

  assertDoesNotClaimIdentity(secondA, "徳牧先生");
  assert.doesNotMatch(
    secondA,
    /这是我进入房间后的第一次发言/,
  );
  assertDoesNotClaimIdentity(secondB, B_IDENTITY.displayName);
  assert.doesNotMatch(
    secondB,
    /这是我进入房间后的第一次发言/,
  );

  console.log(`M2d demo complete: ${messages.length} messages`);
  for (const event of messages) {
    console.log(`${event.side}: ${event.payload.content}`);
  }
  console.log("M2d side-owned-context demo PASS.");
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
