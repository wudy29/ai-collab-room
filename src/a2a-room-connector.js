import { Role, TaskState } from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";

export async function runA2ARoomConnector({
  roomBaseUrl,
  agentBaseUrl,
  side,
  identity,
  log = console.log,
}) {
  let rpcId = 1;
  let cursor = 0;
  let latestOtherMessage = null;

  const callTool = async (name, args) => {
    const response = await fetch(`${roomBaseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });

    if (!response.ok) {
      throw new Error(`Room MCP request failed with HTTP ${response.status}`);
    }

    const body = await response.json();
    if (body.error) {
      throw new Error(
        `${body.error.data?.room_code ?? body.error.code}: ${body.error.message}`,
      );
    }
    return body.result.structuredContent;
  };

  const joined = await callTool("join_room", {
    side,
    public_identity: identity,
  });
  const roomId = joined.room.id;
  log(`[${side}] joined as ${identity.display_name}`);

  const client = await new ClientFactory().createFromUrl(agentBaseUrl);

  while (true) {
    const waiting = await callTool("wait_turn", {
      side,
      after_event_id: cursor,
      timeout_ms: 5_000,
    });
    cursor = waiting.last_event_id;

    for (const event of waiting.events) {
      if (event.type === "message" && event.side !== side) {
        latestOtherMessage = event.payload.content;
      }
    }

    if (waiting.ended) {
      log(`[${side}] room ended`);
      return;
    }

    if (!waiting.ready) continue;

    const prompt = latestOtherMessage === null
      ? `${waiting.turn.turn_id}\n请启动本地确定性测试。`
      : `${waiting.turn.turn_id}\n对方最近一条消息：${latestOtherMessage}`;

    const result = await client.sendMessage({
      tenant: "",
      message: {
        messageId: waiting.turn.request_id,
        contextId: roomId,
        taskId: "",
        role: Role.ROLE_USER,
        parts: [textPart(prompt)],
        extensions: [],
        metadata: {},
        referenceTaskIds: [],
      },
      configuration: undefined,
      metadata: {},
    });

    const message = extractResultText(result);
    if (!message) {
      throw new Error(
        `A2A agent returned no text result for ${waiting.turn.turn_id}`,
      );
    }

    log(`[${side}] ${message}`);
    await callTool("submit_turn", {
      side,
      turn_id: waiting.turn.turn_id,
      request_id: waiting.turn.request_id,
      action: "reply",
      message,
    });
  }
}

function extractResultText(result) {
  if (result?.status?.state === TaskState.TASK_STATE_COMPLETED) {
    for (const artifact of result.artifacts ?? []) {
      const text = textFromParts(artifact.parts);
      if (text) return text;
    }
  }

  return textFromParts(result?.parts);
}

function textFromParts(parts = []) {
  return parts
    .map((part) => {
      if (part.content?.$case === "text") return part.content.value;
      if (part.kind === "text") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function textPart(text) {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}
