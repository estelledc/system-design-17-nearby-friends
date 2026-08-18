# Closed-book contract: authorized nearby presence

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. The title identifies
only a problem family. Product behavior, scale, API, location cadence, spatial partitioning, push transport, privacy semantics, and
consistency are hypotheses for this lab—not facts about any named social or map product. Later research must record confirmations,
conflicts, omissions, and changes instead of silently rewriting this baseline.

## Users and core behavior

### Location sharer

1. An authenticated account explicitly enables a bounded sharing policy and publishes synthetic device-location updates.
2. Exact replay of one accepted update converges without creating a newer presence epoch. Reusing its identity for changed
   coordinates, device generation, or capture intent conflicts.
3. A stale device sequence, expired device generation, disabled sharing, relationship revocation, or block cannot resurrect an old
   visible location.
4. Disabling sharing or blocking a viewer has a documented server-side cutover. Bytes already generated before that commit are a
   different failure window and cannot be retroactively recalled.

### Nearby viewer

1. An authenticated viewer requests accepted friends within a bounded radius around one valid synthetic location.
2. Every returned row must pass both current authorization and exact distance/freshness checks for one coherent server view.
3. A live subscription begins from an explicit snapshot/watermark and applies ordered deltas. A gap, expiry, policy epoch mismatch,
   or lost retention forces a resnapshot rather than silently showing a hybrid view.
4. A server result proves only that the service computed/produced a response. It does not prove the viewer's device received or
   rendered it, either person is physically at the reported coordinates, a meeting is safe, or anyone consented outside the
   modeled server policy.

### Service/privacy operator

1. An operator can distinguish relationship-policy commit, accepted location update, spatial-index visibility, nearby response,
   stream bytes, device receipt, and real-world outcome.
2. Authorization and index state can be audited against a direct fixed-revision oracle without exposing raw people, relationships,
   coordinates, device IDs, update keys, subscription tokens, or result bodies in ordinary logs/metrics.
3. Dense graph/cell fanout, stale presence, replay storms, and slow subscriptions have explicit bounds and visible failure modes.

## Non-goals for v0.1

- real people, contacts, social accounts, devices, identifiers, GPS traces, addresses, homes/workplaces, maps, or routes;
- friend discovery, contact upload, suggestions, invitations, messaging, groups, events, check-ins, or public broadcasting;
- background mobile permissions, battery/radio policy, sensor fusion, GPS/Wi-Fi/cell accuracy, spoof detection, or attestation;
- road/travel distance, geocoding, map tiles, navigation, traffic, estimated arrival, or physical safety decisions;
- fuzzy distance labels, personalized ranking, popularity, ads, recommendations, or “people you may know”;
- proof of informed consent, age controls, guardian controls, stalking/abuse intervention, law-enforcement process, or regulatory
  compliance;
- full identity provider, relationship moderation, account recovery, credential revocation, audit-console access, or data-subject
  workflows;
- global active-active ownership, multi-region failover, disaster recovery, backup/restore, production deployment, SLA, or capacity;
- proving remote receipt/rendering, physical co-presence, a meetup, safety, satisfaction, or external acceptance.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- 20 million concurrently sharing accounts, one accepted location update every 15 seconds: about 1.33 million updates/s average;
- five nearby refreshes per active account per minute: about 1.67 million queries/s average;
- 10× regional/clock-aligned peak as a design input, not an achievable claim;
- 200 accepted friendships/account on average, with a deliberately modeled 20,000-friend hard case;
- 128 bytes/current presence gives about 2.56 GiB for 20 million current rows before indexes/replicas/allocator overhead;
- 64 bytes × 115.2 billion updates/day would exceed 7 TiB/day before replication if every update were retained, so v0.1 must not
  accidentally turn ephemeral presence into unbounded history;
- supported radius 100 m–50 km, at most 500 authorized exact results, and a bounded subscription buffer/retention window.

The runnable lab will use small synthetic graphs/coordinates and report raw benchmark fixtures without extrapolation.

## Candidate state model

Relationship/policy state:

```text
absent -> pending -> accepted -> revoked
                    |       \
                    |        -> blocked
                    -> blocked

sharing_disabled -> sharing_enabled(policy_epoch) -> sharing_disabled(new epoch)
```

Device/location state:

```text
device_generation_created
  -> sequence N accepted -> sequence N replayed
  -> sequence N+1 accepted
  -> generation revoked (no later write from that generation)

no_presence -> fresh(location_epoch, expires_at) -> expired
            -> fresh(newer epoch)
```

Viewer stream state:

```text
opening -> snapshot(watermark) -> live(next_sequence)
                              -> resync_required (gap / retention / policy mismatch / overflow)
                              -> closed
```

The exact authority, durable/transient split, and index publication protocol remain undecided until source and primary-spec review.

## Core invariants

1. **Coordinate/time domain.** Latitude, longitude, radius, captured time, TTL, sequence, graph/policy generation, page/buffer
   limits, and tokens use one canonical bounded domain. NaN/infinity, ambiguous longitude wrapping, client time outside an allowed
   skew window, and unknown fields fail before graph/index work.
2. **Explicit visibility authorization.** A result is eligible only if the relationship is accepted, the sharer's current policy
   allows this viewer, neither side's effective block/revocation denies it, and the location remains fresh. “Friend ID exists in a
   spatial cell” is never sufficient authorization.
3. **Revocation cutover.** After a block, friendship revocation, or sharing-disable commit, no newly generated response/delta may
   disclose that sharer's location to the affected viewer. Pre-commit in-flight bytes are separately measured and not mislabeled.
4. **Stable update intent.** `(account, device generation, update ID/sequence)` binds immutable coordinates, capture intent, and
   expiry semantics. Exact replay returns the original accepted result; changed intent conflicts.
5. **No stale resurrection.** Older device sequence, expired/revoked generation, delayed retry, reordered queue item, or failover
   replay cannot replace a newer presence or make an expired/disabled account visible again.
6. **Defined multi-device winner.** If several authorized devices publish for one account, one explicit ordering/merge policy
   selects the account presence. Untrusted client wall time alone cannot silently override server fencing/generation state.
7. **Index/version coherence.** Spatial membership, coordinates, freshness, account-location epoch, and effective authorization
   version used for a result refer to the same accepted state or fail closed. Old cell/new coordinates and new cell/old policy are
   forbidden mixed joins.
8. **Exact final predicate.** Cells/prefixes/boxes may only generate candidates. One documented Earth model and inclusive
   `distance <= radius` rule decides the result, including supported boundary, antimeridian, and polar cases.
9. **Deterministic bounded result.** Exact/quantized distance plus stable synthetic account ID gives a total order. Candidate count,
   relationship fanout, exact-distance work, result count, page size, subscription buffer, token size, and retries are bounded;
   overload never silently claims a complete list.
10. **Gap-detectable stream.** Snapshot watermark and ordered delta sequence share one authority. Duplicates are idempotent; a gap,
    retention miss, policy epoch mismatch, or overflow yields `resync_required`, never an apparently current hybrid view.
11. **Freshness is server-verifiable.** Expiry is enforced at query/delivery time, not only by best-effort cleanup. A stopped client
    eventually disappears without a final “offline” message.
12. **Location privacy in evidence.** Raw coordinates, relationship edges, account/device/update identities, auth/idempotency keys,
    query digests, tokens, and result bodies do not enter ordinary logs or metric labels. Pseudonyms and hashes are not anonymity.
13. **Evidence separation.** `relationship_policy_committed`, `location_update_accepted`, `presence_index_visible`,
    `nearby_response`, and `server_stream_bytes_written` are distinct. None implies device receipt, background permission, GPS
    truth, map rendering, physical proximity, meeting, safety, consent validity, satisfaction, or production acceptance.

## Initial API/event sketch

Authenticated synthetic relationship/policy routes:

- `PUT /v1/relationships/{friendId}` with stable key, expected relationship generation, and `accepted|revoked|blocked`;
- `PUT /v1/sharing-policy` with stable key, expected policy epoch, enabled flag, and bounded audience rule;
- `POST /v1/devices/{deviceId}/generations` and generation revoke, or a smaller explicit device-fencing contract.

Authenticated presence routes:

- `PUT /v1/devices/{deviceId}/location` with stable update ID, device generation, monotonic sequence, captured time, named
  latitude/longitude, and bounded TTL;
- `DELETE /v1/presence` to disable/expire current account presence through a versioned policy rather than best-effort cell delete;
- `POST /v1/nearby-sessions` with viewer coordinates, radius, limit, and optional initial subscription intent;
- `GET /v1/nearby-sessions/{id}/events?after=<sequence>` or an SSE/WebSocket equivalent with explicit snapshot/delta/resync
  envelopes.

Exact fields, transport, history retention, clock model, graph ownership, spatial index, database/cache choice, and live-stream
protocol remain hypotheses until primary specifications are reviewed. Tokens are opaque externally.

## Failure matrix

| Failure window | Required result |
|---|---|
| two exact location updates race under one identity | one accepted epoch/result; exact retry converges; changed coordinates conflict |
| sequence N+1 commits before delayed N arrives | N cannot replace N+1 or extend its visibility |
| device generation is revoked while an update is queued | queued old-generation update fails closed and cannot resurrect presence |
| account A and B devices race | documented account-level winner/merge; no client-time-only ambiguity |
| location state writes but spatial membership does not | neither mixed state is served, or publication remains on prior coherent epoch |
| friend moves across a cell boundary | every authorized exact in-radius friend remains a candidate; old membership does not duplicate |
| viewer query crosses ±180° | opposite-side authorized friend is not omitted |
| location expires without a disconnect event | query/stream stops disclosing it at the defined server-time boundary |
| block/revoke commits during a nearby query | post-commit generation fails authorization; pre-commit response window is separately labeled |
| block/revoke commits after snapshot but before delta | stream removes/fails closed under policy sequence, or forces resnapshot; it cannot continue disclosing |
| snapshot is created while updates occur | watermark plus ordered deltas produces one gapless model or explicit resync |
| subscriber loses/duplicates/reorders events | duplicates are harmless; gaps/reordering are detected before “current” state is claimed |
| subscriber is slow or disconnected past retention | bounded buffer closes with `resync_required`; no unbounded per-viewer queue |
| dense cell or 20,000-friend account exceeds work budget | explicit overload/refinement/resync behavior; no silent partial completeness claim |
| update/stream response is lost after commit/write | durable state replays exactly; server write still does not prove device receipt |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API/events, operations, threat model, and at least one ADR.
2. Exact coordinate/time/sequence/policy/token validation plus deterministic authorization/distance/order unit tests.
3. Generated model/property tests comparing the chosen index/stream state with a direct graph + brute-force distance oracle across
   random friendship/block/policy/location events, expiry, cell edges, antimeridian, ties, duplicates, and reorderings.
4. Real infrastructure tests for update idempotency, generation fencing, relationship/policy revocation, atomic index/version joins,
   expiry-at-read, snapshot/delta continuity, buffer overflow/resync, and concurrent query/revocation boundaries.
5. A true-process crash/restart smoke covering accepted-location or policy response loss and stream snapshot/delta recovery.
6. A bounded benchmark with exact graph/location distribution, update/query/subscription mix, density, runtime/service versions,
   exclusions, and raw observations—without production extrapolation.
7. Node 22/24/26 public CI with pinned actions, dependency audit, zero skipped infrastructure tests, and exact commit/run receipts.
8. Log/evidence-vocabulary scans that reject synthetic private values and any claim of device receipt, physical co-presence, meeting,
   safety, consent validity, or human outcome.

## Initial design choices to challenge after source review

- Is “nearby” a one-shot pull, periodic refresh, or a live delta stream, and where is the snapshot/delta join?
- Is candidate generation friend-first then distance, spatial-first then graph authorization, or an intersection with a bounded
  cost proof? Which side prevents disclosure before fetching location details?
- Does a geohash/grid/quadtree/cache have a global covering and exact-filter contract, or is same-cell membership mistaken for
  proximity?
- What commits atomically when a device moves, expires, disconnects, rotates generation, or retries after response loss?
- Can block/revoke/sharing-disable invalidate cached location, cell membership, subscription state, and already queued deltas under
  one observable version boundary?
- How are multi-device sequence, client clock skew, server receive order, TTL, late queues, and reconnect reconciled?
- Does a push channel provide ordering/replay/retention, or is it only a lossy wakeup hint requiring an authoritative cursor?
- Which scale, update interval, freshness, product, latency, and battery figures are cited, reproducible, or silently assumed?

Implementation remains pending until this baseline is committed, the fixed source is inspected, primary specifications are
verified, and the smallest executable invariant is selected.
