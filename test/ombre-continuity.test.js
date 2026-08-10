import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ENDPOINT,
  loadOmbreContinuity,
  PROTOCOL_VERSION,
} from "../src/ombre-continuity.js";

const query =
  "天色变暗时，窗边什么响声提醒先生把院子里晾着的稿纸收进屋？";

test("loads continuity and terminates the MCP session", async () => {
  assert.equal(DEFAULT_ENDPOINT, "http://127.0.0.1:18003/mcp");
  assert.equal(PROTOCOL_VERSION, "2024-11-05");

  const requests = [];
  const fetchImpl = async (url, options) => {
    if (options.method === "DELETE") {
      requests.push({ url, method: "DELETE", headers: options.headers });
      return new Response(null, { status: 200 });
    }

    const body = JSON.parse(options.body);
    requests.push({
      url,
      method: options.method,
      headers: options.headers,
      body,
    });

    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: PROTOCOL_VERSION },
      }), {
        status: 200,
        headers: { "Mcp-Session-Id": "session-1" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return new Response([
      "event: ping",
      "data: not-json",
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,',
      'data: "result":{"content":[',
      'data: {"type":"text","text":"午后乌云压低时，窗边的铜铃一响"},',
      'data: {"type":"text","text":"先生便去收稿纸"}]}}',
      "",
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };

  const result = await loadOmbreContinuity({
    query,
    maxResults: 1,
    fetchImpl,
  });

  assert.equal(
    result,
    "午后乌云压低时，窗边的铜铃一响\n先生便去收稿纸",
  );
  assert.deepEqual(
    requests.map(({ method, body }) => body?.method ?? method),
    [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ],
  );
  assert.equal(requests[0].body.params.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(requests[2].body.params.arguments, {
    query,
    max_results: 1,
  });
  assert.equal(requests[3].headers["Mcp-Session-Id"], "session-1");
});

test("rejects a mismatched initialize protocol and cleans the session", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === "DELETE") {
      methods.push("DELETE");
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(options.body);
    methods.push(body.method);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-03-26" },
    }), {
      status: 200,
      headers: { "Mcp-Session-Id": "session-protocol" },
    });
  };

  await assert.rejects(
    loadOmbreContinuity({ query, fetchImpl }),
    /initialize returned an invalid response/,
  );
  assert.deepEqual(methods, ["initialize", "DELETE"]);
});

test("rejects a mismatched tools response id and cleans the session", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === "DELETE") {
      methods.push("DELETE");
      return new Response(null, { status: 405 });
    }
    const body = JSON.parse(options.body);
    methods.push(body.method);

    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: PROTOCOL_VERSION },
      }), {
        status: 200,
        headers: { "Mcp-Session-Id": "session-id" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      result: {
        content: [{ type: "text", text: "wrong response" }],
      },
    }));
  };

  await assert.rejects(
    loadOmbreContinuity({ query, fetchImpl }),
    /tools\/call returned an error/,
  );
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/call",
    "DELETE",
  ]);
});

test("rejects a tools result marked as an error and cleans the session", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === "DELETE") {
      methods.push("DELETE");
      return new Response(null, { status: 404 });
    }
    const body = JSON.parse(options.body);
    methods.push(body.method);

    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: PROTOCOL_VERSION },
      }), {
        status: 200,
        headers: { "Mcp-Session-Id": "session-error" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        isError: true,
        content: [{ type: "text", text: "failure" }],
      },
    }));
  };

  await assert.rejects(
    loadOmbreContinuity({ query, fetchImpl }),
    /tools\/call returned an error/,
  );
  assert.equal(methods.at(-1), "DELETE");
});

test("rejects a tools result without text content and cleans the session", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    if (options.method === "DELETE") {
      methods.push("DELETE");
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(options.body);
    methods.push(body.method);

    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: PROTOCOL_VERSION },
      }), {
        status: 200,
        headers: { "Mcp-Session-Id": "session-no-text" },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      result: {
        content: [{ type: "image", data: "ignored" }],
      },
    }));
  };

  await assert.rejects(
    loadOmbreContinuity({ query, fetchImpl }),
    /tools\/call returned no text content/,
  );
  assert.equal(methods.at(-1), "DELETE");
});
