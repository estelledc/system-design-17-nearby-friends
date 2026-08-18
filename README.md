# Authorized Nearby Presence Lab

This clean-room system-design practice starts with one question: when a friend changes sharing policy, blocks someone, moves,
disconnects, or retries an update while a nearby view is live, how can the server avoid disclosing an unauthorized or stale
location and still give the viewer a gap-detectable stream?

The prompt title is commonly framed as “design a nearby friends system.” This repository does not copy a product, source chapter,
dataset, social graph, map, diagram, location trace, or proprietary behavior. The problem contract is frozen before consulting the
fixed secondary chapter.

## Current phase

- Closed-book problem contract: [docs/closed-book-contract.md](docs/closed-book-contract.md)
- Fixed-source comparison: [docs/research-log.md](docs/research-log.md)
- Architecture decision: [ADR 0001](docs/adr/0001-postgres-authority-and-lossy-redis-wakeups.md)
- Implementation and public CI: pending

## Evidence boundary

The intended vertical slice may prove server-side friendship/policy authorization, location freshness and version binding, exact
synthetic radius inclusion, bounded fanout, restart/retry behavior, and a gap-detectable server event stream. It must not call
those facts device receipt, background-location permission, GPS accuracy, map rendering, physical co-presence, personal safety,
meeting, navigation, consent validity in the real world, production privacy compliance, or external acceptance.

## License

MIT. Third-party study material is not included.
