import test from "node:test";
import assert from "node:assert/strict";
import { EphemeralRoomRegistry } from "../src/ephemeral-room-registry.js";
import { RoomError, RoomStore } from "../src/room-store.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const ROOM_UNAVAILABLE = "room unavailable or authorization invalid";
const INVITE_UNAVAILABLE = "invite is invalid or unavailable";

function createClock(initialMs = 1_700_000_000_000) {
  let currentMs = initialMs;

  return {
    now: () => currentMs,
    advance(ms) {
      currentMs += ms;
    },
  };
}

function deterministicRandomBytes() {
  let value = 0;

  return (size) => {
    value += 1;
    return Buffer.alloc(size, value);
  };
}

function unavailable(error) {
  return error instanceof RoomError
    && error.code === "ROOM_UNAVAILABLE"
    && error.message === ROOM_UNAVAILABLE;
}

function inviteUnavailable(error) {
  return error instanceof RoomError
    && error.code === "INVITE_UNAVAILABLE"
    && error.message === INVITE_UNAVAILABLE;
}

function createRealStoreFactory(stores) {
  return ({ roomId }) => {
    const store = new RoomStore({ id: roomId });
    stores.push(store);
    return store;
  };
}

test("create and redeem issue distinct opaque authority and bind each capability to its side", () => {
  const clock = createClock();
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes: deterministicRandomBytes(),
    createStore: createRealStoreFactory(stores),
  });

  const created = registry.createRoom();

  assert.equal(stores.length, 1);
  assert.strictEqual(registry.authorize(created.roomId, created.sideCapability).store, stores[0]);
  assert.equal(
    new Set([
      created.roomId,
      created.inviteCode,
      created.sideCapability,
      created.observerBootstrapToken,
    ]).size,
    4,
  );
  for (const value of Object.values(created)) {
    assert.match(value, /^[A-Za-z0-9_-]+$/);
  }

  assert.throws(
    () => registry.redeemInvite("unknown-invite"),
    inviteUnavailable,
  );

  const redeemed = registry.redeemInvite(created.inviteCode);
  assert.equal(redeemed.roomId, created.roomId);
  assert.notEqual(redeemed.sideCapability, created.sideCapability);
  assert.notEqual(redeemed.observerBootstrapToken, created.observerBootstrapToken);
  assert.match(redeemed.sideCapability, /^[A-Za-z0-9_-]+$/);
  assert.match(redeemed.observerBootstrapToken, /^[A-Za-z0-9_-]+$/);
  assert.equal(stores.length, 1);

  assert.deepEqual(
    registry.authorize(created.roomId, created.sideCapability),
    { roomId: created.roomId, side: "A", store: stores[0] },
  );
  assert.deepEqual(
    registry.authorize(created.roomId, redeemed.sideCapability),
    { roomId: created.roomId, side: "B", store: stores[0] },
  );

  assert.throws(
    () => registry.redeemInvite(created.inviteCode),
    inviteUnavailable,
  );
  assert.throws(
    () => registry.authorize(created.roomId, "unknown-capability"),
    unavailable,
  );

  const otherRoom = registry.createRoom();
  assert.throws(
    () => registry.authorize(otherRoom.roomId, created.sideCapability),
    unavailable,
  );
});

test("observer bootstrap tokens are one-time and observer sessions are room-scoped", () => {
  const clock = createClock();
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes: deterministicRandomBytes(),
    createStore: createRealStoreFactory(stores),
  });
  const created = registry.createRoom();
  const otherRoom = registry.createRoom();

  const observer = registry.consumeObserverBootstrap(created.observerBootstrapToken);

  assert.equal(observer.roomId, created.roomId);
  assert.match(observer.observerSessionId, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(
    registry.authorizeObserver(created.roomId, observer.observerSessionId),
    { roomId: created.roomId, store: stores[0] },
  );

  assert.throws(
    () => registry.consumeObserverBootstrap("unknown-bootstrap"),
    unavailable,
  );
  assert.throws(
    () => registry.consumeObserverBootstrap(created.observerBootstrapToken),
    unavailable,
  );
  assert.throws(
    () => registry.authorizeObserver(created.roomId, "unknown-session"),
    unavailable,
  );
  assert.throws(
    () => registry.authorizeObserver(otherRoom.roomId, observer.observerSessionId),
    unavailable,
  );
});

test("an unpaired RoomStore room expires exactly thirty minutes after creation even after A joins", () => {
  const clock = createClock();
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes: deterministicRandomBytes(),
    createStore: createRealStoreFactory(stores),
  });
  const created = registry.createRoom();
  const authorized = registry.authorize(created.roomId, created.sideCapability);

  authorized.store.join("A", { display_name: "A" });
  assert.equal(authorized.store.room.status, "waiting");

  clock.advance(THIRTY_MINUTES_MS - 1);
  assert.strictEqual(
    registry.authorize(created.roomId, created.sideCapability).store,
    stores[0],
  );

  clock.advance(1);
  assert.equal(registry.sweep(), 1);
  assert.throws(
    () => registry.authorize(created.roomId, created.sideCapability),
    unavailable,
  );
  assert.throws(
    () => registry.redeemInvite(created.inviteCode),
    inviteUnavailable,
  );
  assert.throws(
    () => registry.consumeObserverBootstrap(created.observerBootstrapToken),
    unavailable,
  );
});

test("a paired active RoomStore room remains available well beyond unpaired expiry", () => {
  const clock = createClock();
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes: deterministicRandomBytes(),
    createStore: createRealStoreFactory(stores),
  });
  const created = registry.createRoom();
  const redeemed = registry.redeemInvite(created.inviteCode);
  const a = registry.authorize(created.roomId, created.sideCapability);
  const b = registry.authorize(created.roomId, redeemed.sideCapability);

  a.store.join("A", { display_name: "A" });
  b.store.join("B", { display_name: "B" });
  assert.equal(a.store.room.status, "active");

  clock.advance(6 * 60 * 60 * 1000);
  assert.equal(registry.sweep(), 0);
  assert.equal(registry.authorize(created.roomId, created.sideCapability).side, "A");
  assert.equal(registry.authorize(created.roomId, redeemed.sideCapability).side, "B");
});

test("paired rooms with null or invalid ended_at retain their state", () => {
  for (const endedAt of [null, "not-a-date"]) {
    const clock = createClock();
    const registry = new EphemeralRoomRegistry({
      now: clock.now,
      randomBytes: deterministicRandomBytes(),
      createStore: () => ({
        snapshotFor() {
          return { room: { ended_at: endedAt } };
        },
      }),
    });
    const created = registry.createRoom();
    const redeemed = registry.redeemInvite(created.inviteCode);

    clock.advance(365 * 24 * 60 * 60 * 1000);
    assert.equal(registry.sweep(), 0, `ended_at=${endedAt}`);
    assert.equal(registry.authorize(created.roomId, created.sideCapability).side, "A");
    assert.equal(registry.authorize(created.roomId, redeemed.sideCapability).side, "B");
  }
});

test("a paired ended room expires exactly thirty minutes after ended_at and invalidates all authority", () => {
  const clock = createClock();
  let endedAt = null;
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes: deterministicRandomBytes(),
    createStore: () => ({
      snapshotFor(side) {
        assert.equal(side, "A");
        return { room: { ended_at: endedAt } };
      },
    }),
  });
  const created = registry.createRoom();
  const redeemed = registry.redeemInvite(created.inviteCode);
  const observer = registry.consumeObserverBootstrap(redeemed.observerBootstrapToken);

  endedAt = new Date(clock.now()).toISOString();
  clock.advance(THIRTY_MINUTES_MS - 1);
  assert.equal(registry.sweep(), 0);
  assert.equal(registry.authorize(created.roomId, created.sideCapability).side, "A");
  assert.equal(registry.authorize(created.roomId, redeemed.sideCapability).side, "B");
  assert.equal(
    registry.authorizeObserver(created.roomId, observer.observerSessionId).roomId,
    created.roomId,
  );

  clock.advance(1);
  assert.equal(registry.sweep(), 1);
  assert.throws(
    () => registry.authorize(created.roomId, created.sideCapability),
    unavailable,
  );
  assert.throws(
    () => registry.authorize(created.roomId, redeemed.sideCapability),
    unavailable,
  );
  assert.throws(
    () => registry.consumeObserverBootstrap(created.observerBootstrapToken),
    unavailable,
  );
  assert.throws(
    () => registry.authorizeObserver(created.roomId, observer.observerSessionId),
    unavailable,
  );
});

test("sweep returns the number of expired rooms it deletes", () => {
  const clock = createClock();
  const stores = [];
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes: deterministicRandomBytes(),
    createStore: createRealStoreFactory(stores),
  });
  const first = registry.createRoom();
  const second = registry.createRoom();
  const paired = registry.createRoom();
  const redeemed = registry.redeemInvite(paired.inviteCode);

  clock.advance(THIRTY_MINUTES_MS);
  assert.equal(registry.sweep(), 2);
  assert.throws(
    () => registry.authorize(first.roomId, first.sideCapability),
    unavailable,
  );
  assert.throws(
    () => registry.authorize(second.roomId, second.sideCapability),
    unavailable,
  );
  assert.equal(registry.authorize(paired.roomId, redeemed.sideCapability).side, "B");
});

test("redeem remains atomic when random byte generation fails for B authority", () => {
  const clock = createClock();
  const bytes = deterministicRandomBytes();
  let randomBytesCalls = 0;
  let failAtRandomBytesCall = null;
  const registry = new EphemeralRoomRegistry({
    now: clock.now,
    randomBytes(size) {
      randomBytesCalls += 1;
      if (randomBytesCalls === failAtRandomBytesCall) {
        throw new Error("injected randomBytes failure");
      }
      return bytes(size);
    },
    createStore: ({ roomId }) => new RoomStore({ id: roomId }),
  });
  const created = registry.createRoom();

  assert.equal(randomBytesCalls, 4);
  failAtRandomBytesCall = 6;
  assert.throws(
    () => registry.redeemInvite(created.inviteCode),
    /injected randomBytes failure/,
  );
  assert.equal(randomBytesCalls, 6);

  failAtRandomBytesCall = null;
  const redeemed = registry.redeemInvite(created.inviteCode);
  assert.equal(redeemed.roomId, created.roomId);
  assert.equal(registry.authorize(created.roomId, redeemed.sideCapability).side, "B");
});

test("the production default RoomStore uses eight maximum turns", () => {
  const registry = new EphemeralRoomRegistry();
  const created = registry.createRoom();
  const authorized = registry.authorize(created.roomId, created.sideCapability);

  assert.equal(authorized.store.snapshotFor("A").room.max_turns, 8);
});
