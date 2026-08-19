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

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the four commits in order: `1074341518af5de0f85e6b9125fd2f04550c2aaf` → `4445d8181de0d74c38c2ca5b82ede5e126084a11`, `27439b6694fc4e788acb4ba71bc3fd66325e7de9` → `f2cd902ba3f51604353631d35417943d2b5c8c13`, `3334ea38358187a4b7d0eb776f37243a3aa5f5f2` → `be23aa964ae7902aedde9201de3de78fa78004d4`, and `51701856201e630d43a7c86d743056e4229bf6c4` → `46c16efaeb530d67aceb1c517355dbd8867cb7fe`.

Implementation commit: `be23aa964ae7902aedde9201de3de78fa78004d4`.

Historical pre-rewrite public run: [32186626058](https://github.com/estelledc/system-design-17-nearby-friends/actions/runs/32186626058), completed successfully on 2026-08-18 UTC. It remains bound to the old commit object but tested the identical tree.

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline `46c16efaeb530d67aceb1c517355dbd8867cb7fe` passed [CI run 32226759810](https://github.com/estelledc/system-design-17-nearby-friends/actions/runs/32226759810) on Node 22, 24, and 26 with PostgreSQL 17 / PostGIS 3.5 / Redis 7.4 and the full quality gate.

Every Node job reported:

- repository policy/syntax/link gate over 40 files;
- 19/19 pure tests, zero fail/skip;
- high-severity dependency audit with zero vulnerabilities;
- 10/10 real infrastructure tests, zero fail/skip;
- PostgreSQL 17.11, PostGIS 3.5.7, and Redis 7.4.10;
- a true-process smoke with committed location response loss recovered, duplicate publish-before-mark wake observed, missed
  zero-subscriber wake recovered by cursor, final revision 9, two sent wake rows, and maximum publish attempts 2;
- zero remote-device, map, co-presence, meeting, safety, consent, or external-acceptance claims.

## Bounded benchmark observations

The exact fixture was 20 isolated viewer/sharer pairs, one active session per pair, eight measured location updates per sharer,
160 no-subscriber Redis wake publishes, and one final drain per viewer. It used one API process path, one PostgreSQL instance, one
Redis instance, no network clients, no subscribers, no concurrency/load generator, and no production extrapolation.

| Runtime | Seed ms | Update ops/s | Update p50/p95/max ms | Wake publishes/s | Drain ops/s | Drain p50/p95/max ms |
|---|---:|---:|---:|---:|---:|---:|
| Node 22.23.2 | 681.697 | 146.245 | 6.569 / 9.202 / 12.866 | 423.695 | 216.576 | 3.987 / 9.053 / 10.083 |
| Node 24.19.0 | 721.687 | 125.590 | 7.693 / 11.057 / 15.261 | 343.274 | 215.203 | 4.500 / 5.365 / 5.662 |
| Node 26.7.0 | 2376.914 | 43.417 | 6.619 / 134.003 / 247.330 | 70.627 | 289.330 | 3.407 / 3.715 / 4.481 |

Each run ended with revision 300, 40 accounts, 20 current presences, 20 sessions, 160 retained events, 160 sent wake rows, 160
drained events, and 20 current results. The Node 26 tail is a runner observation, not a language-version or capacity conclusion;
the benchmark has neither repetitions nor controlled machine isolation needed for that inference.
