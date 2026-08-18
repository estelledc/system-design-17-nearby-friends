# Research log

## Evidence boundary

The secondary chapter is fixed at repository commit `9d8388721e7231442763ad37398b8d82224aa68f`, chapter tree
`5b0e8c92d5b448f6b1a478e21f654e50cc3f1050`, and `README.md` blob
`e09669d133cf5b7b774a7e2424857c2bb9f9a338`. That tree has no detected license, so this repository contains only independent
analysis and implementation. It does not copy the chapter's prose, diagrams, images, map data, social graph, location traces, or
code.

Public standards and official project documentation are used to check mechanisms. They do not make the future implementation a
conforming Facebook, Redis-hosting, PostGIS-hosting, mobile location, privacy, or production safety service.

## Closed-book comparison

| Question | Closed-book decision | Fixed chapter | Result for v0.1 |
|---|---|---|---|
| visibility | current mutual friendship, sharing policy, block/revoke, freshness, and exact distance all authorize a result | friendship DB is fetched at WebSocket initialization; policy/block/revoke semantics are absent | model symmetric directional relationship edges plus current sharing policy in the query transaction |
| location updates | stable device generation + strict sequence + immutable intent; delayed writes cannot resurrect | WebSocket updates cache/history/in-memory state and then publishes, with no update identity or ordering | one PostgreSQL transaction fences generation/sequence, replaces current presence, and records durable receipts/events |
| freshness | server-time expiry checked on every view; expiry notification is optional wakeup only | Redis TTL removes location after ten minutes | retain bounded `expires_at`; query-time predicate removes stale presence even if no cleanup/notification runs |
| live continuity | snapshot and ordered durable deltas share an authority; loss/overflow forces resync | Redis Pub/Sub pushes friend channels; occasional loss is accepted | materialize a session snapshot boundary and durable per-session refresh cursor; Pub/Sub carries only lossy wake hints |
| proximity | spatial index is candidate acceleration; one exact Earth model decides inclusive radius | each receiving WebSocket server calculates distance; formula, boundary, input domain, and index are absent | use PostGIS geography `ST_DWithin` plus deterministic distance/ID order |
| privacy evidence | no real data; no coordinates/edges/IDs/keys/tokens/results in ordinary logs; server bytes are not device receipt | precise history is retained for possible ML and GDPR is explicitly ignored | omit history, minimize Redis payload, bound session retention, and keep compliance/safety unproved |

## What the chapter contributes

- Moving people and relatively static places have different write/freshness pressure; periodic location updates dominate the hot
  path.
- A shared backend is more practical than mobile peer-to-peer for flaky connections and power constraints.
- Persistent connections need graceful draining, connection ownership, and reconnection behavior rather than ordinary stateless
  load balancing alone.
- Current location, historical analytics, social graph, and live delivery have different state/lifetime patterns and should not be
  collapsed into one store.
- Fanout cost is approximately active sharers × active friends, not only ingress QPS; high-degree accounts and channel movement are
  explicit hot spots.
- Geohash borders require multiple cells/candidates and a final distance decision; same-cell membership is not proximity.

These are useful directions. v0.1 focuses on the unclosed join between authorization, device ordering, server-time expiry, exact
distance, response-loss replay, and a gap-detectable live view.

## Defects and missing contracts in the fixed chapter

1. **Sharing consent is missing from the state model.** The feature is described as location sharing, but there is no enable/disable
   policy, audience, policy version, block, relationship revocation cutover, or rule for already queued location messages.
2. **The client is trusted to change subscriptions.** Friend add/remove is delegated to a mobile callback that tells the WebSocket
   server what to subscribe to. Without server-side relationship reauthorization, a modified client can request arbitrary user
   channels; with it, the callback is only an untrusted hint and needs a version/cursor.
3. **Initialization has a snapshot/subscribe race.** Fetching friends, subscribing to channels, reading their cached locations, and
   sending the initial list has no frozen order or watermark. An update between cache read and subscribe can be permanently absent.
4. **Redis Pub/Sub loss has no repair protocol.** “Occasional loss is acceptable” may justify stale telemetry, but the client is
   still shown an apparently current list. There is no sequence, replay window, acknowledgment, gap detector, resnapshot, or
   maximum staleness.
5. **Location writes have no stable identity or ordering.** Cache, in-memory copy, history write, and publish are separate steps.
   A delayed/retried sequence can overwrite a newer coordinate, extend TTL, duplicate history, or publish old state after new.
6. **Multi-device and client time are undefined.** `timestamp` could mean capture, receive, cache, or display time. No device
   generation, monotonic sequence, clock-skew bound, winner rule, or revoked-device fence exists.
7. **TTL is treated as an offline event.** Cache deletion does not itself retract a location already held by WebSocket servers or
   clients. No viewer timer/removal message/query-time freshness check binds the displayed friend to the authoritative TTL.
8. **Distance is not a contract.** Five miles and “straight line” do not define coordinate order/domain, sphere versus spheroid,
   inclusive boundary, antimeridian/poles, GPS uncertainty, deterministic ties, or maximum exact work.
9. **Authorization and distance happen after disclosure into infrastructure.** Raw location is published on the sharer's channel to
   every subscribed server, and each server filters per friend afterward. The design does not version subscribers against current
   friendship/policy or minimize who can receive precise coordinates.
10. **Eventual consistency is unbounded for privacy changes.** A few seconds of location replica delay is declared acceptable, but
    location freshness and block/revoke delay have different harm. No maximum or fail-closed rule is attached to revocation.
11. **The fanout number is not an end-to-end capacity model.** `334k × 40 ≈ 13.36m` friend deliveries/s explains magnitude, but a
    Redis `PUBLISH`, server subscriber delivery, distance calculation, WebSocket write, network byte, and device apply are different
    units. The 100k pushes/server and 140-server conclusions have no payload, subscriber, CPU, network, or benchmark evidence.
12. **Channel memory claims conflict.** The chapter says unused channels consume no memory, then proposes pre-allocating all
    channels and separately estimates 200 GB without an object layout, subscriber distribution, client-output buffers, or
    measurement.
13. **A custom channel ring is underspecified and partly stale.** ZooKeeper/etcd, a cached consistent-hash ring, Redis nodes, and
    subscriber handoff have no configuration version, activation barrier, dual-subscribe interval, rollback, or missed-message
    audit. Current Redis also offers sharded Pub/Sub; an application-managed ring is not the only cluster model.
14. **Daily scaling conflicts with unpredictable reconnect load.** It accepts missed updates during channel movement and suggests
    low-traffic maintenance, but has no spike signal, drain deadline, resubscription receipt, or correctness condition.
15. **“Enough WebSocket servers” is not a whale policy.** A 5,000-friend cap still needs per-connection subscription, memory,
    distance CPU, egress, slow-consumer, and output-buffer limits. The cap does not bound how many whales land on one server.
16. **Connection drain lacks application recovery.** Stopping new connections before teardown is useful, but there is no last
    durable cursor, reconnect authentication, session takeover, duplicate connection rule, or proof that a graceful close delivered
    the final update.
17. **Location history is an unbounded privacy sink.** Four columns do not define partition key, event identity, ordering, retention,
    deletion, encryption, access purpose, duplication, or consent. “Valuable for ML” is not a storage or authorization contract.
18. **The random-person extension changes the trust model.** It expands from accepted friends to strangers without separate opt-in,
    abuse controls, anonymity, result bounds, or safety review; subscribing to “several” neighboring geohashes still has no global
    covering proof or exact filter.
19. **APIs and logs are not specified.** WebSocket routine names have no authenticated fields, bounds, response-loss behavior,
    errors, versioning, delivery evidence, log policy, or metrics cardinality.
20. **Historic product/scale claims are uncited.** One billion users, 100 million daily users, 400 friends, 5,000-friend cap, Redis
    capacity, and memory estimates are not current requirements or reproducible facts for this lab.

## Primary-source corrections

### Redis Pub/Sub is a wakeup hint, not a replayable location ledger

Redis [Pub/Sub documentation](https://redis.io/docs/latest/develop/pubsub/) explicitly defines at-most-once delivery: after Redis
sends a message, an unavailable/erroring subscriber cannot receive it later. The same documentation points to persisted Streams
when stronger delivery is needed. It also documents sharded Pub/Sub in Redis 7.0+, where shard channels map to cluster slots and
propagation stays within the shard rather than requiring every message to traverse every node.

v0.1 therefore does not publish coordinates, relationship edges, or authoritative deltas through Pub/Sub. PostgreSQL commits a
per-session generic `refresh_required` event and outbox row with the location/policy mutation. A worker may publish an opaque
session-channel wake hint after commit; duplicate hints are harmless and a missed hint is repaired by polling the durable cursor.
The selected Redis 7.4 lab is a single node, so the current sharded-cluster mechanism is documented but not claimed as tested.

The controlled Redis Streams page fetch failed twice. It remains a candidate rather than verified additional source. v0.1 does not
depend on Streams behavior.

### TTL expiry notification is not the freshness boundary

Redis [keyspace notification documentation](https://redis.io/docs/latest/develop/pubsub/keyspace-notifications/) calls the channel
fire-and-forget, states that disconnected clients lose events, and explains that an `expired` event is emitted when Redis actually
deletes the key—not necessarily when TTL theoretically reaches zero. With many unaccessed keys, that event can be significantly
delayed; cluster keyspace events are node-local rather than broadcast everywhere.

v0.1 stores a bounded server `expires_at` and checks it in every nearby snapshot/event-drain query. Cleanup or a wake hint may be
late without authorizing stale presence. Expiry removal still requires polling/timer behavior; no “offline message delivered” fact
is inferred from TTL.

### WebSocket framing does not define the nearby application cursor

[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html) defines a bidirectional message-framing protocol layered over TCP and says
application metadata is layered above WebSocket. It defines handshake, frames, fragmentation, control messages, and closing—not
this product's relationship version, snapshot watermark, replay retention, acknowledgment, or resync state.

It is therefore an inference, not a quotation from the RFC, that a nearby service must supply its own cursor/gap protocol. v0.1
proves that application contract through bounded HTTP snapshot/event-drain endpoints; a future WebSocket transport may carry the
same envelopes but cannot replace their durable semantics.

### Exact radius remains a database predicate after authorization

PostGIS [`ST_DWithin`](https://postgis.net/docs/ST_DWithin.html) documents that `geography` distance is in meters, defaults to
spheroid measurement, and includes an index-usable bounding-box comparison. v0.1 uses named latitude/longitude inputs,
`ST_Point(longitude, latitude, 4326)::geography`, current mutual authorization, query-time expiry, inclusive
`ST_DWithin(..., true)`, and deterministic millimeter distance plus account ID ordering.

No geohash/cell prefix or Redis channel decides exact proximity. GPS accuracy, obstacles, road distance, and physical co-presence
remain outside the server geometry claim.

### One transaction snapshot needs an explicit serializable conflict policy

PostgreSQL 17 [transaction isolation documentation](https://www.postgresql.org/docs/17/transaction-iso.html) explains that Read
Committed statements may see different snapshots, Repeatable Read fixes a transaction snapshot but can still admit serialization
anomalies, and Serializable emulates a serial order for committed transactions while requiring whole-transaction retries on
`40001`.

v0.1 uses a singleton revision lock before relationship/policy/device/presence/session mutations. This deliberately serializes the
small lab, makes snapshot registration and subsequent per-session events one order, and avoids treating isolation level names as a
complete application invariant. The lock is a correctness bottleneck, not a scale claim.

## Decisions after comparison

- Use PostgreSQL 17 plus PostGIS as the authority for synthetic accounts, directional relationship state, sharing policy, current
  device generation/sequence, expiring presence, nearby sessions, per-session ordered refresh events, idempotency receipts, and an
  outbox.
- Require mutual `accepted` edges, enabled current policy, current device generation, unexpired presence, and exact distance at
  response time. `blocked`/`revoked` edges fail closed; server relationship state—not client subscription requests—authorizes.
- Use server receipt time and strict next device sequence in v0.1. Do not accept client wall time as the winner or retain location
  history. Exact replay returns the original location epoch/revision; changed or stale sequence conflicts.
- Create a nearby session while holding the global revision lock, so its initial exact snapshot precedes every later durable
  per-session event in one total order. Events contain only sequence/revision and `refresh_required`; event drain returns a replace-
  whole current view after reauthorization.
- Retain a bounded event window. Duplicate cursors are idempotent; a cursor below retention, misaligned sequence, expired session,
  or overflow returns `resync_required` instead of an apparently current partial stream.
- Publish only opaque HMAC-derived session wake channels and upper sequence through Redis Pub/Sub after the PostgreSQL transaction.
  The outbox uses publish-before-mark; a crash may duplicate a hint but cannot lose the durable event. Pub/Sub receipt is not server
  stream bytes, device receipt, or apply.
- Use spheroid `ST_DWithin` and distance/ID total order, cap friend/session fanout, results, retention, request size, and worker
  batches, and abort visibly rather than silently truncate a complete-view claim.
- Keep all fixtures synthetic. Application logs omit coordinates, edges, account/device/session/update IDs, keys, digests,
  channels, tokens, and result bodies.

## Remaining unknowns

- Production friend-graph ownership, high-degree fanout, spatial-first versus friend-first intersection, partitioning, hot users,
  and distributed revision/event sequencing.
- Multi-device location merge, client capture time/skew, sensor accuracy, spoofing/attestation, background permissions, and battery
  policy.
- WebSocket session takeover, server drain, replay/ack protocol, slow-client egress, connection admission, and Redis Cluster/sharded
  Pub/Sub failure/rebalance behavior.
- Event/session/outbox retention cleanup, Redis/database failover, backups, multi-region ownership, disaster recovery, and capacity.
- Real identity, consent, block abuse, anti-stalking/scraping, moderation, audit access, encryption/key rotation, erasure, regulatory
  compliance, safety, and incident response.
