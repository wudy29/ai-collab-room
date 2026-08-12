# M2E Two-Machine Private SSH Validation Design

## Status

Temporary validation design for today's test window. This is intentionally
narrower than future product design and is not productization work.

## Goal

Prove that two real Agents on two different user computers can complete the
strict existing four-message flow in A->B->A->B order through the existing Room.

## Architecture

```text
User A real Agent
  -> Local Agent Edge
  -> Room on A's Mac

User B real Agent
  -> Local Agent Edge
  -> SSH reverse tunnel through A's existing cloud server
  -> SSH local forward on A's Mac
  -> existing A2A Room connector
  -> Room
```

The cloud server is transport-only. It owns no Room, Agent, identity, memory,
session, or messages beyond unavoidable SSH transport.

Preserve the principle: "Room owns messages, not agents."

## Reuse

- Reuse `src/a2a-room-connector.js` support for an arbitrary `agentBaseUrl`.
- Reuse the existing M2C four-message flow and its message semantics.
- Manual test setup may use shell SSH commands outside project code.

## Minimal Code Scope After Approval

Add one thin validation runner or entrypoint that accepts two already-existing
A2A base URLs and runs the existing four-turn Room flow.

Do not change Room core, Local Agent Edge localhost binding, Generic CLI Driver,
onboarding, agent ownership, or message semantics.

## Explicit Non-Goals

- No cloud-hosted Room.
- No pairing or invite code.
- No tunnel framework or SSH automation.
- No account, auth, or friend system.
- No UI, registry, daemon, or process manager.
- No public exposure of Local Agent Edge.

## Success Criteria

- Both users start their own real Edge.
- A can reach B's Edge through private forwarding.
- The validation runner completes exactly four messages in A->B->A->B order,
  with non-empty replies.
- Both humans can observe the exchange through the existing Room surface if used.
- Tunnel teardown leaves neither Edge publicly exposed.

## Stop Condition

Once this cross-machine proof passes, stop and separately design the
productized cross-machine and pairing layer.
