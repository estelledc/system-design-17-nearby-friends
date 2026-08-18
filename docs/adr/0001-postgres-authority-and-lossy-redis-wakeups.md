# ADR 0001: PostgreSQL presence authority and lossy Redis wakeups

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The fixed chapter correctly identifies rapidly changing locations, active-friend fanout, persistent connections, TTL, and
geohash/channel boundaries as the core pressure. Its Redis Pub/Sub location path still has no authorization version, update
identity, initialization watermark, replay, TTL removal guarantee, or block/revoke cutover. Redis itself documents Pub/Sub as
at-most-once and expiration notifications as potentially delayed.

The lab needs one runnable slice that proves an authorized live view under response loss, update reordering, expiry, revocation,
and a missed/duplicated wake hint. It does not need to build a globally sharded WebSocket fleet or store real location history.

## Decision

### 1. PostgreSQL/PostGIS owns all result-authorizing state

PostgreSQL stores synthetic accounts, two directional relationship edges, a sharing-policy epoch, one current device generation,
strict device sequence, current expiring geography presence, durable mutation receipts, nearby sessions, ordered session events,
and an outbox.

Every state/session mutation locks one singleton system revision first. A successful transaction increments the revision exactly
once and atomically writes the new state, receipt, all affected session `refresh_required` events, and their outbox rows. A stale
generation/sequence/precondition records or returns a bounded conflict without extending presence.

One global lock and relational fanout are intentional correctness bottlenecks for this lab, not a production sharding design.

### 2. Authorization is recomputed before every location response

A sharer is visible only when:

- viewer → sharer and sharer → viewer directional edges are both current `accepted`;
- the sharer's current sharing policy is enabled;
- current presence belongs to the current device generation and has `expires_at > database_now`;
- `ST_DWithin(presence, session center, radius, true)` accepts the point.

Results sort by spheroid distance rounded to integer millimeters and synthetic account UUID. A partial GiST index accelerates
current presence, but no cell/channel membership authorizes or proves proximity.

### 3. One strict device sequence prevents delayed resurrection

v0.1 supports one current device generation/account. Rotating/revoking the generation removes current presence in the same
transaction. Location sequence must be exactly previous + 1; exact stable-key replay returns its original location epoch/revision,
while a changed intent, old generation, duplicate sequence under another key, or forward gap conflicts.

The database assigns acceptance/expiry time. Client captured time and multi-device merging are rejected rather than silently using
an untrusted wall clock. No location history is retained.

### 4. Nearby sessions use durable generic refresh cursors

Session creation holds the global revision lock while it stores the bounded synthetic center/radius, expiry, and an initial exact
view boundary. Every later relevant account/relationship/policy/presence mutation appends a monotonically increasing event to each
affected active session.

The event contains no friend identity or coordinates—only sequence, system revision, and `refresh_required`. Draining after a
cursor returns the bounded events plus one newly authorized full view that replaces client state. A duplicate cursor is idempotent;
a retention gap, overflow, expired session, or invalid sequence returns `resync_required`.

This favors privacy and simple convergence over fine-grained location deltas. It does not claim a remote client applied the view.

### 5. Redis Pub/Sub carries only optional wake hints

Each durable event also creates an outbox row. A worker publishes `{version, upperSequence}` to an HMAC-derived opaque session
channel, then marks the outbox row sent.

- Crash before publish: the pending/expired claim is retried.
- Crash after publish but before mark: retry may duplicate the hint; cursor drain is idempotent.
- Subscriber disconnected or Redis loses the message: periodic/reconnect cursor drain reads PostgreSQL and recovers.
- Redis unavailable: authoritative state/event commits remain valid; wakeup latency degrades and outbox backlog is visible/bounded.

No coordinate, relationship, account/device/session ID, auth/update key, query digest, result, or policy state enters Redis. Publish
subscriber count is broker-local evidence, not WebSocket write, device receipt, render, or human outcome.

### 6. HTTP proves the application protocol before WebSocket transport

The runnable lab uses authenticated bounded HTTP routes for mutations, session snapshot, and cursor drain. The process smoke uses a
real Redis subscriber as the server-side wake observer. A future WebSocket/SSE adapter may carry the same envelopes, but transport
framing cannot replace cursor, retention, authorization, or resync semantics.

### 7. Evidence stops at the server boundary

Allowed labels include `relationship_policy_committed`, `location_update_accepted`, `session_event_committed`,
`redis_wake_published`, `nearby_response`, and `server_bytes_written`.

No event may claim device receipt/apply, background permission, GPS truth/accuracy, map rendering, physical co-presence, meeting,
safety, consent validity, satisfaction, regulatory compliance, production deployment, or external acceptance.

## Consequences

### Positive

- Relationship/policy, device fencing, presence, exact index state, durable stream cursor, and response-loss receipt share one
  serial order.
- Block/revoke/disable and expiry are rechecked before returning coordinates; stale Pub/Sub subscription state cannot authorize.
- A Pub/Sub disconnect or process crash changes wake latency, not recoverable view truth.
- Redis payload/log exposure is much smaller than forwarding precise friend locations through per-user channels.
- Snapshot/event gaps, slow consumers, dense results, and high fanout fail visibly.

### Costs and limits

- One global lock, transactional per-session fanout, full-view refresh, and one database are severe scaling bottlenecks.
- A session stores a precise synthetic viewer center and result reads expose exact synthetic friend coordinates.
- Generic refresh events do extra database work and cannot reconstruct every intermediate location after coalescing/retention.
- Polling is still needed for pure TTL expiry when no mutation publishes an event; Redis expiration is not used as the clock.
- Outbox publish/mark is at-least-once attempt behavior, not exactly-once delivery.
- Redis 7.4 single-node CI does not prove Redis Cluster, sharded Pub/Sub, failover, persistence, or a WebSocket fleet.

## Rejected alternatives

### Raw location on per-user Redis Pub/Sub channels

Rejected because at-most-once loss has no replay, subscriber membership can lag authorization, and precise coordinates spread to
every subscribed server before per-viewer filtering. It also leaves cache/history/in-memory/publish ordering unversioned.

### Redis TTL/keyspace notification as offline truth

Rejected because expiration events may be delayed, are fire-and-forget, and are node-local in a cluster. `expires_at` is enforced
in every authoritative query; cleanup/notification is only operational assistance.

### Client-directed subscribe/unsubscribe

Rejected because mobile state cannot authorize social edges. Client messages may request a refresh, but the server must resolve
current relationship/policy versions and choose subscriptions/results itself.

### Custom consistent-hash Redis Pub/Sub ring

Rejected for v0.1 because ring publication, subscriber handoff, dual-read period, fencing, rollback, and loss audit are separate
experiments. Redis 7+ sharded Pub/Sub is also a current alternative; neither is needed to prove the application invariant.

### Redis Streams as the primary location/event authority

Rejected because persistence/replay alone would not atomically join social authorization, device sequence, PostGIS state, and
session visibility across Redis/PostgreSQL. A future single-authority Streams design could be valid, but the controlled Streams
documentation fetch also remained unverified in this run.
