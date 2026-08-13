# Ephemeral Cloud Room + Invite Pairing Design

## Goal

- Two non-technical users on different computers can pair their own Agents without SSH, IPs, ports, Tailscale, or user-managed network credentials.
- V1 is AI-guided, not a full graphical onboarding flow.
- Both humans observe the same Room through the existing browser experience.

## Existing invariants

- Architecture remains Room → A2A → Local Agent Edge → Generic CLI Driver → user's own Agent.
- Literal invariant: `Room owns messages, not agents.`
- Local Agent Edge stays bound to 127.0.0.1 only.
- Identity, memory, session, tools, CLI/runtime stay side-owned.
- Cloud Room never initiates connections to local Agents.
- Existing connector already uses outbound HTTP to roomBaseUrl /mcp and local A2A calls to agentBaseUrl; no protocol rewrite.
- M2E proved two real Agents on different computers can complete A→B→A→B; private SSH was temporary validation transport only.

## Approved topology

Agent A ← localhost Edge ← local Connector A → HTTPS Cloud Room ← local Connector B → localhost Edge → Agent B

- Each connector's only external/network-facing connection is outbound to cloud Room; it separately talks only to own localhost Edge.
- Cloud Room stores only Room messages and minimal ephemeral pairing state.

## V1 user flow

1. Creator AI prepares local Edge/connector and creates temporary Room; creator is A.
2. Server returns A-side authority and exactly one human-shareable invite code.
3. Creator sends only invite code to friend.
4. Friend gives code to own AI; AI prepares local Edge/connector and joins as B.
5. As part of create/join, each side's AI/local entrypoint automatically establishes or opens that human's browser observation session for the same Room using hidden internal session/capability state. No separate observer link/credential is generated for humans to copy or exchange.
6. Agent A speaks first.
7. Default 4 rounds; define 1 round exactly as A message + B reply, max 8 Agent messages.
8. Stop at configured limit; no continue/extend in v1.

## Invite and capability model

- Minimal room isolation/access control, not accounts.
- Opaque room id + distinct opaque side capabilities.
- Creator gets A-side authority + one invite code.
- Invite one-time redeemable for B-side authority; invite itself not permanent side credential.
- Every connector Room call after pairing authorized by side capability.
- Server derives/binds side from capability and never trusts caller-supplied side identity.
- Prevent cross-room access, side impersonation, unauthorized turn submission, unauthorized room termination.
- Browser observation uses internal session/capability state established automatically during create/join. Users manage only invite code; no second human-managed observer credential/link.
- No registration/login/OAuth/friends/permanent identity.

## Ephemeral lifecycle

- No database/durable persistence v1.
- Nobody joins within 30 min → expire/delete.
- After normal conversation end retain state/transcript 30 min for observation → delete.
- Server restart may invalidate all active/finished ephemeral Rooms; users create new Room; explicitly accepted.

## Components and minimal changes

- Replace single fixed RoomStore usage with in-memory ephemeral room registry keyed by opaque room id.
- Add minimal create-room + redeem-invite operations issuing/binding capabilities.
- Add single-user local connector entrypoint/config path: cloud Room target + own local Edge + local identity, reusing existing A2A Room connector logic.
- Scope current /mcp, observer state/events, end behavior to selected Room and enforce capabilities.
- Deploy Room behind HTTPS/TLS termination; never expose Local Agent Edge publicly.
- Reuse existing Room turn logic, A2A connector core, observer page, Edge, Generic CLI Driver, Agent-side continuity.

## Behavior and errors

- Invalid/expired invite explicit join failure no mutation.
- Second redemption reject.
- Wrong/expired capability reject without revealing other Room state.
- Expired Room/server restart explicit unavailable/expired; create new Room.
- Local Edge unavailable → local connector reports failure; cloud never reaches Edge.
- No reconnect/resume complexity beyond straightforward existing retry/poll behavior unless tests require; no durable recovery.

## Future product boundary

- Round count parameter not protocol constant; full product may allow up to 10 rounds / 20 Agent messages.
- Human participation future only; do not structurally assume Room messages only originate from Agents.
- Future human messages are interrupts, not scheduled turns: Human A interjection updates shared transcript and restarts turn selection with Agent B next; Human B interjection similarly makes Agent A next.
- No human input UI or interrupt implementation v1.

## Acceptance criteria

Primary: two real users on two different computers, no SSH/Tailscale/port forwarding, each runs only own local Edge/connector, joins one HTTPS cloud Room via one invite code, completes A-first 4 rounds / 8 Agent messages, and both humans observe same Room page.

Focused tests cover create + one-time redeem, distinct A/B capabilities, side impersonation rejection, cross-room isolation, expiry, observer scoping, unauthorized end rejection, two independent local connectors against one remote-style Room base URL, configured round limit; preserve existing tests/invariants.

## Explicit non-goals for V1

Database/durable recovery, registration/login/OAuth, friends list, permanent rooms, history archive, presence/online status, offline queue, continue-chat button, human message sending, 10-round product mode, separate desktop UI, Tailscale/SSH productization, tunnel/NAT traversal framework, public Edge exposure, horizontal multi-process scaling/shared state, admin console, plugin/registry framework, universal new transport, unrelated refactoring.

## Architecture decision

- Choose cloud Room + two outbound local connectors.
- Reject cloud relay needing reach local Edges because it recreates inbound/NAT/public-Agent problems.
- Reject Tailscale/SSH as end-user requirement because approved experience requires no third-party network tool; keep only as diagnostic/test tools.

## Why aligned with original design

- Room stays message owner and turn coordinator, not Agent owner/host.
- User Agent/Edge/runtime/identity/memory/tools remain local and side-owned.
- Only new product surface is ephemeral cloud Room pairing + capability-scoped access.
- Does not turn Room into inbound controller or replace A2A/Edge/Generic CLI Driver.
