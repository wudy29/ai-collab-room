export const DEFAULT_ENDPOINT = "http://127.0.0.1:18003/mcp";
export const PROTOCOL_VERSION = "2024-11-05";

export async function loadOmbreContinuity({
  query,
  maxResults = 1,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
} = {}) {
  if (typeof query !== "string" || query.trim() === "") {
    throw new TypeError("query must be a non-empty string");
  }
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new TypeError("maxResults must be a positive integer");
  }

  let sessionId;
  let primaryError;

  try {
    const initializeResponse = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "ai-collab-room-m0",
            version: "0.0.1",
          },
        },
      }),
    });
    if (!initializeResponse.ok) {
      throw new Error(
        `initialize failed with HTTP ${initializeResponse.status}`,
      );
    }

    sessionId = initializeResponse.headers.get("Mcp-Session-Id");
    if (!sessionId) {
      throw new Error("initialize did not return Mcp-Session-Id");
    }

    const initializePayload = parseJsonRpc(
      await initializeResponse.text(),
    );
    if (
      initializePayload.error ||
      initializePayload.id !== 1 ||
      !Object.hasOwn(initializePayload, "result") ||
      initializePayload.result?.protocolVersion !== PROTOCOL_VERSION
    ) {
      throw new Error("initialize returned an invalid response");
    }

    const initializedResponse = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      }),
    });
    if (initializedResponse.status !== 202) {
      throw new Error(
        `notifications/initialized failed with HTTP ${initializedResponse.status}`,
      );
    }

    const toolsCallResponse = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "breath_search",
          arguments: {
            query,
            max_results: maxResults,
          },
        },
      }),
    });
    if (!toolsCallResponse.ok) {
      throw new Error(
        `tools/call failed with HTTP ${toolsCallResponse.status}`,
      );
    }

    const toolsCallPayload = parseJsonRpc(
      await toolsCallResponse.text(),
    );
    if (
      toolsCallPayload.error ||
      toolsCallPayload.id !== 2 ||
      !Object.hasOwn(toolsCallPayload, "result") ||
      toolsCallPayload.result?.isError === true
    ) {
      throw new Error("tools/call returned an error");
    }

    const texts = toolsCallPayload.result?.content
      ?.filter(
        (item) =>
          item?.type === "text" &&
          typeof item.text === "string",
      )
      .map((item) => item.text);
    if (!texts?.length) {
      throw new Error("tools/call returned no text content");
    }
    return texts.join("\n");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (sessionId) {
      try {
        await terminateSession({ endpoint, sessionId, fetchImpl });
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
      }
    }
  }
}

async function terminateSession({ endpoint, sessionId, fetchImpl }) {
  const response = await fetchImpl(endpoint, {
    method: "DELETE",
    headers: {
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
  });

  if (
    !response.ok &&
    response.status !== 404 &&
    response.status !== 405
  ) {
    throw new Error(
      `session termination failed with HTTP ${response.status}`,
    );
  }
}

function parseJsonRpc(body) {
  try {
    const payload = JSON.parse(body);
    if (payload?.jsonrpc === "2.0") return payload;
  } catch {}

  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const payload = JSON.parse(data);
      if (payload?.jsonrpc === "2.0") return payload;
    } catch {}
  }

  throw new Error("response did not contain JSON-RPC 2.0");
}
