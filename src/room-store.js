const SIDES = new Set(["A", "B"]);

export class RoomError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RoomError";
    this.code = code;
    this.status = status;
  }
}

export class RoomStore {
  constructor({
    id = "m0-room",
    title = "双边 AI 协作室 M0",
    maxTurns = 4,
  } = {}) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1) {
      throw new TypeError("maxTurns must be a positive integer");
    }

    this.room = {
      id,
      title,
      status: "waiting",
      currentSide: null,
      turnNumber: 0,
      maxTurns,
      createdAt: new Date().toISOString(),
      endedAt: null,
    };

    this.sides = {
      A: { joined: false, identity: null },
      B: { joined: false, identity: null },
    };

    this.events = [];
    this.nextEventId = 1;
    this.requestResults = new Map();
    this.waiters = new Set();
  }

  assertSide(side) {
    if (!SIDES.has(side)) {
      throw new RoomError("INVALID_SIDE", "side must be A or B");
    }
  }

  join(side, publicIdentity) {
    this.assertSide(side);

    if (this.room.status === "ended") {
      throw new RoomError("ROOM_ENDED", "room has ended", 409);
    }

    const identity = normalizeIdentity(publicIdentity, side);
    const firstJoin = !this.sides[side].joined;
    this.sides[side] = { joined: true, identity };

    if (firstJoin) {
      this.emit("side_joined", side, { identity });
    }

    if (
      this.room.status === "waiting" &&
      this.sides.A.joined &&
      this.sides.B.joined
    ) {
      this.room.status = "active";
      this.room.turnNumber = 1;
      this.room.currentSide = "A";
      this.emit("room_started", null, { current_side: "A" });
      this.emitTurnReady();
    }

    this.notifyWaiters();
    return this.snapshotFor(side);
  }

  async waitTurn(side, { afterEventId = 0, timeoutMs = 15_000 } = {}) {
    this.assertSide(side);

    if (!this.sides[side].joined) {
      throw new RoomError("SIDE_NOT_JOINED", `${side} has not joined`, 409);
    }

    const immediate = this.turnPayload(side, afterEventId);
    if (immediate.ready || immediate.ended) {
      return immediate;
    }

    const boundedTimeout = Math.max(10, Math.min(Number(timeoutMs) || 15_000, 30_000));

    return new Promise((resolve) => {
      const waiter = {
        side,
        afterEventId,
        resolve,
        timer: null,
      };

      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(this.turnPayload(side, afterEventId));
      }, boundedTimeout);

      this.waiters.add(waiter);
    });
  }

  submitTurn(side, { turnId, requestId, action = "reply", message }) {
    this.assertSide(side);

    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new RoomError("INVALID_REQUEST_ID", "request_id is required");
    }

    const cached = this.requestResults.get(requestId);
    if (cached) {
      return structuredClone(cached);
    }

    if (this.room.status !== "active") {
      throw new RoomError("ROOM_NOT_ACTIVE", "room is not active", 409);
    }

    if (this.room.currentSide !== side) {
      throw new RoomError("NOT_YOUR_TURN", `current side is ${this.room.currentSide}`, 409);
    }

    const expectedTurnId = this.currentTurnId();
    const expectedRequestId = this.currentRequestId();

    if (turnId !== expectedTurnId) {
      throw new RoomError("TURN_MISMATCH", `expected ${expectedTurnId}`, 409);
    }

    if (requestId !== expectedRequestId) {
      throw new RoomError("REQUEST_MISMATCH", `expected ${expectedRequestId}`, 409);
    }

    if (action !== "reply" && action !== "end") {
      throw new RoomError("INVALID_ACTION", "action must be reply or end");
    }

    if (typeof message !== "string" || message.trim().length === 0) {
      throw new RoomError("EMPTY_MESSAGE", "message must not be empty");
    }

    this.emit("message", side, {
      turn_id: turnId,
      request_id: requestId,
      action,
      content: message.trim(),
    });

    const reachedTurnLimit = this.room.turnNumber >= this.room.maxTurns;
    if (action === "end" || reachedTurnLimit) {
      this.end(action === "end" ? "participant_end" : "turn_limit");
    } else {
      this.room.currentSide = oppositeSide(side);
      this.room.turnNumber += 1;
      this.emitTurnReady();
    }

    const result = {
      accepted: true,
      idempotent_replay: false,
      room: this.publicRoom(),
      last_event_id: this.lastEventId(),
    };

    this.requestResults.set(requestId, structuredClone(result));
    this.notifyWaiters();
    return result;
  }

  end(reason = "human_end") {
    if (this.room.status === "ended") {
      return this.publicRoom();
    }

    this.room.status = "ended";
    this.room.currentSide = null;
    this.room.endedAt = new Date().toISOString();
    this.emit("room_ended", null, { reason });
    this.notifyWaiters();
    return this.publicRoom();
  }

  snapshotFor(side = null) {
    if (side !== null) this.assertSide(side);
    return {
      room: this.publicRoom(),
      sides: structuredClone(this.sides),
      turn: side ? this.currentTurnFor(side) : null,
      events: this.eventsAfter(0),
      last_event_id: this.lastEventId(),
    };
  }

  turnPayload(side, afterEventId) {
    return {
      ready: this.room.status === "active" && this.room.currentSide === side,
      ended: this.room.status === "ended",
      room: this.publicRoom(),
      turn: this.currentTurnFor(side),
      events: this.eventsAfter(afterEventId),
      last_event_id: this.lastEventId(),
    };
  }

  currentTurnFor(side) {
    if (this.room.status !== "active" || this.room.currentSide !== side) {
      return null;
    }

    return {
      turn_id: this.currentTurnId(),
      request_id: this.currentRequestId(),
      side,
      number: this.room.turnNumber,
    };
  }

  currentTurnId() {
    return `turn-${this.room.turnNumber}`;
  }

  currentRequestId() {
    return `req-${this.room.turnNumber}-${this.room.currentSide}`;
  }

  emitTurnReady() {
    this.emit("turn_ready", this.room.currentSide, {
      turn_id: this.currentTurnId(),
      request_id: this.currentRequestId(),
      number: this.room.turnNumber,
    });
  }

  emit(type, side, payload = {}) {
    const event = {
      id: this.nextEventId++,
      room_id: this.room.id,
      type,
      side,
      payload,
      created_at: new Date().toISOString(),
    };
    this.events.push(event);
    return event;
  }

  eventsAfter(afterEventId) {
    const cursor = Number(afterEventId) || 0;
    return this.events.filter((event) => event.id > cursor).map((event) => structuredClone(event));
  }

  lastEventId() {
    return this.events.at(-1)?.id ?? 0;
  }

  publicRoom() {
    return {
      id: this.room.id,
      title: this.room.title,
      status: this.room.status,
      current_side: this.room.currentSide,
      turn_number: this.room.turnNumber,
      max_turns: this.room.maxTurns,
      created_at: this.room.createdAt,
      ended_at: this.room.endedAt,
    };
  }

  notifyWaiters() {
    for (const waiter of [...this.waiters]) {
      const payload = this.turnPayload(waiter.side, waiter.afterEventId);
      if (!payload.ready && !payload.ended) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(payload);
    }
  }
}

function normalizeIdentity(identity, side) {
  if (!identity || typeof identity !== "object") {
    return { display_name: `测试 ${side}` };
  }

  const displayName = String(identity.display_name ?? `测试 ${side}`).trim();
  if (!displayName) {
    throw new RoomError("INVALID_IDENTITY", "display_name must not be empty");
  }

  return {
    display_name: displayName,
    companion_name: String(identity.companion_name ?? "").trim(),
  };
}

function oppositeSide(side) {
  return side === "A" ? "B" : "A";
}
