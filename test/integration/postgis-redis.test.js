import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { createClient } from 'redis';
import { encodeCursor, ownerFingerprint } from '../../src/crypto.js';
import {
  initializeDatabase,
  NearbyRepository,
  resetDatabase,
} from '../../src/repository.js';
import { NearbyService } from '../../src/service.js';
import { WakeWorker } from '../../src/wake-worker.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for infrastructure tests');
assert.ok(redisUrl, 'REDIS_URL is required for infrastructure tests');

const authSecret = 'integration-auth-secret-that-has-32-bytes';
const cursorSecret = 'integration-cursor-secret-with-32-bytes';
const wakeSecret = 'integration-wake-secret-that-has-32-bytes';

let pool;
let redis;
let repository;
let service;

function stack(options = {}) {
  repository = new NearbyRepository(pool, options);
  service = new NearbyService(repository, {
    cursorSecret,
    wakeChannelSecret: wakeSecret,
  });
}

function actor(label) {
  const token = `synthetic-token-${label}-00000001`;
  return {
    label,
    token,
    owner: ownerFingerprint(token, authSecret),
    counter: 0,
    edges: new Map(),
  };
}

function key(subject, operation) {
  subject.counter += 1;
  return `${subject.label}:${operation}:${subject.counter}`;
}

async function register(subject) {
  const response = await service.createAccount({
    owner: subject.owner,
    requestKey: key(subject, 'account'),
    body: {},
  });
  subject.accountId = response.body.accountId;
  subject.policyEtag = response.body.policy.etag;
  return subject;
}

async function policy(subject, enabled, requestKey = key(subject, 'policy')) {
  const response = await service.setSharingPolicy({
    owner: subject.owner,
    requestKey,
    ifMatch: subject.policyEtag,
    body: { enabled },
  });
  subject.policyEtag = response.etag;
  return response.body;
}

async function rotate(subject, requestKey = key(subject, 'device')) {
  const response = await service.rotateDeviceGeneration({
    owner: subject.owner,
    requestKey,
    ifMatch: subject.deviceEtag ?? '*',
    body: {},
  });
  subject.deviceEtag = response.etag;
  subject.generationId = response.body.generationId;
  return response.body;
}

async function edge(from, to, state, requestKey = key(from, `edge-${to.label}`)) {
  const response = await service.setRelationship({
    owner: from.owner,
    requestKey,
    ifMatch: from.edges.get(to.accountId) ?? '*',
    otherAccountId: to.accountId,
    body: { state },
  });
  from.edges.set(to.accountId, response.etag);
  return response.body;
}

async function locate(subject, sequence, {
  latitude = 0,
  longitude = 0,
  ttlSeconds = 60,
  requestKey = key(subject, 'location'),
} = {}) {
  return service.updateLocation({
    owner: subject.owner,
    requestKey,
    ifMatch: subject.deviceEtag,
    body: { sequence, latitude, longitude, ttlSeconds },
  });
}

async function session(viewer, {
  latitude = 0,
  longitude = 0,
  radiusMeters = 10_000,
  maxResults = 100,
  requestKey = key(viewer, 'session'),
} = {}) {
  return service.createNearbySession({
    owner: viewer.owner,
    requestKey,
    body: { latitude, longitude, radiusMeters, maxResults },
  });
}

async function visiblePair({ friendLongitude = 0, ttlSeconds = 60 } = {}) {
  const viewer = await register(actor('viewer'));
  const friend = await register(actor('friend'));
  await policy(friend, true);
  await rotate(friend);
  await edge(viewer, friend, 'accepted');
  await edge(friend, viewer, 'accepted');
  const location = await locate(friend, 1, { longitude: friendLongitude, ttlSeconds });
  return { viewer, friend, location };
}

before(async () => {
  pool = new Pool({ connectionString: databaseUrl, max: 32 });
  redis = createClient({ url: redisUrl });
  redis.on('error', () => {});
  await redis.connect();
  await initializeDatabase(pool);
});

beforeEach(async () => {
  await resetDatabase(pool, 'nearby-presence-lab-reset');
  stack();
});

after(async () => {
  if (redis.isOpen) await redis.quit();
  await pool.end();
});

test('real PostGIS joins mutual authorization, freshness, antimeridian distance, and UUID tie order', async () => {
  const viewer = await register(actor('viewer'));
  const friends = [await register(actor('friend-a')), await register(actor('friend-b'))];
  const outsider = await register(actor('outsider'));
  for (const subject of [...friends, outsider]) {
    await policy(subject, true);
    await rotate(subject);
    await locate(subject, 1, { longitude: -179.99 });
  }
  for (const friend of friends) {
    await edge(viewer, friend, 'accepted');
    await edge(friend, viewer, 'accepted');
  }
  const snapshot = await session(viewer, {
    longitude: 179.99,
    radiusMeters: 3_000,
    maxResults: 10,
  });
  assert.deepEqual(
    snapshot.body.items.map((item) => item.accountId),
    friends.map((friend) => friend.accountId).sort(),
  );
  assert.ok(snapshot.body.items.every((item) => (
    item.distanceMillimeters > 2_200_000 && item.distanceMillimeters < 2_230_000
  )));
  assert.equal(snapshot.body.items.some((item) => item.accountId === outsider.accountId), false);
});

test('durable receipts converge concurrent exact retries and reject changed intent', async () => {
  const subject = await register(actor('sharer'));
  await policy(subject, true);
  await rotate(subject);
  const requestKey = 'sharer:location:stable';
  const calls = await Promise.all(Array.from({ length: 16 }, () => locate(subject, 1, {
    latitude: 1,
    longitude: 2,
    requestKey,
  })));
  assert.equal(new Set(calls.map((response) => response.body.locationEpoch)).size, 1);
  assert.equal(calls.filter((response) => response.body.replayed === false).length, 1);
  assert.equal(calls.filter((response) => response.body.replayed === true).length, 15);
  await assert.rejects(
    locate(subject, 1, { latitude: 1, longitude: 2.001, requestKey }),
    (error) => error.status === 409 && error.code === 'intent_conflict',
  );
  const rows = await pool.query(`SELECT
    (SELECT count(*)::int FROM presences) AS presences,
    (SELECT count(*)::int FROM mutation_requests WHERE operation = 'location_update') AS receipts`);
  assert.deepEqual(rows.rows[0], { presences: 1, receipts: 1 });
});

test('device rotation and strict sequence prevent delayed presence resurrection', async () => {
  const subject = await register(actor('sharer'));
  await policy(subject, true);
  await rotate(subject);
  const oldEtag = subject.deviceEtag;
  await locate(subject, 1);
  await assert.rejects(
    locate(subject, 1),
    (error) => error.status === 409 && error.code === 'sequence_conflict' && error.details.expectedSequence === 2,
  );
  await rotate(subject);
  const currentEtag = subject.deviceEtag;
  subject.deviceEtag = oldEtag;
  await assert.rejects(
    locate(subject, 2),
    (error) => error.status === 409 && error.code === 'stale_device_generation',
  );
  subject.deviceEtag = currentEtag;
  const accepted = await locate(subject, 1);
  assert.equal(accepted.body.sequence, 1);
  const rows = await pool.query('SELECT sequence, generation_id FROM presences');
  assert.deepEqual(rows.rows.map((row) => ({
    sequence: Number(row.sequence), generationId: row.generation_id,
  })), [{ sequence: 1, generationId: subject.generationId }]);
});

test('sharing disable commits a refresh, retracts presence, and re-enable cannot resurrect it', async () => {
  const { viewer, friend } = await visiblePair();
  const requestKey = 'viewer:session:privacy-replay';
  const snapshot = await session(viewer, { requestKey });
  assert.equal(snapshot.body.items.length, 1);
  const disabled = await policy(friend, false);
  assert.equal(disabled.sessionEventsCommitted, 1);
  const firstDrain = await service.drainNearbySession({
    owner: viewer.owner,
    sessionId: snapshot.body.sessionId,
    cursor: snapshot.body.eventCursor,
  });
  assert.equal(firstDrain.body.events.length, 1);
  assert.deepEqual(firstDrain.body.items, []);
  const retriedSnapshot = await session(viewer, { requestKey });
  assert.equal(retriedSnapshot.created, false);
  assert.equal(retriedSnapshot.body.replayed, true);
  assert.deepEqual(retriedSnapshot.body.items, []);
  assert.ok(retriedSnapshot.body.viewRevision >= disabled.committedRevision);
  const retryBoundary = await service.drainNearbySession({
    owner: viewer.owner,
    sessionId: snapshot.body.sessionId,
    cursor: retriedSnapshot.body.eventCursor,
  });
  assert.deepEqual(retryBoundary.body.events, []);
  await policy(friend, true);
  const secondDrain = await service.drainNearbySession({
    owner: viewer.owner,
    sessionId: snapshot.body.sessionId,
    cursor: firstDrain.body.eventCursor,
  });
  assert.equal(secondDrain.body.events.length, 1);
  assert.deepEqual(secondDrain.body.items, []);
  const count = await pool.query('SELECT count(*)::int AS count FROM presences');
  assert.equal(count.rows[0].count, 0);
});

test('event retention loss is explicit resync, while the retained edge remains contiguous', async () => {
  stack({ eventRetention: 2 });
  const { viewer, friend } = await visiblePair();
  const snapshot = await session(viewer);
  await locate(friend, 2, { longitude: 0.001 });
  await locate(friend, 3, { longitude: 0.002 });
  await locate(friend, 4, { longitude: 0.003 });
  await assert.rejects(
    service.drainNearbySession({
      owner: viewer.owner,
      sessionId: snapshot.body.sessionId,
      cursor: snapshot.body.eventCursor,
    }),
    (error) => error.status === 409 && error.code === 'resync_required',
  );
  const retainedCursor = encodeCursor({
    owner: viewer.owner,
    session: snapshot.body.sessionId,
    after: 1,
  }, cursorSecret);
  const drained = await service.drainNearbySession({
    owner: viewer.owner,
    sessionId: snapshot.body.sessionId,
    cursor: retainedCursor,
  });
  assert.deepEqual(drained.body.events.map((event) => event.sequence), [2, 3]);
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM nearby_session_events) AS events,
    (SELECT count(*)::int FROM wake_outbox) AS outbox`);
  assert.deepEqual(counts.rows[0], { events: 2, outbox: 2 });
});

test('duplicate and missed Redis hints do not lose the durable cursor view', async () => {
  stack({ outboxLeaseMs: 50 });
  const { viewer, friend } = await visiblePair();
  const snapshot = await session(viewer);
  const channelResult = await pool.query(
    'SELECT wake_channel FROM nearby_sessions WHERE session_id = $1',
    [snapshot.body.sessionId],
  );
  const channel = channelResult.rows[0].wake_channel;
  const subscriber = redis.duplicate();
  subscriber.on('error', () => {});
  await subscriber.connect();
  const messages = [];
  await subscriber.subscribe(channel, (message) => messages.push(message));

  await locate(friend, 2, { longitude: 0.001 });
  const crashWindowWorker = new WakeWorker({
    repository,
    redis,
    afterPublish: async () => { throw new Error('synthetic crash window'); },
  });
  await assert.rejects(crashWindowWorker.runOne(), /synthetic crash window/);
  const retry = await new WakeWorker({ repository, redis }).runOne();
  assert.equal(retry.publishAttempts, 2);
  await delay(20);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(JSON.parse), [
    { version: 1, upperSequence: 1 },
    { version: 1, upperSequence: 1 },
  ]);
  assert.ok(messages.every((message) => !message.includes(snapshot.body.sessionId)));

  await subscriber.unsubscribe(channel);
  await subscriber.quit();
  const latest = await locate(friend, 3, { longitude: 0.002 });
  const noSubscriber = await new WakeWorker({ repository, redis }).runOne();
  assert.equal(noSubscriber.subscriberCount, 0);
  const drained = await service.drainNearbySession({
    owner: viewer.owner,
    sessionId: snapshot.body.sessionId,
    cursor: snapshot.body.eventCursor,
  });
  assert.deepEqual(drained.body.events.map((event) => event.sequence), [1, 2]);
  assert.equal(drained.body.items[0].locationEpoch, latest.body.locationEpoch);
  assert.equal(drained.body.items[0].longitude, 0.002);
});

test('fanout limit aborts location state, receipt, events, and outbox atomically', async () => {
  stack({ fanoutLimit: 2 });
  const { viewer, friend } = await visiblePair();
  await session(viewer);
  await session(viewer);
  await session(viewer);
  await assert.rejects(
    locate(friend, 2, { longitude: 0.001 }),
    (error) => error.status === 503 && error.code === 'fanout_limit_exceeded',
  );
  const state = await pool.query(`SELECT
    (SELECT sequence::int FROM presences WHERE account_id = $1) AS sequence,
    (SELECT last_sequence::int FROM device_generations WHERE account_id = $1) AS last_sequence,
    (SELECT count(*)::int FROM mutation_requests WHERE operation = 'location_update') AS receipts,
    (SELECT count(*)::int FROM nearby_session_events) AS events,
    (SELECT count(*)::int FROM wake_outbox) AS outbox`, [friend.accountId]);
  assert.deepEqual(state.rows[0], {
    sequence: 1, last_sequence: 1, receipts: 1, events: 0, outbox: 0,
  });
});

test('dense exact authorized results fail visibly instead of returning a silent partial list', async () => {
  const viewer = await register(actor('viewer'));
  for (const label of ['friend-a', 'friend-b']) {
    const friend = await register(actor(label));
    await policy(friend, true);
    await rotate(friend);
    await edge(viewer, friend, 'accepted');
    await edge(friend, viewer, 'accepted');
    await locate(friend, 1);
  }
  await assert.rejects(
    session(viewer, { maxResults: 1 }),
    (error) => error.status === 422 && error.code === 'density_limit_exceeded',
  );
  const count = await pool.query('SELECT count(*)::int AS count FROM nearby_sessions');
  assert.equal(count.rows[0].count, 0);
});

test('database-time expiry is enforced at read without a cleanup notification', async () => {
  const { viewer } = await visiblePair({ ttlSeconds: 1 });
  const snapshot = await session(viewer);
  assert.equal(snapshot.body.items.length, 1);
  await delay(1_100);
  const drained = await service.drainNearbySession({
    owner: viewer.owner,
    sessionId: snapshot.body.sessionId,
    cursor: snapshot.body.eventCursor,
  });
  assert.deepEqual(drained.body.events, []);
  assert.deepEqual(drained.body.items, []);
});

test('concurrent revoke and drain produce either a pre-cutover or post-cutover coherent view', async () => {
  const { viewer, friend } = await visiblePair();
  const snapshot = await session(viewer);
  const [drainResult, revokeResult] = await Promise.all([
    service.drainNearbySession({
      owner: viewer.owner,
      sessionId: snapshot.body.sessionId,
      cursor: snapshot.body.eventCursor,
    }),
    edge(viewer, friend, 'revoked'),
  ]);
  const revokeRevision = revokeResult.committedRevision;
  if (drainResult.body.items.length === 1) {
    assert.ok(drainResult.body.viewRevision < revokeRevision);
    assert.deepEqual(drainResult.body.events, []);
  } else {
    assert.deepEqual(drainResult.body.items, []);
    assert.ok(drainResult.body.viewRevision >= revokeRevision);
    assert.ok(drainResult.body.events.some((event) => event.committedRevision === revokeRevision));
  }
});
