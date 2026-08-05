import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RoomStore, RoomError } from "./room-store.js";
import { handleJsonRpc } from "./mcp-shape.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

export function createRoomServer({ store = new RoomStore(), logger = console } = {}) {
  const sseClients = new Set();

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/") {
        return sendFile(response, join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
        return sendJson(response, 200, store.snapshotFor());
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
        for (const event of store.eventsAfter(after)) writeSse(response, event);

        const client = { response, lastEventId: store.lastEventId() };
        sseClients.add(client);
        request.on("close", () => sseClients.delete(client));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/end") {
        const result = store.end("human_end");
        broadcastNewEvents();
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/mcp") {
        const body = await readJson(request);
        const before = store.lastEventId();
        const rpcResponse = await handleJsonRpc(store, body);
        if (store.lastEventId() > before) broadcastNewEvents();
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
    for (const client of sseClients) client.response.write(": heartbeat\n\n");
  }, 15_000);
  heartbeat.unref();

  server.on("close", () => {
    clearInterval(heartbeat);
    for (const client of sseClients) client.response.end();
    sseClients.clear();
  });

  function broadcastNewEvents() {
    for (const client of sseClients) {
      const events = store.eventsAfter(client.lastEventId);
      for (const event of events) {
        writeSse(client.response, event);
        client.lastEventId = event.id;
      }
    }
  }

  return { server, store };
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
