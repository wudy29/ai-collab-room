import { RoomError } from "./room-store.js";

export const TOOL_DEFINITIONS = [
  {
    name: "join_room",
    description: "Join side A or B of the M0 room.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["A", "B"] },
        public_identity: { type: "object" },
      },
      required: ["side"],
      additionalProperties: false,
    },
  },
  {
    name: "wait_turn",
    description: "Wait until it is this side's turn or the room ends.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["A", "B"] },
        after_event_id: { type: "integer", minimum: 0 },
        timeout_ms: { type: "integer", minimum: 10, maximum: 30000 },
      },
      required: ["side"],
      additionalProperties: false,
    },
  },
  {
    name: "submit_turn",
    description: "Submit the current side's final message for this turn.",
    inputSchema: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["A", "B"] },
        turn_id: { type: "string" },
        request_id: { type: "string" },
        action: { type: "string", enum: ["reply", "end"] },
        message: { type: "string", minLength: 1 },
      },
      required: ["side", "turn_id", "request_id", "action", "message"],
      additionalProperties: false,
    },
  },
];

export async function handleJsonRpc(store, body) {
  const id = body?.id ?? null;

  try {
    if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
      return errorResponse(id, -32600, "Invalid Request");
    }

    if (body.method === "initialize") {
      return successResponse(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-collab-room-m0", version: "0.0.1" },
      });
    }

    if (body.method === "ping") {
      return successResponse(id, {});
    }

    if (body.method === "tools/list") {
      return successResponse(id, { tools: TOOL_DEFINITIONS });
    }

    if (body.method === "tools/call") {
      const name = body.params?.name;
      const args = body.params?.arguments ?? {};
      const result = await callTool(store, name, args);
      return successResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }

    return errorResponse(id, -32601, "Method not found");
  } catch (error) {
    if (error instanceof RoomError) {
      return errorResponse(id, -32000, error.message, {
        room_code: error.code,
        http_status: error.status,
      });
    }

    return errorResponse(id, -32603, "Internal error");
  }
}

async function callTool(store, name, args) {
  switch (name) {
    case "join_room":
      return store.join(args.side, args.public_identity);
    case "wait_turn":
      return store.waitTurn(args.side, {
        afterEventId: args.after_event_id,
        timeoutMs: args.timeout_ms,
      });
    case "submit_turn":
      return store.submitTurn(args.side, {
        turnId: args.turn_id,
        requestId: args.request_id,
        action: args.action,
        message: args.message,
      });
    default:
      throw new RoomError("UNKNOWN_TOOL", `unknown tool: ${name}`);
  }
}

function successResponse(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data ? { data } : {}),
    },
  };
}
