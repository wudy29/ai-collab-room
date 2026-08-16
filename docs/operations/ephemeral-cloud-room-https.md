# Ephemeral Cloud Room HTTPS Operations

This guide documents the bounded HTTPS deployment and acceptance procedure for the ephemeral cloud Room feature. It covers only what is already implemented; it adds no infrastructure automation and assumes no deployment mechanism exists.

Audience: the technical executor. The nontechnical user performs no deployment work; all host access and deployment actions in this guide are executor-side only.

## 1. What the Room application provides

- `npm start` runs the Room application (`node src/server.js`), which listens on loopback `127.0.0.1` using the `PORT` environment variable (default `8787`).
- `POST /mcp` is the global pairing MCP endpoint exposing exactly `create_room` (no arguments) and `redeem_invite({ invite_code })`.
- `POST /rooms/:roomId/mcp` is the capability-scoped Room MCP endpoint, authorized by a Bearer side capability.
- `GET /observe/:token` is the one-time observer bootstrap handoff; it redirects once to the scoped observer shell at `/rooms/:roomId`.
- `GET /rooms/:roomId/events` is the scoped SSE stream; `GET /rooms/:roomId/api/state` is the scoped state snapshot.
- Local Agent Edge is bound to loopback only, always. It is never exposed publicly.

## 2. Preconditions before claiming a public deployment

Do not claim a public deployment until all of the following are true:

1. The Room application starts on loopback with `PORT`. Run `npm start` and confirm it listens on `127.0.0.1` at the configured port.
2. A same-machine HTTPS/TLS route to that loopback upstream **already exists**. This repository does not create, configure, or manage any route, host, hostname, certificate, TLS process, tunnel, NAT rule, or deployment mechanism. If no such route exists, stop and ask for direction; do not build one.
3. The route preserves SSE. The observer page depends on the scoped stream at `/rooms/:roomId/events` (`text/event-stream`); the route must forward that stream without buffering, truncating, or terminating it.
4. Nothing else is assumed. A host, hostname, certificate, TLS process, tunnel, or deployment mechanism is present only if it already exists on the machine; verify each prerequisite, and stop if any is absent or unsafe.

The public origin used for acceptance is the HTTPS origin of that existing route; it is the value configured as the Room origin for the guided flow.

## 3. Reachability check

After the Room application is up and the existing HTTPS route is in place, verify only network/TLS reachability with:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$ROOM_ORIGIN/mcp"
```

where `$ROOM_ORIGIN` is the public HTTPS origin of the existing route.

A non-`000` result proves only that the network path and TLS handshake to the origin reach the application; it is **not** evidence of a successful MCP request. Only `000` means the connection itself failed. This command must not use `--fail` or `HEAD`; treat any non-`000` status (including an error status) strictly as reachability evidence.

## 4. Deployment action

- Use the established host-access/deployment procedure of the machine, and only if an existing same-host HTTPS/TLS route to the loopback upstream is available. This is executor work; the nontechnical user does not perform it.
- Start the Room application on loopback `PORT` and connect only the already-existing route, preserving SSE.
- Keep Local Agent Edge loopback-only; every Room request made by the local tools is outbound HTTPS to the Room origin.

## 5. Two-machine acceptance sequence

Use the implemented product behavior end to end:

1. On both computers, run the guided setup (`npm run cloud-room:setup`); the flow writes the `.cloud-room.json` configuration with the HTTPS Room origin and display identity. The AI, not the human, supplies exactly one `cloud-room:configure {...}` line. If Edge configuration is missing, the flow directs the user's AI to the existing `npm run edge:setup` onboarding.
2. On computer A, run `npm run cloud-room:create`. It reads the configuration, starts and validates the configured Local Agent Edge internally, then calls global `create_room`, opens the internal observer browser via `/observe/<bootstrap-token>`, and runs the Room connector. It prints exactly one authority line: `Invite code: <code>`.
3. Share only that one invite code with computer B. No capabilities, observer links, or configuration are shared.
4. On computer B, run `npm run cloud-room:join <invite-code>`. It follows the same internal sequence: read configuration, start and validate the configured Edge, call global `redeem_invite`, open the internal observer browser via its own `/observe/<bootstrap-token>`, and run the Room connector. It prints no authority.
5. Both computers make only outbound HTTPS Room traffic to the shared Room origin; Local Agent Edge stays on loopback on each machine.
6. The Room completes exactly eight alternating Agent messages (the production Room limit is `maxTurns: 8`) and ends.
7. Both authorized observer browser sessions display the same complete eight-message transcript.

## 6. Expiry and restart

- Do not wait 30 minutes on real hardware to prove expiry. Expiry is covered by deterministic registry tests that drive an injected clock and call `sweep()`; there is no timer or background expiry loop.
- Only an optional short restart-loss confirmation is allowed: restart the Room application and confirm that active or ended Rooms are lost, because the ephemeral Room registry is intentionally in-memory. This check is optional and must remain short.

## 7. Out of scope

This guide does not describe creating infrastructure: no certificates, TLS processes, tunnels, NAT rules, DNS, hostnames, or deployment automation. It does not expose Local Agent Edge publicly and does not add future-product recommendations. If a required prerequisite is absent, stop and ask for direction.
