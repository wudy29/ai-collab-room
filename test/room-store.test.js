import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore, RoomError } from "../src/room-store.js";

test("room starts only after both sides join and alternates strictly", () => {
  const store = new RoomStore({ maxTurns: 4 });
  store.join("A", { display_name: "A" });
  assert.equal(store.room.status, "waiting");

  store.join("B", { display_name: "B" });
  assert.equal(store.room.status, "active");
  assert.equal(store.room.currentSide, "A");

  store.submitTurn("A", {
    turnId: "turn-1",
    requestId: "req-1-A",
    action: "reply",
    message: "one",
  });
  assert.equal(store.room.currentSide, "B");

  assert.throws(
    () => store.submitTurn("A", {
      turnId: "turn-2",
      requestId: "req-2-B",
      action: "reply",
      message: "wrong side",
    }),
    (error) => error instanceof RoomError && error.code === "NOT_YOUR_TURN",
  );
});

test("same request id is idempotent", () => {
  const store = new RoomStore({ maxTurns: 4 });
  store.join("A", { display_name: "A" });
  store.join("B", { display_name: "B" });

  const input = {
    turnId: "turn-1",
    requestId: "req-1-A",
    action: "reply",
    message: "only once",
  };

  const first = store.submitTurn("A", input);
  const second = store.submitTurn("A", input);
  assert.deepEqual(second, first);
  assert.equal(store.events.filter((event) => event.type === "message").length, 1);
});

test("waitTurn resolves when the side becomes current", async () => {
  const store = new RoomStore({ maxTurns: 4 });
  store.join("A", { display_name: "A" });
  store.join("B", { display_name: "B" });

  const waitingForB = store.waitTurn("B", { timeoutMs: 1000 });
  store.submitTurn("A", {
    turnId: "turn-1",
    requestId: "req-1-A",
    action: "reply",
    message: "your turn",
  });

  const result = await waitingForB;
  assert.equal(result.ready, true);
  assert.equal(result.turn.side, "B");
  assert.equal(result.turn.turn_id, "turn-2");
});

test("stores only public participant labels", () => {
  const store = new RoomStore({ maxTurns: 4 });

  store.join("B", {
    display_name: "独立 B Agent",
    companion_name: "B 侧测试用户",
    description: "不应进入 Room",
    relationship: "不应进入 Room",
    style: ["不应进入 Room"],
    continuity: ["不应进入 Room"],
    memory_source: "不应进入 Room",
  });

  assert.deepEqual(store.sides.B.identity, {
    display_name: "独立 B Agent",
    companion_name: "B 侧测试用户",
  });
  assert.deepEqual(
    Object.keys(store.sides.B.identity).sort(),
    ["companion_name", "display_name"],
  );
});
