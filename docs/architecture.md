# Architecture

## One authority, one optional accelerator

PostgreSQL/PostGIS is the only component allowed to decide or reconstruct a nearby result. Redis Pub/Sub is an optional low-latency
wakeup path. Treating those roles separately is the central design decision.

| State or action | Authority | Why |
|---|---|---|
| account, directional edge, sharing policy | PostgreSQL | authorization must share the mutation order used by session events |
| current device generation and strict sequence | PostgreSQL | delayed/retried updates must not resurrect an old presence |
| current coordinate and server expiry | PostgreSQL/PostGIS | exact distance and freshness are checked in the result query |
| mutation receipt | PostgreSQL | response loss must replay the original committed result |
| session snapshot boundary and event cursor | PostgreSQL | snapshot and later refresh events need one total order |
| generic wake hint | Redis Pub/Sub | useful for latency; safe to duplicate or lose because it authorizes nothing |

## Mutation path

Every account, edge, policy, device, or location mutation runs this bounded sequence:

1. validate the exact HTTP contract and compute an intent digest;
2. open a transaction and check an existing receipt;
3. lock the singleton system revision, then recheck the receipt;
4. lock the authenticated account and current resource version;
5. reject stale preconditions with a durable receipt where the operation contract requires it;
6. resolve at most 1,000 affected active sessions;
7. increment the revision once and atomically write state, receipt, generic session events, and outbox rows;
8. commit before returning a response.

The singleton lock is intentionally simple and slow. It proves one serial mutation order in a small lab; it is not a proposed
partitioning strategy for a global service.

## Nearby snapshot and refresh

Session creation also takes the singleton lock. Its exact authorized query therefore happens before every later mutation/event in
the same total order, and the durable event sequence starts at zero. The session query and initial revision are stored, but precise
result rows are not: an idempotent retry reauthorizes at the current revision and advances its cursor to that view. This prevents a
post-revocation retry from replaying coordinates that were valid only in the lost pre-revocation response.

A cursor drain uses a Repeatable Read, read-only transaction. For that one snapshot it:

- checks owner and session expiry;
- verifies the requested sequence is within the retained contiguous window;
- reads every later generic event;
- recomputes the full current authorized result;
- returns one new cursor and marks the result as `replaceWholeView`.

The client never has to merge precise per-friend deltas. Replacing the view costs more database work but makes duplicate wake hints
and coarse privacy invalidations easy to reason about.

## Authorization and geometry query

The result query begins from the viewer's accepted directional edges and joins the reverse accepted edge before touching current
presence. It then requires the sharer's enabled policy, current device generation, `expires_at > database_now`, and inclusive
`ST_DWithin` on `geography(Point, 4326)` with spheroid measurement.

The GiST index is candidate acceleration only. `ST_DWithin` is the exact inclusion predicate; rounded millimeter distance followed
by account UUID is the total order. At `maxResults + 1`, the service raises a density error rather than truncating silently.

## Redis wake/outbox path

Each session event creates an outbox row. A worker claims one row with a lease and `SKIP LOCKED`, publishes the generic upper
sequence, then marks the row sent.

- Crash before publish: the lease expires and another worker retries.
- Crash after publish: another worker may publish the same hint again.
- Subscriber disconnected: Redis reports zero local subscribers and the hint is gone.
- Any of the above: the session cursor still reads the committed database event and current view.

Event retention also trims old non-claimed wake rows. A claimed old row can finish once; it cannot authorize a result, and a cursor
below the retained boundary must resnapshot.

## Scaling path not implemented

A production design would have to replace the global revision lock with partition ownership and a documented cross-partition
authorization/event protocol; bound high-degree fanout; define session placement and takeover; test Redis Cluster/sharded Pub/Sub;
and add multi-region failover, backup, erasure, abuse, and incident controls. None is inferred from the single-node lab.
