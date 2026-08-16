import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../src/server.js";
import { EphemeralRoomRegistry } from "../src/ephemeral-room-registry.js";
import { RoomStore } from "../src/room-store.js";

const ROOM_UNAVAILABLE = "room unavailable or authorization invalid";
const INVITE_UNAVAILABLE = "invite is invalid or unavailable";

function createStoreFactory(stores) {
  return ({ roomId }) => {
    const store = new RoomStore({ id: roomId, maxTurns: 4 });
    stores.push(store);
    return store;
  };
}

async function startServer(t, { registry } = {}) {
  const { server, registry: actualRegistry } = createRoomServer({
    registry: registry ?? new EphemeralRoomRegistry(),
    logger: { error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections?.();
    await closeServer(server);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, registry: actualRegistry };
}

async function rpc(baseUrl, method, params, { capability, headers = {} } = {}) {
  const requestHeaders = { "content-type": "application/json", ...headers };
  if (capability) requestHeaders.authorization = `Bearer ${capability}`;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: method, arguments: params },
    }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function toolsList(baseUrl, { capability } = {}) {
  const headers = { "content-type": "application/json" };
  if (capability) headers.authorization = `Bearer ${capability}`;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function createRoom(origin) {
  const result = await rpc(origin, "create_room", {});
  assert.equal(result.body.error, undefined);
  return result.body.result.structuredContent;
}

async function redeemInvite(origin, inviteCode) {
  const result = await rpc(origin, "redeem_invite", { invite_code: inviteCode });
  assert.equal(result.body.error, undefined);
  return result.body.result.structuredContent;
}

function startSseReader(reader) {
  const decoder = new TextDecoder();
  let text = "";
  const drained = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) text += decoder.decode(value, { stream: true });
        if (done) break;
      }
    } catch {
      // connection closed by teardown
    }
  })();

  return {
    text: () => text,
    waitFor(marker, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (text.includes(marker)) {
            clearInterval(timer);
            resolve(text);
          } else if (Date.now() - startedAt > timeoutMs) {
            clearInterval(timer);
            reject(
              new Error(`SSE marker not seen: ${marker}; buffered: ${text.slice(-300)}`),
            );
          }
        }, 20);
      });
    },
    async close() {
      await reader.cancel().catch(() => {});
      await drained;
    },
  };
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

test("global /mcp exposes only create_room and redeem_invite and rejects Room tools", async (t) => {
  const { origin } = await startServer(t);

  const listed = await toolsList(origin);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name),
    ["create_room", "redeem_invite"],
  );

  for (const method of ["join_room", "wait_turn", "submit_turn"]) {
    const result = await rpc(origin, method, {});
    assert.equal(result.status, 200, method);
    assert.equal(result.body.error.data.room_code, "UNKNOWN_TOOL", method);
    assert.equal(result.body.error.code, -32000, method);
  }
});

test("global create_room and redeem_invite return the exact snake_case results", async (t) => {
  const { origin } = await startServer(t);

  const created = await rpc(origin, "create_room", {});
  assert.equal(created.status, 200);
  assert.equal(created.body.jsonrpc, "2.0");
  assert.equal(created.body.id, 1);
  assert.equal(created.body.error, undefined);
  const createdResult = created.body.result.structuredContent;
  assert.deepEqual(
    Object.keys(createdResult).sort(),
    ["invite_code", "observer_bootstrap_token", "room_id", "side_capability"],
  );
  for (const value of Object.values(createdResult)) {
    assert.match(value, /^[A-Za-z0-9_-]+$/);
  }
  assert.equal(new Set(Object.values(createdResult)).size, 4);

  const redeemed = await rpc(origin, "redeem_invite", {
    invite_code: createdResult.invite_code,
  });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.body.error, undefined);
  const redeemedResult = redeemed.body.result.structuredContent;
  assert.deepEqual(
    Object.keys(redeemedResult).sort(),
    ["observer_bootstrap_token", "room_id", "side_capability"],
  );
  assert.equal(redeemedResult.room_id, createdResult.room_id);
  assert.notEqual(redeemedResult.side_capability, createdResult.side_capability);
  assert.notEqual(
    redeemedResult.observer_bootstrap_token,
    createdResult.observer_bootstrap_token,
  );
});

test("invalid and reused invites report INVITE_UNAVAILABLE without mutating the room", async (t) => {
  const { origin } = await startServer(t);
  const created = await createRoom(origin);
  const roomUrl = `${origin}/rooms/${created.room_id}`;

  const invalid = await rpc(origin, "redeem_invite", {
    invite_code: "bogus-invite",
  });
  assert.equal(invalid.status, 200);
  assert.equal(invalid.body.error.code, -32000);
  assert.equal(invalid.body.error.message, INVITE_UNAVAILABLE);
  assert.equal(invalid.body.error.data.room_code, "INVITE_UNAVAILABLE");
  assert.deepEqual(
    Object.keys(invalid.body.error.data).sort(),
    ["http_status", "room_code"],
  );
  assert.equal(invalid.body.result, undefined);

  // the failed redeem must not have invalidated the room: A still joins
  const joinA = await rpc(
    roomUrl,
    "join_room",
    { public_identity: { display_name: "A" } },
    { capability: created.side_capability },
  );
  assert.equal(joinA.body.error, undefined);

  // the first redeem succeeds; the reused invite fails
  const first = await rpc(origin, "redeem_invite", {
    invite_code: created.invite_code,
  });
  assert.equal(first.body.error, undefined);
  const reused = await rpc(origin, "redeem_invite", {
    invite_code: created.invite_code,
  });
  assert.equal(reused.status, 200);
  assert.equal(reused.body.error.message, INVITE_UNAVAILABLE);
  assert.equal(reused.body.error.data.room_code, "INVITE_UNAVAILABLE");

  // the reuse failure must not have mutated the room: the B capability from
  // the first redeem still authorizes
  const joinB = await rpc(
    roomUrl,
    "join_room",
    { public_identity: { display_name: "B" } },
    { capability: first.body.result.structuredContent.side_capability },
  );
  assert.equal(joinB.body.error, undefined);
});

test("missing, malformed, wrong, and cross-room capabilities report ROOM_UNAVAILABLE", async (t) => {
  const { origin } = await startServer(t);
  const first = await createRoom(origin);
  const second = await createRoom(origin);
  const roomUrl = `${origin}/rooms/${first.room_id}`;

  const cases = [
    { name: "missing capability", url: roomUrl, capability: undefined, headers: {} },
    {
      name: "malformed non-Bearer scheme",
      url: roomUrl,
      capability: undefined,
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    },
    {
      name: "malformed empty Bearer value",
      url: roomUrl,
      capability: undefined,
      headers: { authorization: "Bearer " },
    },
    {
      name: "wrong capability",
      url: roomUrl,
      capability: "not-a-real-capability",
      headers: {},
    },
    {
      name: "cross-room capability",
      url: roomUrl,
      capability: second.side_capability,
      headers: {},
    },
    {
      name: "valid capability against the wrong room id",
      url: `${origin}/rooms/not-a-room`,
      capability: first.side_capability,
      headers: {},
    },
  ];

  for (const request of cases) {
    const headers = { "content-type": "application/json", ...request.headers };
    if (request.capability) headers.authorization = `Bearer ${request.capability}`;
    const response = await fetch(`${request.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "join_room",
          arguments: { public_identity: { display_name: "X" } },
        },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, request.name);
    assert.equal(body.error.code, -32000, request.name);
    assert.equal(body.error.message, ROOM_UNAVAILABLE, request.name);
    assert.equal(body.error.data.room_code, "ROOM_UNAVAILABLE", request.name);
    assert.deepEqual(
      Object.keys(body.error.data).sort(),
      ["http_status", "room_code"],
      request.name,
    );
    assert.equal(body.result, undefined, `${request.name} must not reveal room state`);
  }

  // tools/list on the scoped endpoint is also behind the capability
  const listed = await toolsList(roomUrl);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.error.message, ROOM_UNAVAILABLE);
  assert.equal(listed.body.result, undefined);
});

test("room tools are exactly join_room, wait_turn, submit_turn without caller-selectable side", async (t) => {
  const { origin } = await startServer(t);
  const created = await createRoom(origin);
  const roomUrl = `${origin}/rooms/${created.room_id}`;

  const listed = await toolsList(roomUrl, { capability: created.side_capability });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.error, undefined);
  const tools = listed.body.result.tools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["join_room", "wait_turn", "submit_turn"],
  );
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(
      !("side" in tool.inputSchema.properties),
      `${tool.name} must not accept a caller-selectable side`,
    );
  }

  const waitTurn = tools.find((tool) => tool.name === "wait_turn");
  assert.deepEqual(waitTurn.inputSchema.required, []);
});

test("tool argument schema constraints are enforced without mutating the room", async (t) => {
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    createStore: createStoreFactory(stores),
  });
  const { origin } = await startServer(t, { registry });
  const created = await createRoom(origin);
  const roomUrl = `${origin}/rooms/${created.room_id}`;
  const capability = created.side_capability;

  const cases = [
    ["join_room", { side: "A", public_identity: { display_name: "X" } }, /unknown argument: side/],
    ["join_room", { public_identity: "not-an-object" }, /public_identity must be an object/],
    ["wait_turn", { side: "A" }, /unknown argument: side/],
    ["wait_turn", { after_event_id: -1 }, /after_event_id must be at least 0/],
    ["wait_turn", { after_event_id: 1.5 }, /after_event_id must be an integer/],
    ["wait_turn", { after_event_id: "3" }, /after_event_id must be an integer/],
    ["wait_turn", { timeout_ms: 60_000 }, /timeout_ms must be at most 30000/],
    ["wait_turn", { timeout_ms: 5 }, /timeout_ms must be at least 10/],
    ["wait_turn", { after_event_id: 0, mystery: true }, /unknown argument: mystery/],
    ["submit_turn", { side: "B", turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "x" }, /unknown argument: side/],
    ["submit_turn", { turn_id: "turn-1", request_id: "req-1-A", action: "reply" }, /missing required argument: message/],
    ["submit_turn", { request_id: "req-1-A", action: "reply", message: "x" }, /missing required argument: turn_id/],
    ["submit_turn", { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "" }, /message must be at least 1 character/],
    ["submit_turn", { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: 42 }, /message must be a string/],
    ["submit_turn", { turn_id: "turn-1", request_id: "req-1-A", action: "banana", message: "x" }, /action must be one of/],
    ["submit_turn", { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "x", extra: 1 }, /unknown argument: extra/],
  ];

  for (const [method, args, pattern] of cases) {
    const result = await rpc(roomUrl, method, args, { capability });
    assert.equal(result.status, 200, `${method} ${JSON.stringify(args)}`);
    assert.equal(result.body.error.code, -32000, method);
    assert.equal(result.body.error.data.room_code, "INVALID_ARGUMENTS", method);
    assert.match(result.body.error.message, pattern, method);
    assert.equal(result.body.result, undefined, `${method} must not return a result`);
  }

  // forged global pairing arguments are also rejected
  const withExtra = await rpc(origin, "create_room", { unexpected: 1 });
  assert.equal(withExtra.body.error.data.room_code, "INVALID_ARGUMENTS");
  const missingCode = await rpc(origin, "redeem_invite", {});
  assert.equal(missingCode.body.error.data.room_code, "INVALID_ARGUMENTS");
  const badType = await rpc(origin, "redeem_invite", { invite_code: 123 });
  assert.equal(badType.body.error.data.room_code, "INVALID_ARGUMENTS");

  // none of the failures mutated the room: a legitimate join is still the
  // first join of this room
  const join = await rpc(
    roomUrl,
    "join_room",
    { public_identity: { display_name: "A" } },
    { capability },
  );
  assert.equal(join.body.error, undefined);
  const store = stores[0];
  assert.equal(store.events.filter((event) => event.type === "side_joined").length, 1);
  assert.equal(store.sides.A.joined, true);
});

test("authorized A/B exchange preserves the turn protocol and derives side from capability", async (t) => {
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    createStore: createStoreFactory(stores),
  });
  const { origin } = await startServer(t, { registry });
  const created = await createRoom(origin);
  const redeemed = await redeemInvite(origin, created.invite_code);
  const roomUrl = `${origin}/rooms/${created.room_id}`;

  const joinA = await rpc(
    roomUrl,
    "join_room",
    { public_identity: { display_name: "A" } },
    { capability: created.side_capability },
  );
  assert.equal(joinA.body.error, undefined);
  assert.equal(joinA.body.result.structuredContent.side, "A");

  const joinB = await rpc(
    roomUrl,
    "join_room",
    { public_identity: { display_name: "B" } },
    { capability: redeemed.side_capability },
  );
  assert.equal(joinB.body.error, undefined);
  assert.equal(joinB.body.result.structuredContent.side, "B");

  // A's turn: the B capability cannot submit even by naming side A
  const bEarly = await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "sneaky" },
    { capability: redeemed.side_capability },
  );
  assert.equal(bEarly.body.error.data.room_code, "NOT_YOUR_TURN");

  // A waits for its turn and submits
  const waitA = await rpc(
    roomUrl,
    "wait_turn",
    { after_event_id: 0, timeout_ms: 1000 },
    { capability: created.side_capability },
  );
  assert.equal(waitA.body.error, undefined);
  assert.equal(waitA.body.result.structuredContent.ready, true);
  assert.equal(waitA.body.result.structuredContent.turn.side, "A");
  await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "m1" },
    { capability: created.side_capability },
  );

  // B's turn: the A capability cannot submit
  const aLate = await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-2", request_id: "req-2-B", action: "reply", message: "sneaky" },
    { capability: created.side_capability },
  );
  assert.equal(aLate.body.error.data.room_code, "NOT_YOUR_TURN");

  // B waits, then rejects a forged turn id, then submits its reply
  const waitB = await rpc(
    roomUrl,
    "wait_turn",
    { after_event_id: 0, timeout_ms: 1000 },
    { capability: redeemed.side_capability },
  );
  assert.equal(waitB.body.error, undefined);
  assert.equal(waitB.body.result.structuredContent.ready, true);
  const forgedTurn = await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-99", request_id: "req-2-B", action: "reply", message: "forged" },
    { capability: redeemed.side_capability },
  );
  assert.equal(forgedTurn.body.error.data.room_code, "TURN_MISMATCH");
  await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-2", request_id: "req-2-B", action: "reply", message: "m2" },
    { capability: redeemed.side_capability },
  );

  // turns 3 and 4 complete the strict A-B-A-B exchange
  await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-3", request_id: "req-3-A", action: "reply", message: "m3" },
    { capability: created.side_capability },
  );
  const endB = await rpc(
    roomUrl,
    "submit_turn",
    { turn_id: "turn-4", request_id: "req-4-B", action: "end", message: "m4" },
    { capability: redeemed.side_capability },
  );
  assert.equal(endB.body.error, undefined);

  const store = stores[0];
  assert.equal(store.room.status, "ended");
  const messages = store.events.filter((event) => event.type === "message");
  assert.deepEqual(messages.map((event) => event.side), ["A", "B", "A", "B"]);
  assert.equal(store.events.filter((event) => event.type === "side_joined").length, 2);
});

test("observer bootstrap issues a one-time room-scoped cookie and redirects once", async (t) => {
  const { origin } = await startServer(t);
  const created = await createRoom(origin);

  const first = await fetch(`${origin}/observe/${created.observer_bootstrap_token}`, {
    redirect: "manual",
  });
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), `/rooms/${created.room_id}`);
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  assert.ok(
    !first.headers.get("location").includes(created.observer_bootstrap_token),
    "the redirect target must not contain the bootstrap token",
  );

  const cookie = first.headers.get("set-cookie");
  assert.match(
    cookie,
    new RegExp(
      `^room_observer=[A-Za-z0-9_-]+; Secure; HttpOnly; SameSite=Strict; Path=/rooms/${created.room_id}$`,
    ),
  );

  // the token is single-use
  const reused = await fetch(`${origin}/observe/${created.observer_bootstrap_token}`, {
    redirect: "manual",
  });
  assert.equal(reused.status, 404);

  // an invalid token fails generically
  const invalid = await fetch(`${origin}/observe/not-a-real-token`, {
    redirect: "manual",
  });
  assert.equal(invalid.status, 404);
});

test("scoped observer surfaces require the room-specific observer cookie", async (t) => {
  const { origin } = await startServer(t);
  const first = await createRoom(origin);
  const second = await createRoom(origin);

  const bootstrap = await fetch(`${origin}/observe/${first.observer_bootstrap_token}`, {
    redirect: "manual",
  });
  assert.equal(bootstrap.status, 303);
  const sessionId = bootstrap.headers.get("set-cookie").split(";")[0].split("=")[1];
  const room1Url = `${origin}/rooms/${first.room_id}`;
  const room2Url = `${origin}/rooms/${second.room_id}`;

  // missing cookie
  assert.equal((await fetch(room1Url)).status, 404);
  assert.equal((await fetch(`${room1Url}/api/state`)).status, 404);
  assert.equal((await fetch(`${room1Url}/events`)).status, 404);

  // invalid cookie value
  const invalidHeaders = { cookie: "room_observer=not-a-real-session" };
  assert.equal((await fetch(room1Url, { headers: invalidHeaders })).status, 404);
  assert.equal(
    (await fetch(`${room1Url}/api/state`, { headers: invalidHeaders })).status,
    404,
  );
  assert.equal(
    (await fetch(`${room1Url}/events`, { headers: invalidHeaders })).status,
    404,
  );

  // cross-room cookie: the first room's session on the second room
  const crossHeaders = { cookie: `room_observer=${sessionId}` };
  assert.equal((await fetch(room2Url, { headers: crossHeaders })).status, 404);
  assert.equal(
    (await fetch(`${room2Url}/api/state`, { headers: crossHeaders })).status,
    404,
  );
  assert.equal(
    (await fetch(`${room2Url}/events`, { headers: crossHeaders })).status,
    404,
  );

  // a valid session against the wrong room id
  assert.equal(
    (await fetch(`${origin}/rooms/not-a-room/api/state`, { headers: crossHeaders })).status,
    404,
  );

  // the session works only for its own room
  assert.equal((await fetch(room1Url, { headers: crossHeaders })).status, 200);
  assert.equal(
    (await fetch(`${room1Url}/api/state`, { headers: crossHeaders })).status,
    200,
  );
});

test("scoped observer state and SSE serve only the authorized room", async (t) => {
  const { origin } = await startServer(t);

  const first = await createRoom(origin);
  const redeemed = await redeemInvite(origin, first.invite_code);
  const room1Url = `${origin}/rooms/${first.room_id}`;

  // room 1: both sides join and complete turn 1
  await rpc(
    room1Url,
    "join_room",
    { public_identity: { display_name: "A" } },
    { capability: first.side_capability },
  );
  await rpc(
    room1Url,
    "join_room",
    { public_identity: { display_name: "B" } },
    { capability: redeemed.side_capability },
  );
  await rpc(
    room1Url,
    "submit_turn",
    { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "m1" },
    { capability: first.side_capability },
  );

  // room 2: create, join, and submit turn 1; its events must never reach
  // room 1's observer
  const second = await createRoom(origin);
  const redeemed2 = await redeemInvite(origin, second.invite_code);
  const room2Url = `${origin}/rooms/${second.room_id}`;
  await rpc(
    room2Url,
    "join_room",
    { public_identity: { display_name: "A2" } },
    { capability: second.side_capability },
  );
  await rpc(
    room2Url,
    "join_room",
    { public_identity: { display_name: "B2" } },
    { capability: redeemed2.side_capability },
  );
  await rpc(
    room2Url,
    "submit_turn",
    { turn_id: "turn-1", request_id: "req-1-A", action: "reply", message: "r2 m1" },
    { capability: second.side_capability },
  );

  // bootstrap a room-1 observer session
  const bootstrap = await fetch(`${origin}/observe/${first.observer_bootstrap_token}`, {
    redirect: "manual",
  });
  assert.equal(bootstrap.status, 303);
  const sessionId = bootstrap.headers.get("set-cookie").split(";")[0].split("=")[1];
  const cookieHeaders = { cookie: `room_observer=${sessionId}` };

  // the scoped shell is the observation page without an end surface
  const shell = await fetch(room1Url, { headers: cookieHeaders });
  assert.equal(shell.status, 200);
  const pageText = await shell.text();
  assert.ok(!pageText.includes("结束房间"), "scoped shell must not contain an end button");
  assert.ok(!pageText.includes("/api/end"), "scoped shell must not reference an HTTP end route");
  assert.ok(pageText.includes("fetch('api/state')"), "shell must fetch the scoped-relative state URL");
  assert.ok(pageText.includes("events?after="), "shell must use the scoped-relative EventSource URL");

  // state belongs to room 1 only
  const state = await fetch(`${room1Url}/api/state`, { headers: cookieHeaders }).then((response) => response.json());
  assert.equal(state.room.id, first.room_id);
  assert.equal(state.room.status, "active");
  assert.equal(state.events.filter((event) => event.type === "message").length, 1);
  assert.ok(
    !state.events.some((event) => event.room_id === second.room_id),
    "room 1 state must not contain room 2 events",
  );

  // SSE replays room 1 history and delivers room 1 live events
  const eventsResponse = await fetch(`${room1Url}/events?after=0`, { headers: cookieHeaders });
  assert.equal(eventsResponse.status, 200);
  const sse = startSseReader(eventsResponse.body.getReader());
  t.after(() => sse.close());
  await sse.waitFor("turn_ready");

  await rpc(
    room1Url,
    "submit_turn",
    { turn_id: "turn-2", request_id: "req-2-B", action: "reply", message: "m2" },
    { capability: redeemed.side_capability },
  );
  await sse.waitFor("m2");

  // room 2 activity never reaches room 1's SSE
  await rpc(
    room2Url,
    "submit_turn",
    { turn_id: "turn-2", request_id: "req-2-B", action: "reply", message: "r2 m2" },
    { capability: redeemed2.side_capability },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(
    !sse.text().includes(second.room_id),
    "room 1 SSE must not carry room 2 events",
  );
});

test("root observer surfaces are removed", async (t) => {
  const { origin } = await startServer(t);
  const created = await createRoom(origin);

  assert.equal((await fetch(`${origin}/`)).status, 404);
  assert.equal((await fetch(`${origin}/api/state`)).status, 404);
  assert.equal((await fetch(`${origin}/events`)).status, 404);
  assert.equal((await fetch(`${origin}/api/end`, { method: "POST" })).status, 404);
  assert.equal(
    (await fetch(`${origin}/rooms/${created.room_id}/api/end`, { method: "POST" })).status,
    404,
  );
});
