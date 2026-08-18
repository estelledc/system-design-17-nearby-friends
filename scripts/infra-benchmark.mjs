import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createClient } from 'redis';
import { ownerFingerprint } from '../src/crypto.js';
import {
  initializeDatabase,
  NearbyRepository,
  resetDatabase,
} from '../src/repository.js';
import { NearbyService } from '../src/service.js';
import { WakeWorker } from '../src/wake-worker.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for the infrastructure benchmark');
assert.ok(redisUrl, 'REDIS_URL is required for the infrastructure benchmark');

const pairCount = 20;
const updatesPerSharer = 8;
const authSecret = 'benchmark-auth-secret-that-has-32-bytes';
const pool = new Pool({ connectionString: databaseUrl, max: 32 });
const redis = createClient({ url: redisUrl });
redis.on('error', () => {});
await redis.connect();
await initializeDatabase(pool);
await resetDatabase(pool, 'nearby-presence-lab-reset');
const repository = new NearbyRepository(pool);
const service = new NearbyService(repository, {
  cursorSecret: 'benchmark-cursor-secret-with-32-bytes',
  wakeChannelSecret: 'benchmark-wake-secret-that-has-32-bytes',
});

function actor(label) {
  return {
    label,
    owner: ownerFingerprint(`benchmark-token-${label}-000001`, authSecret),
    counter: 0,
  };
}

function key(subject, operation) {
  subject.counter += 1;
  return `${subject.label}:${operation}:${subject.counter}`;
}

async function register(subject) {
  const response = await service.createAccount({
    owner: subject.owner, requestKey: key(subject, 'account'), body: {},
  });
  subject.accountId = response.body.accountId;
  subject.policyEtag = response.body.policy.etag;
}

async function setupPair(index) {
  const viewer = actor(`viewer-${index}`);
  const sharer = actor(`sharer-${index}`);
  await register(viewer);
  await register(sharer);
  const policy = await service.setSharingPolicy({
    owner: sharer.owner,
    requestKey: key(sharer, 'policy'),
    ifMatch: sharer.policyEtag,
    body: { enabled: true },
  });
  sharer.policyEtag = policy.etag;
  const device = await service.rotateDeviceGeneration({
    owner: sharer.owner,
    requestKey: key(sharer, 'device'),
    ifMatch: '*',
    body: {},
  });
  sharer.deviceEtag = device.etag;
  await service.setRelationship({
    owner: viewer.owner,
    requestKey: key(viewer, 'edge'),
    ifMatch: '*',
    otherAccountId: sharer.accountId,
    body: { state: 'accepted' },
  });
  await service.setRelationship({
    owner: sharer.owner,
    requestKey: key(sharer, 'edge'),
    ifMatch: '*',
    otherAccountId: viewer.accountId,
    body: { state: 'accepted' },
  });
  const baseLatitude = -40 + index * 0.5;
  await service.updateLocation({
    owner: sharer.owner,
    requestKey: key(sharer, 'location'),
    ifMatch: sharer.deviceEtag,
    body: {
      sequence: 1,
      latitude: baseLatitude,
      longitude: 10.001,
      ttlSeconds: 600,
    },
  });
  const snapshot = await service.createNearbySession({
    owner: viewer.owner,
    requestKey: key(viewer, 'session'),
    body: {
      latitude: baseLatitude,
      longitude: 10,
      radiusMeters: 1_000,
      maxResults: 10,
    },
  });
  assert.equal(snapshot.body.items.length, 1);
  return { viewer, sharer, snapshot, baseLatitude };
}

const seedStarted = performance.now();
const pairs = [];
for (let index = 0; index < pairCount; index += 1) pairs.push(await setupPair(index));
const seedMs = performance.now() - seedStarted;

const updateLatencies = [];
const updateStarted = performance.now();
for (let sequence = 2; sequence <= updatesPerSharer + 1; sequence += 1) {
  for (const pair of pairs) {
    const started = performance.now();
    await service.updateLocation({
      owner: pair.sharer.owner,
      requestKey: key(pair.sharer, 'location'),
      ifMatch: pair.sharer.deviceEtag,
      body: {
        sequence,
        latitude: pair.baseLatitude,
        longitude: 10.001 + sequence / 100_000,
        ttlSeconds: 600,
      },
    });
    updateLatencies.push(performance.now() - started);
  }
}
const updateMs = performance.now() - updateStarted;

const worker = new WakeWorker({ repository, redis });
const wakeStarted = performance.now();
const wakes = [];
for (;;) {
  const batch = await worker.runBatch();
  wakes.push(...batch);
  if (batch.length < 100) break;
}
const wakeMs = performance.now() - wakeStarted;
assert.equal(wakes.length, pairCount * updatesPerSharer);
assert.ok(wakes.every((wake) => wake.subscriberCount === 0));

const drainLatencies = [];
let drainedEvents = 0;
let drainedResults = 0;
const drainStarted = performance.now();
for (const pair of pairs) {
  const started = performance.now();
  const drained = await service.drainNearbySession({
    owner: pair.viewer.owner,
    sessionId: pair.snapshot.body.sessionId,
    cursor: pair.snapshot.body.eventCursor,
  });
  drainLatencies.push(performance.now() - started);
  drainedEvents += drained.body.events.length;
  drainedResults += drained.body.items.length;
}
const drainMs = performance.now() - drainStarted;
assert.equal(drainedEvents, pairCount * updatesPerSharer);
assert.equal(drainedResults, pairCount);

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function latencySummary(values) {
  return {
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

const state = await pool.query(`SELECT
  (SELECT committed_revision::int FROM system_state WHERE singleton) AS revision,
  (SELECT count(*)::int FROM accounts) AS accounts,
  (SELECT count(*)::int FROM presences) AS presences,
  (SELECT count(*)::int FROM nearby_sessions) AS sessions,
  (SELECT count(*)::int FROM nearby_session_events) AS events,
  (SELECT count(*)::int FROM wake_outbox WHERE state = 'sent') AS sent_wakes`);
assert.deepEqual(state.rows[0], {
  revision: 300,
  accounts: 40,
  presences: 20,
  sessions: 20,
  events: 160,
  sent_wakes: 160,
});
const postgresVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
const postgisVersion = (await pool.query('SELECT postgis_lib_version() AS version')).rows[0].version;
const redisInfo = await redis.info('server');
const redisVersion = /^redis_version:(.+)$/m.exec(redisInfo)?.[1]?.trim();

await redis.quit();
await pool.end();
process.stdout.write(`${JSON.stringify({
  evidence: 'bounded_synthetic_benchmark',
  scope: 'single_process_single_region_no_subscribers_no_network_clients',
  runtime: process.version,
  postgresVersion,
  postgisVersion,
  redisVersion,
  fixture: {
    pairCount,
    updatesPerSharer,
    measuredUpdates: updateLatencies.length,
    wakePublishes: wakes.length,
    drains: drainLatencies.length,
    drainedEvents,
    drainedResults,
  },
  seedMs: Number(seedMs.toFixed(3)),
  updates: {
    elapsedMs: Number(updateMs.toFixed(3)),
    operationsPerSecond: Number((updateLatencies.length * 1000 / updateMs).toFixed(3)),
    ...latencySummary(updateLatencies),
  },
  wakePublishes: {
    elapsedMs: Number(wakeMs.toFixed(3)),
    operationsPerSecond: Number((wakes.length * 1000 / wakeMs).toFixed(3)),
  },
  drains: {
    elapsedMs: Number(drainMs.toFixed(3)),
    operationsPerSecond: Number((drainLatencies.length * 1000 / drainMs).toFixed(3)),
    ...latencySummary(drainLatencies),
  },
  finalState: state.rows[0],
  extrapolatedCapacityClaims: 0,
})}\n`);
