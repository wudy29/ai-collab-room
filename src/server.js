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
const OBSERVER_COOKIE_NAME = "room_observer";

export function createRoomServer({
  registry = new EphemeralRoomRegistry(),
  logger = console,
} = {}) {
  const storesByRoomId = new Map();
  const roomClients = new Map();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "POST" && url.pathname === "/mcp") {
        const body = await readJson(request);
        const rpcResponse = await handleJsonRpc(
          { toolDefinitions: GLOBAL_TOOL_DEFINITIONS, callTool: globalToolCall },
          body,
        );
        return sendJson(response, 200, rpcResponse);
      }

      const scopedMcp = /^\/rooms\/([^/]+)\/mcp$/.exec(url.pathname);
      if (request.method === "POST" && scopedMcp) {
        const roomId = scopedMcp[1];
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

      const observe = /^\/observe\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && observe) {
        let observer;
        try {
          observer = registry.consumeObserverBootstrap(observe[1]);
        } catch (error) {
          if (error instanceof RoomError) {
            return sendJson(response, 404, { error: "not_found" });
          }
          throw error;
        }

        const cookie = [
          `${OBSERVER_COOKIE_NAME}=${observer.observerSessionId}`,
          "Secure",
          "HttpOnly",
          "SameSite=Strict",
          `Path=/rooms/${observer.roomId}`,
        ].join("; ");

        response.writeHead(303, {
          location: `/rooms/${observer.roomId}`,
          "set-cookie": cookie,
          "referrer-policy": "no-referrer",
        });
        return response.end();
      }

      const scopedState = /^\/rooms\/([^/]+)\/api\/state$/.exec(url.pathname);
      if (request.method === "GET" && scopedState) {
        const store = authorizeObserverStore(registry, scopedState[1], request);
        if (store === null) return sendJson(response, 404, { error: "not_found" });
        return sendJson(response, 200, store.snapshotFor());
      }

      const scopedEvents = /^\/rooms\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && scopedEvents) {
        const roomId = scopedEvents[1];
        const store = authorizeObserverStore(registry, roomId, request);
        if (store === null) return sendJson(response, 404, { error: "not_found" });

        const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        response.write("retry: 1000\n\n");
        for (const event of store.eventsAfter(after)) writeSse(response, event);

        const client = { response, lastEventId: store.lastEventId() };
        addRoomClient(roomId, client);
        request.on("close", () => removeRoomClient(roomId, client));
        return;
      }

      const scopedShell = /^\/rooms\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && scopedShell) {
        const store = authorizeObserverStore(registry, scopedShell[1], request);
        if (store === null) return sendJson(response, 404, { error: "not_found" });
        return sendFile(response, join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
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
  }, 15_000);
  heartbeat.unref();

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const clients of roomClients.values()) {
      for (const client of clients) client.response.end();
    }
    roomClients.clear();
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

function authorizeObserverStore(registry, roomId, request) {
  const sessionId = roomObserverSession(request.headers.cookie);
  if (sessionId === null) return null;

  try {
    return registry.authorizeObserver(roomId, sessionId).store;
  } catch (error) {
    if (error instanceof RoomError) return null;
    throw error;
  }
}

function roomObserverSession(cookieHeader) {
  if (typeof cookieHeader !== "string") return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === OBSERVER_COOKIE_NAME && value.length > 0) return value;
  }
  return null;
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
