import { randomBytes as nodeRandomBytes } from "node:crypto";
import { RoomError, RoomStore } from "./room-store.js";

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export class EphemeralRoomRegistry {
  #createStore;
  #now;
  #randomBytes;
  #rooms = new Map();
  #invites = new Map();
  #sideCapabilities = new Map();
  #observerBootstrapTokens = new Map();
  #observerSessions = new Map();

  constructor({
    createStore = ({ roomId }) => new RoomStore({ id: roomId, maxTurns: 8 }),
    now = () => Date.now(),
    randomBytes = nodeRandomBytes,
  } = {}) {
    this.#createStore = createStore;
    this.#now = now;
    this.#randomBytes = randomBytes;
  }

  createRoom() {
    this.sweep();

    const roomId = this.#opaque();
    const inviteCode = this.#opaque();
    const sideCapability = this.#opaque();
    const observerBootstrapToken = this.#opaque();
    const createdAtMs = this.#now();
    const store = this.#createStore({ roomId });
    const room = {
      roomId,
      store,
      createdAtMs,
      pairedAtMs: null,
      inviteCode,
      sideCapabilities: new Set([sideCapability]),
      observerBootstrapTokens: new Set([observerBootstrapToken]),
      observerSessions: new Set(),
    };

    this.#rooms.set(roomId, room);
    this.#invites.set(inviteCode, roomId);
    this.#sideCapabilities.set(sideCapability, { roomId, side: "A" });
    this.#observerBootstrapTokens.set(observerBootstrapToken, roomId);

    return {
      roomId,
      inviteCode,
      sideCapability,
      observerBootstrapToken,
    };
  }

  redeemInvite(inviteCode) {
    this.sweep();

    const roomId = this.#invites.get(inviteCode);
    const room = this.#rooms.get(roomId);
    if (!room) {
      throw new RoomError("INVITE_UNAVAILABLE", "invite is invalid or unavailable");
    }

    const sideCapability = this.#opaque();
    const observerBootstrapToken = this.#opaque();
    const pairedAtMs = this.#now();

    this.#invites.delete(inviteCode);
    room.inviteCode = null;
    room.pairedAtMs = pairedAtMs;
    room.sideCapabilities.add(sideCapability);
    this.#sideCapabilities.set(sideCapability, { roomId, side: "B" });
    room.observerBootstrapTokens.add(observerBootstrapToken);
    this.#observerBootstrapTokens.set(observerBootstrapToken, roomId);

    return {
      roomId,
      sideCapability,
      observerBootstrapToken,
    };
  }

  authorize(roomId, sideCapability) {
    this.sweep();

    const authority = this.#sideCapabilities.get(sideCapability);
    const room = this.#rooms.get(roomId);
    if (!room || !authority || authority.roomId !== roomId) {
      throw new RoomError("ROOM_UNAVAILABLE", "room unavailable or authorization invalid");
    }

    return { roomId, side: authority.side, store: room.store };
  }

  consumeObserverBootstrap(observerBootstrapToken) {
    this.sweep();

    const roomId = this.#observerBootstrapTokens.get(observerBootstrapToken);
    const room = this.#rooms.get(roomId);
    if (!room) {
      throw new RoomError("ROOM_UNAVAILABLE", "room unavailable or authorization invalid");
    }

    const observerSessionId = this.#opaque();

    this.#observerBootstrapTokens.delete(observerBootstrapToken);
    room.observerBootstrapTokens.delete(observerBootstrapToken);
    room.observerSessions.add(observerSessionId);
    this.#observerSessions.set(observerSessionId, roomId);

    return { roomId, observerSessionId };
  }

  authorizeObserver(roomId, observerSessionId) {
    this.sweep();

    const sessionRoomId = this.#observerSessions.get(observerSessionId);
    const room = this.#rooms.get(roomId);
    if (!room || sessionRoomId !== roomId) {
      throw new RoomError("ROOM_UNAVAILABLE", "room unavailable or authorization invalid");
    }

    return { roomId, store: room.store };
  }

  sweep() {
    const now = this.#now();
    let deleted = 0;

    for (const room of [...this.#rooms.values()]) {
      if (room.pairedAtMs === null) {
        if (now >= room.createdAtMs + THIRTY_MINUTES_MS) {
          this.#deleteRoom(room);
          deleted += 1;
        }
        continue;
      }

      const endedAt = room.store.snapshotFor("A").room.ended_at;
      if (typeof endedAt !== "string") continue;

      const endedAtMs = Date.parse(endedAt);
      if (
        Number.isFinite(endedAtMs)
        && now >= endedAtMs + THIRTY_MINUTES_MS
      ) {
        this.#deleteRoom(room);
        deleted += 1;
      }
    }

    return deleted;
  }

  #opaque() {
    return Buffer.from(this.#randomBytes(24)).toString("base64url");
  }

  #deleteRoom(room) {
    this.#rooms.delete(room.roomId);
    if (room.inviteCode !== null) this.#invites.delete(room.inviteCode);

    for (const sideCapability of room.sideCapabilities) {
      this.#sideCapabilities.delete(sideCapability);
    }
    for (const observerBootstrapToken of room.observerBootstrapTokens) {
      this.#observerBootstrapTokens.delete(observerBootstrapToken);
    }
    for (const observerSessionId of room.observerSessions) {
      this.#observerSessions.delete(observerSessionId);
    }
  }
}
