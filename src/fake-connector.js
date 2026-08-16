import { fileURLToPath } from "node:url";

export async function runFakeConnector({
  roomBaseUrl,
  roomCapability,
  identity,
  script,
  log = console.log,
}) {
  let rpcId = 1;
  let cursor = 0;
  let scriptIndex = 0;

  const callTool = async (name, args) => {
    const response = await fetch(`${roomBaseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${roomCapability}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${body.error.data?.room_code ?? body.error.code}: ${body.error.message}`);
    return body.result.structuredContent;
  };

  const joined = await callTool("join_room", { public_identity: identity });
  const side = joined.side;
  log(`[${side}] joined as ${identity.display_name}`);

  while (true) {
    const waiting = await callTool("wait_turn", {
      after_event_id: cursor,
      timeout_ms: 5_000,
    });
    cursor = waiting.last_event_id;

    if (waiting.ended) {
      log(`[${side}] room ended`);
      return;
    }

    if (!waiting.ready) continue;

    const line = script[scriptIndex++];
    if (!line) throw new Error(`[${side}] script exhausted before room ended`);

    log(`[${side}] ${line.message}`);
    await callTool("submit_turn", {
      turn_id: waiting.turn.turn_id,
      request_id: waiting.turn.request_id,
      action: line.action ?? "reply",
      message: line.message,
    });

    if (line.action === "end") return;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const side = process.argv[2];
  const roomBaseUrl = process.env.ROOM_URL ?? "http://127.0.0.1:8787";
  const roomCapability = process.env.ROOM_CAPABILITY;
  const scripts = {
    A: [
      { message: "你好，我是测试 A。" },
      { message: "测试结束。" },
    ],
    B: [
      { message: "你好，我是测试 B，我收到了。" },
      { message: "好，结束。", action: "end" },
    ],
  };

  if (!scripts[side]) {
    console.error("usage: node src/fake-connector.js A|B");
    console.error("env: ROOM_URL=<scoped room URL ending in /rooms/<id>>, ROOM_CAPABILITY=<side capability>");
    process.exitCode = 2;
  } else if (!roomCapability) {
    console.error("ROOM_CAPABILITY is required");
    process.exitCode = 2;
  } else {
    await runFakeConnector({
      roomBaseUrl,
      roomCapability,
      identity: { display_name: `测试 ${side}`, companion_name: `观察者 ${side}` },
      script: scripts[side],
    });
  }
}
