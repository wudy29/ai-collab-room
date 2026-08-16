import { RoomError } from "./room-store.js";

export const GLOBAL_TOOL_DEFINITIONS = [
  {
    name: "create_room",
    description:
      "Create an ephemeral room and receive its invite code and side capability.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "redeem_invite",
    description:
      "Redeem an invite code to receive the second side capability of its room.",
    inputSchema: {
      type: "object",
      properties: {
        invite_code: { type: "string", minLength: 1 },
      },
      required: ["invite_code"],
      additionalProperties: false,
    },
  },
];

export const ROOM_TOOL_DEFINITIONS = [
  {
    name: "join_room",
    description:
      "Join this room with a public identity; the side is derived from the Bearer capability.",
    inputSchema: {
      type: "object",
      properties: {
        public_identity: { type: "object" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "wait_turn",
    description: "Wait until it is this side's turn or the room ends.",
    inputSchema: {
      type: "object",
      properties: {
        after_event_id: { type: "integer", minimum: 0 },
        timeout_ms: { type: "integer", minimum: 10, maximum: 30000 },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "submit_turn",
    description: "Submit this side's final message for the current turn.",
    inputSchema: {
      type: "object",
      properties: {
        turn_id: { type: "string" },
        request_id: { type: "string" },
        action: { type: "string", enum: ["reply", "end"] },
        message: { type: "string", minLength: 1 },
      },
      required: ["turn_id", "request_id", "action", "message"],
      additionalProperties: false,
    },
  },
];

export async function handleJsonRpc({ toolDefinitions, callTool }, body) {
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
      return successResponse(id, { tools: toolDefinitions });
    }

    if (body.method === "tools/call") {
      const name = body.params?.name;
      const args = body.params?.arguments ?? {};
      const result = await callTool(name, args);
      return successResponse(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    }

    return errorResponse(id, -32601, "Method not found");
  } catch (error) {
    if (error instanceof RoomError) {
      return wrapRoomError(id, error);
    }

    return errorResponse(id, -32603, "Internal error");
  }
}

export function createRoomToolCaller({ side, store }) {
  const schemaByName = new Map(
    ROOM_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema]),
  );

  return async (name, args) => {
    switch (name) {
      case "join_room":
        validateArguments(schemaByName.get("join_room"), args);
        return { ...store.join(side, args.public_identity), side };
      case "wait_turn":
        validateArguments(schemaByName.get("wait_turn"), args);
        return store.waitTurn(side, {
          afterEventId: args.after_event_id,
          timeoutMs: args.timeout_ms,
        });
      case "submit_turn":
        validateArguments(schemaByName.get("submit_turn"), args);
        return store.submitTurn(side, {
          turnId: args.turn_id,
          requestId: args.request_id,
          action: args.action,
          message: args.message,
        });
      default:
        throw new RoomError("UNKNOWN_TOOL", `unknown tool: ${name}`);
    }
  };
}

export function validateArguments(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw invalidArguments("arguments must be an object");
  }

  for (const key of Object.keys(args)) {
    if (schema.additionalProperties === false && !(key in schema.properties)) {
      throw invalidArguments(`unknown argument: ${key}`);
    }
  }

  for (const key of schema.required ?? []) {
    if (!(key in args)) {
      throw invalidArguments(`missing required argument: ${key}`);
    }
  }

  for (const [key, rule] of Object.entries(schema.properties ?? {})) {
    if (!(key in args)) continue;
    validateValue(rule, args[key], key);
  }
}

function validateValue(rule, value, path) {
  if (rule.type === "string") {
    if (typeof value !== "string") {
      throw invalidArguments(`${path} must be a string`);
    }
    if (typeof rule.minLength === "number" && value.length < rule.minLength) {
      throw invalidArguments(
        `${path} must be at least ${rule.minLength} characters long`,
      );
    }
  } else if (rule.type === "integer") {
    if (!Number.isInteger(value)) {
      throw invalidArguments(`${path} must be an integer`);
    }
    if (typeof rule.minimum === "number" && value < rule.minimum) {
      throw invalidArguments(`${path} must be at least ${rule.minimum}`);
    }
    if (typeof rule.maximum === "number" && value > rule.maximum) {
      throw invalidArguments(`${path} must be at most ${rule.maximum}`);
    }
  } else if (rule.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw invalidArguments(`${path} must be a number`);
    }
  } else if (rule.type === "boolean") {
    if (typeof value !== "boolean") {
      throw invalidArguments(`${path} must be a boolean`);
    }
  } else if (rule.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw invalidArguments(`${path} must be an object`);
    }
  } else if (rule.type === "array") {
    if (!Array.isArray(value)) {
      throw invalidArguments(`${path} must be an array`);
    }
  }

  if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
    throw invalidArguments(`${path} must be one of: ${rule.enum.join(", ")}`);
  }
}

export function wrapRoomError(id, error) {
  return errorResponse(id, -32000, error.message, {
    room_code: error.code,
    http_status: error.status,
  });
}

function invalidArguments(detail) {
  return new RoomError("INVALID_ARGUMENTS", `invalid tool arguments: ${detail}`);
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
