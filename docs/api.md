# HTTP API

## Common contract

- All routes except `GET /healthz` require `Authorization: Bearer <8–256 visible ASCII bytes>`.
- Mutation/session creation routes require a portable 1–128 character `Idempotency-Key`.
- JSON bodies must use `Content-Type: application/json`, be at most 16 KiB, contain exactly the documented fields, and use named
  coordinates. Unknown fields fail.
- Every response is JSON with `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`.
- Versioned writes require exactly one strong `If-Match`. `*` is allowed only when creating a missing relationship edge or the
  first device generation.
- A successful server response proves only that the server wrote response bytes. It does not prove remote receipt, display, or a
  real-world outcome.

## Routes

### `POST /v1/accounts`

Headers: `Idempotency-Key`. Body: `{}`.

Creates one account for the authenticated owner and an initially disabled sharing policy. Returns `201` on first commit and `200`
on exact replay. The response `ETag` is the account version; `body.policy.etag` is the separate policy precondition.

### `PUT /v1/relationships/{otherAccountId}`

Headers: `Idempotency-Key`, `If-Match: *` for first edge or `If-Match: "re:<version UUID>"` for replacement.

```json
{"state":"accepted"}
```

`state` is exactly `accepted`, `revoked`, or `blocked`. The authenticated owner controls only its directional edge. Visibility
requires the reverse edge to be accepted independently.

### `PUT /v1/sharing-policy`

Headers: `Idempotency-Key`, `If-Match: "sp:<version UUID>"`.

```json
{"enabled":true}
```

Disabling deletes current presence and commits refresh events for current mutual-friend sessions in the same transaction.

### `POST /v1/device-generations`

Headers: `Idempotency-Key`, `If-Match: *` for the first generation or `If-Match: "dg:<generation UUID>"` for rotation. Body: `{}`.

Rotation deletes current presence and returns a new generation whose `nextSequence` is one.

### `PUT /v1/location`

Headers: `Idempotency-Key`, `If-Match: "dg:<current generation UUID>"`.

```json
{"sequence":1,"latitude":37.77,"longitude":-122.42,"ttlSeconds":60}
```

Sequence must be exactly current + 1. Server time defines `acceptedAt` and `expiresAt`; replaying the same key and intent returns
the original epoch/times. Longitude `+180` canonicalizes to `-180`. No client capture time or history is accepted.

### `POST /v1/nearby-sessions`

Headers: `Idempotency-Key`.

```json
{"latitude":37.77,"longitude":-122.42,"radiusMeters":8000,"maxResults":50}
```

Returns `201` on first creation and `200` when the stable key reopens the same session. The session identity and query remain
stable, but replayed result rows are reauthorized at `viewRevision` and the cursor advances to that current boundary; old precise
rows are never mechanically replayed after revocation or expiry. The body also contains `initialRevision`, expiry, exact authorized
items, and `replayed`. The Redis wake channel is internal and is never returned.

### `GET /v1/nearby-sessions/{sessionId}/events?cursor=<opaque>`

Accepts exactly one cursor parameter. The cursor is signed, owner-bound, session-bound, and sequence-bound. The response contains
generic events, `replaceWholeView: true`, a freshly authorized full item list, `refreshBy`, and the next cursor.

## Error model

```json
{"error":{"code":"sequence_conflict","message":"...","details":{"expectedSequence":2}}}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | malformed auth-adjacent input, body, identifier, ETag, coordinate, bound, or cursor |
| 401 | `unauthorized` | bearer syntax is missing or invalid |
| 404 | `not_found` | route/resource is absent or not owned by the caller |
| 409 | `intent_conflict` | one stable key was reused for changed intent |
| 409 | `stale_device_generation`, `sequence_conflict`, `sharing_disabled` | current write fence rejects the update |
| 409 | `resync_required` | cursor fell below retained contiguous history |
| 410 | `gone` | the nearby session expired |
| 412 | `precondition_failed` | relationship/policy/device version is stale; current ETag is returned when available |
| 422 | `density_limit_exceeded` | exact authorized rows exceed the declared result cap |
| 503 | `fanout_limit_exceeded` | affected active sessions exceed the atomic fanout bound |

Ordinary logs include route operation, status, elapsed time, bounded counts, and evidence labels. They omit bearer/fingerprint,
account/device/session/location IDs, relationship edges, coordinates, request keys/digests, cursor/channel, and result bodies.
