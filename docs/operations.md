# Operations

## Local commands

Node 22 or newer, PostgreSQL 17 with PostGIS 3.5, and Redis 7.4 are required for the full gates.

```sh
npm ci --ignore-scripts
npm run check
npm run test:infra
npm run smoke:infra
npm run benchmark:infra
```

`npm run check` is pure and does not need services. The other commands require `DATABASE_URL` and `REDIS_URL`. `compose.yaml`
describes the same digest-pinned service images used by public CI; it is a convenience, not deployment configuration.

Run the API with:

```sh
DATABASE_URL=... \
AUTH_FINGERPRINT_SECRET=... \
CURSOR_SECRET=... \
WAKE_CHANNEL_SECRET=... \
npm start
```

Run the wake worker with `DATABASE_URL`, `REDIS_URL`, and `npm run worker`. Each HMAC secret must contain at least 32 bytes and must
be distinct in a real deployment. The repository includes no credential.

## Healthy evidence

- API readiness: one generic `server_ready` record and `GET /healthz` returns `200`.
- Worker readiness: one generic `worker_ready` record.
- Database: system revision advances once per applied mutation; each exact retry returns the stored revision/epoch.
- Session: event sequences are contiguous from `retained_from_sequence` through `last_event_sequence`.
- Outbox: `pending`/expired `claimed` rows indicate wake latency backlog; `sent` means Redis `PUBLISH` returned, not that a remote
  client received anything.
- Freshness: every nearby query applies `expires_at > database clock`; no cleanup job or Redis expiration event is required for
  correctness.

## Failure handling

| Observation | Safe interpretation | Action |
|---|---|---|
| API dies after location commit | response outcome is unknown to caller | retry the identical key/body/generation; changed intent must conflict |
| worker dies after publish | hint may have reached zero or more broker-local subscribers | let the lease expire; retry may duplicate; consumers drain cursor idempotently |
| Redis unavailable | database mutation/event may still be committed | restore Redis, process outbox; consumers poll/reconnect and drain PostgreSQL cursor |
| cursor below retention | intermediate refresh hints are no longer reconstructable | create a new nearby session; never guess current state |
| fanout limit | entire mutation rolled back | reduce active-session fanout or redesign partition/coalescing; do not manually advance sequence |
| density limit | exact result set is larger than declared bound | narrow radius or explicitly raise the bounded result contract |
| session expires | center, snapshot, event, and wake state are no longer usable | create a new session after reauthentication |

## Cleanup and retention limits

The lab retains at most 32 durable events and non-claimed wake rows per active session as new events arrive. Session rows are
cascade owners for events/outbox, but v0.1 does not implement a production expiry sweeper, archival audit, backup, erasure,
or legal hold. Running `resetDatabase` is restricted to the explicit synthetic-lab confirmation used by tests and benchmarks.

## Release boundary

Green CI proves the exact single-node synthetic gates on the recorded commit. It does not prove a deployed service, WebSocket
fleet, Redis Cluster, failover, backup restore, mobile behavior, user acceptance, safety review, compliance review, or production
capacity.
