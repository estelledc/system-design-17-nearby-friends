# Runnable requirements

## Scope

v0.1 is a clean-room laboratory for one server-side claim: an authenticated viewer can obtain a bounded, exact, current view of
synthetic nearby mutual friends, and can recover that view after duplicate or missing Redis wake hints without disclosing a
revoked, blocked, disabled, stale-device, or expired presence.

It is not a mobile client, social network, map, safety product, production deployment, or proof of real-world proximity.

## Functional requirements

1. One bearer identity may create exactly one synthetic account. A stable idempotency key replays the original receipt; changed
   intent conflicts.
2. Each directional relationship edge is independently versioned as `accepted`, `revoked`, or `blocked`. Visibility requires both
   directions to be `accepted` at response time.
3. A sharer must explicitly enable its versioned sharing policy. Disabling it removes current presence in the same transaction.
4. One current device generation owns a strict sequence starting at one. Rotation removes current presence; an old generation,
   duplicate sequence under a new key, or forward gap cannot write.
5. A location uses named finite latitude/longitude, server acceptance time, a TTL of 1–600 seconds, and no retained history. Exact
   stable-key replay returns the original epoch and expiry without extending it.
6. A nearby session stores a bounded synthetic center, radius of 1–50,000 meters, at most 100 results, an initial database revision,
   an opaque wake channel, and a 30-minute expiry.
7. Every result is reauthorized against mutual edges, enabled policy, current generation, query-time expiry, and inclusive PostGIS
   spheroid `ST_DWithin`. Results sort by integer millimeter distance and account UUID.
8. If more than `maxResults` exact authorized rows exist, the request fails with `density_limit_exceeded`; it must not return a
   partial list while claiming completeness.
9. A relevant mutation appends one generic `refresh_required` event to every affected active session in the same transaction. The
   event contains sequence, system revision, type, and server time—never a friend ID or coordinate.
10. Event drain accepts an owner-bound signed cursor and returns retained events plus one replace-whole, freshly authorized view.
    A gap, future cursor, expired session, or wrong owner fails explicitly.
11. Redis Pub/Sub receives only `{version, upperSequence}` on an HMAC-derived opaque channel after the database commit. Duplicate,
    missing, or zero-subscriber publication cannot change authoritative state.
12. A mutation touching more than 1,000 active sessions aborts atomically with `fanout_limit_exceeded` before location, receipt,
    events, or outbox state advances.

## Evidence requirements

- Pure tests cover input, ETag, digest, cursor, HTTP, log, and worker contracts.
- Real PostgreSQL/PostGIS tests cover exact geometry, authorization joins, revision order, receipts, sequence fencing, expiry,
  density, fanout rollback, retention gaps, and concurrent revoke/drain boundaries.
- Real Redis tests cover generic payloads, duplicate publish-after-crash behavior, zero-subscriber loss, and database-cursor repair.
- A true-process smoke kills the API after a committed location update but before its response and kills the worker after Redis
  publish but before outbox completion.
- A bounded synthetic benchmark reports its exact fixture, runtime/service versions, latency observations, exclusions, and raw
  database counts without extrapolating production capacity.
- Public CI runs Node 22, 24, and 26 against pinned PostgreSQL 17/PostGIS 3.5 and Redis 7.4 images with zero skipped infrastructure
  tests and a high-severity dependency audit.

## Explicitly unproved

The lab does not prove remote device receipt or apply, background permission, GPS truth or accuracy, map rendering, road distance,
physical co-presence, a meeting, safety, informed consent, anti-abuse effectiveness, regulatory compliance, multi-region recovery,
production capacity, SLA, deployment, merge, release, or external acceptance.
