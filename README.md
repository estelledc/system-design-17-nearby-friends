# Authorized Nearby Presence Lab

This clean-room system-design practice starts with one question: when a friend changes sharing policy, blocks someone, moves,
disconnects, or retries an update while a nearby view is live, how can the server avoid disclosing an unauthorized or stale
location and still give the viewer a gap-detectable stream?

The prompt title is commonly framed as “design a nearby friends system.” This repository does not copy a product, source chapter,
dataset, social graph, map, diagram, location trace, or proprietary behavior. The problem contract is frozen before consulting the
fixed secondary chapter.

## What is implemented

- PostgreSQL 17/PostGIS 3.5 authority for accounts, directional relationships, sharing policy, current device
  generation/sequence, expiring presence, durable mutation receipts, nearby snapshots/events, and an outbox;
- exact mutual authorization and spheroid radius filtering with deterministic distance/account ordering;
- signed owner/session cursor, bounded replace-whole refresh, and explicit `resync_required` after a retention gap;
- Redis 7.4 Pub/Sub carrying only optional opaque `{version, upperSequence}` wake hints;
- true-process hooks for location-commit/response-loss and Redis-publish/outbox-mark crash windows;
- pure, real-infrastructure, smoke, benchmark, repository-policy, dependency-audit, and Node 22/24/26 CI gates.

The first public CI receipt is pending. Until that run is green, the code and test design are implemented but the real service
claims remain unverified.

## Read the system

- Problem and invariants: [docs/closed-book-contract.md](docs/closed-book-contract.md)
- Fixed-source comparison and primary corrections: [docs/research-log.md](docs/research-log.md)
- Runnable requirements: [docs/requirements.md](docs/requirements.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- HTTP contract: [docs/api.md](docs/api.md)
- Decision record: [ADR 0001](docs/adr/0001-postgres-authority-and-lossy-redis-wakeups.md)
- Operations and failures: [docs/operations.md](docs/operations.md)
- Threat model: [docs/threat-model.md](docs/threat-model.md)
- Verification evidence: [docs/verification.md](docs/verification.md)

## Run the gates

```sh
npm ci --ignore-scripts
npm run check
DATABASE_URL=... REDIS_URL=... npm run test:infra
DATABASE_URL=... REDIS_URL=... npm run smoke:infra
DATABASE_URL=... REDIS_URL=... npm run benchmark:infra
```

`compose.yaml` describes digest-pinned PostgreSQL/PostGIS and Redis service images. See
[docs/operations.md](docs/operations.md) for API/worker variables and failure interpretation.

## Evidence boundary

Once its matching gates are green, this vertical slice may prove server-side friendship/policy authorization, location freshness
and version binding, exact synthetic radius inclusion, bounded fanout, restart/retry behavior, and a gap-detectable server event
stream for the recorded commit. It must not call those facts device receipt, background-location permission, GPS accuracy, map
rendering, physical co-presence, personal safety, meeting, navigation, consent validity in the real world, production privacy
compliance, deployment, or external acceptance.

## License

MIT. Third-party study material is not included.
