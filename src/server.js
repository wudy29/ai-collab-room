import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RoomError } from "./room-store.js";
import { EphemeralRoomRegistry } from "./ephemeral-room-registry.js";
import {
  GLOBAL_TOOL_DEFINITIONS,
  ROOM_TOOL_DEFINITIONS,
  createRoomToolCaller,
  handleJsonRpc,
  validateArguments,
  wrapRoomError,
} from "./mcp-shape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const ROOT_OBSERVER_TITLE = "双边 AI 协作室 M0";

export function createRoomServer({
  registry = new EphemeralRoomRegistry(),
  logger = console,
} = {}) {
  const storesByRoomId = new Map();
  const roomClients = new Map();
  const pendingRootClients = new Set();
  let firstRoomId = null;

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/") {
        return sendFile(response, join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        if (firstRoomId === null) return sendJson(response, 200, emptySnapshot());
        return sendJson(response, 200, storesByRoomId.get(firstRoomId).snapshotFor());
      }

      if (request.method === "GET" && url.pathname === "/events") {
        const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        response.write("retry: 1000\n\n");

        if (firstRoomId === null) {
          const client = { response, lastEventId: 0 };
          pendingRootClients.add(client);
          request.on("close", () => pendingRootClients.delete(client));
          return;
        }

        const store = storesByRoomId.get(firstRoomId);
        for (const event of store.eventsAfter(after)) writeSse(response, event);
        const client = { response, lastEventId: store.lastEventId() };
        addRoomClient(firstRoomId, client);
        request.on("close", () => removeRoomClient(firstRoomId, client));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/end") {
        if (firstRoomId === null) return sendJson(response, 404, { error: "not_found" });
        const store = storesByRoomId.get(firstRoomId);
        const result = store.end("human_end");
        broadcastNewEvents(firstRoomId);
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/mcp") {
        const body = await readJson(request);
        const rpcResponse = await handleJsonRpc(
          { toolDefinitions: GLOBAL_TOOL_DEFINITIONS, callTool: globalToolCall },
          body,
        );
        return sendJson(response, 200, rpcResponse);
      }

      const scoped = /^\/rooms\/([^/]+)\/mcp$/.exec(url.pathname);
      if (request.method === "POST" && scoped) {
        const roomId = scoped[1];
        const capability = bearerCapability(request.headers.authorization);

        let context;
        try {
          context = registry.authorize(roomId, capability);
        } catch (error) {
          if (error instanceof RoomError) {
            return sendJson(response, 200, wrapRoomError(null, error));
          }
          throw error;
        }

        const body = await readJson(request);
        const before = context.store.lastEventId();
        const rpcResponse = await handleJsonRpc(
          {
            toolDefinitions: ROOM_TOOL_DEFINITIONS,
            callTool: createRoomToolCaller({ side: context.side, store: context.store }),
          },
          body,
        );
        if (context.store.lastEventId() > before) broadcastNewEvents(roomId);
        return sendJson(response, 200, rpcResponse);
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof RoomError) {
        return sendJson(response, error.status, { error: error.code, message: error.message });
      }
      logger.error?.(error);
      sendJson(response, 500, { error: "internal_error" });
    }
  });

  const heartbeat = setInterval(() => {
    for (const clients of roomClients.values()) {
      for (const client of clients) client.response.write(": heartbeat\n\n");
    }
    for (const client of pendingRootClients) client.response.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const clients of roomClients.values()) {
      for (const client of clients) client.response.end();
    }
    for (const client of pendingRootClients) client.response.end();
    roomClients.clear();
    pendingRootClients.clear();
  });

  return { server, registry };

  async function globalToolCall(name, args) {
    const globalSchemas = new Map(
      GLOBAL_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema]),
    );

    switch (name) {
      case "create_room": {
        validateArguments(globalSchemas.get("create_room"), args);
        const created = registry.createRoom();
        const { store } = registry.authorize(created.roomId, created.sideCapability);
        storesByRoomId.set(created.roomId, store);
        if (firstRoomId === null) bindFirstRoom(created.roomId, store);
        return {
          room_id: created.roomId,
          invite_code: created.inviteCode,
          side_capability: created.sideCapability,
          observer_bootstrap_token: created.observerBootstrapToken,
        };
      }
      case "redeem_invite": {
        validateArguments(globalSchemas.get("redeem_invite"), args);
        const redeemed = registry.redeemInvite(args.invite_code);
        return {
          room_id: redeemed.roomId,
          side_capability: redeemed.sideCapability,
          observer_bootstrap_token: redeemed.observerBootstrapToken,
        };
      }
      default:
        throw new RoomError("UNKNOWN_TOOL", `unknown tool: ${name}`);
    }
  }

  function bindFirstRoom(roomId, store) {
    firstRoomId = roomId;
    for (const client of pendingRootClients) {
      client.lastEventId = store.lastEventId();
      addRoomClient(firstRoomId, client);
    }
    pendingRootClients.clear();
  }

  function addRoomClient(roomId, client) {
    let clients = roomClients.get(roomId);
    if (!clients) {
      clients = new Set();
      roomClients.set(roomId, clients);
    }
    clients.add(client);
  }

  function removeRoomClient(roomId, client) {
    roomClients.get(roomId)?.delete(client);
  }

  function broadcastNewEvents(roomId) {
    const store = storesByRoomId.get(roomId);
    const clients = roomClients.get(roomId);
    if (!store || !clients) return;
    for (const client of clients) {
      const events = store.eventsAfter(client.lastEventId);
      for (const event of events) {
        writeSse(client.response, event);
        client.lastEventId = event.id;
      }
    }
  }
}

function emptySnapshot() {
  return {
    room: {
      id: null,
      title: ROOT_OBSERVER_TITLE,
      status: "waiting",
      current_side: null,
      turn_number: 0,
      max_turns: 8,
      created_at: null,
      ended_at: null,
    },
    sides: {
      A: { joined: false, identity: null },
      B: { joined: false, identity: null },
    },
    turn: null,
    events: [],
    last_event_id: 0,
  };
}

function bearerCapability(header) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const capability = header.slice("Bearer ".length).trim();
  return capability.length > 0 ? capability : null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new RoomError("BODY_TOO_LARGE", "request body too large", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RoomError("INVALID_JSON", "invalid JSON body");
  }
}

async function sendFile(response, path, contentType) {
  const body = await readFile(path);
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function writeSse(response, event) {
  response.write(`id: ${event.id}\n`);
  response.write(`event: room_event\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const { server } = createRoomServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`M0 room: http://127.0.0.1:${port}`);
    console.log(`MCP-shaped endpoint: http://127.0.0.1:${port}/mcp`);
  });
}
