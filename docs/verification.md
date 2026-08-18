# Verification record

## Gate design

| Gate | What it can prove | What it cannot prove |
|---|---|---|
| pure unit tests | exact input/ETag/digest/cursor/HTTP/worker behavior without services | PostgreSQL isolation, PostGIS geometry, Redis delivery, process crashes |
| PostgreSQL/PostGIS integration | real constraints, transactions, geography predicates, revision/event order, rollback | production topology, replication/failover, GPS or map truth |
| Redis integration | real Pub/Sub duplicate/missed hint behavior on one Redis 7.4 node | cluster/sharded Pub/Sub, network partitions, device receipt |
| true-process smoke | SIGKILL response-loss and publish-before-mark recovery with durable readback | OS/power loss durability, remote client apply, external acceptance |
| bounded benchmark | raw observations for one declared synthetic fixture/runtime | production capacity, SLA, cost, regional or high-degree behavior |
| public matrix CI | reproducibility on Node 22/24/26 and pinned service images | deployment, merge, release, or production review |

## Required assertions

The final public run must have zero skips and demonstrate:

- mutual authorization and exact antimeridian-aware PostGIS distance with deterministic ties;
- 16 concurrent exact retries converging to one location epoch and one durable receipt;
- old-generation, duplicate-sequence, changed-intent, disabled-policy, density, and fanout failures;
- disable/re-enable without stale resurrection, privacy-safe session retry after revocation, and query-time expiry without a cleanup
  signal;
- contiguous retained event drain, explicit retention-gap resync, and coherent concurrent revoke/drain outcome;
- duplicate Redis wake after publish-before-mark failure, zero-subscriber loss, and complete database-cursor recovery;
- true API SIGKILL after committed location/receipt but before response, followed by exact replay;
- ordinary child-process logs containing none of the synthetic tokens, fingerprints, IDs, channel, request key, coordinates, or
  prohibited remote/human outcome labels;
- dependency audit with zero high-severity findings.

## Public receipts

Pending the first public CI run. Commit hashes, run IDs, exact test counts, service versions, smoke state, and per-runtime benchmark
observations will be recorded here only after GitHub reports the immutable run result.
