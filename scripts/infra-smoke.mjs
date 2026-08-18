import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as scheduleTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import { ownerFingerprint } from '../src/crypto.js';
import { initializeDatabase, resetDatabase } from '../src/repository.js';

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
assert.ok(databaseUrl, 'DATABASE_URL is required for the infrastructure smoke');
assert.ok(redisUrl, 'REDIS_URL is required for the infrastructure smoke');

const authSecret = 'smoke-auth-secret-that-is-at-least-32-bytes';
const cursorSecret = 'smoke-cursor-secret-that-is-at-least-32-bytes';
const wakeSecret = 'smoke-wake-secret-that-is-at-least-32-bytes';
const viewerToken = 'smoke-viewer-token-00000001';
const friendToken = 'smoke-friend-token-00000001';

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  const deadline = new Promise((resolve, reject) => {
    timeout = scheduleTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function captureChild(args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, stdout: () => stdout, stderr: () => stderr };
}

async function waitForExit(record, timeoutMs = 10_000) {
  return withTimeout(once(record.child, 'exit'), timeoutMs, 'child process exit timed out');
}

async function startApi({ crash = false } = {}) {
  const record = captureChild(['src/main.js', 'serve'], {
    AUTH_FINGERPRINT_SECRET: authSecret,
    CRASH_AFTER_LOCATION_COMMIT: crash ? '1' : '0',
    CURSOR_SECRET: cursorSecret,
    DATABASE_URL: databaseUrl,
    PORT: '0',
    WAKE_CHANNEL_SECRET: wakeSecret,
  });
  const port = await withTimeout(new Promise((resolve, reject) => {
    const inspect = (chunk) => {
      for (const line of chunk.split('\n')) {
        if (!line.includes('server_ready')) continue;
        resolve(JSON.parse(line).port);
      }
    };
    record.child.stdout.on('data', inspect);
    record.child.once('exit', (code, signal) => {
      reject(new Error(`API exited before readiness: code=${code} signal=${signal}`));
    });
  }), 10_000, 'API readiness timed out');
  return { ...record, origin: `http://127.0.0.1:${port}` };
}

async function stopApi(record) {
  const exit = waitForExit(record);
  record.child.kill('SIGTERM');
  const [code, signal] = await exit;
  assert.equal(code, 0);
  assert.equal(signal, null);
}

async function runWorker({ crash = false } = {}) {
  const record = captureChild(['src/worker-main.js', 'once'], {
    CRASH_AFTER_WAKE_PUBLISH: crash ? '1' : '0',
    DATABASE_URL: databaseUrl,
    OUTBOX_LEASE_MS: '250',
    REDIS_URL: redisUrl,
  });
  const [code, signal] = await waitForExit(record);
  return { ...record, code, signal };
}

async function request(api, token, method, path, {
  body,
  key,
  ifMatch,
  expected = 200,
} = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (key) headers['idempotency-key'] = key;
  if (ifMatch) headers['if-match'] = ifMatch;
  const response = await fetch(`${api.origin}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected);
  return {
    body: await response.json(),
    etag: response.headers.get('etag'),
  };
}

const pool = new Pool({ connectionString: databaseUrl, max: 12 });
const redis = createClient({ url: redisUrl });
redis.on('error', () => {});
await redis.connect();
await initializeDatabase(pool);
await resetDatabase(pool, 'nearby-presence-lab-reset');
const postgresVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
const postgisVersion = (await pool.query('SELECT postgis_lib_version() AS version')).rows[0].version;
const redisInfo = await redis.info('server');
const redisVersion = /^redis_version:(.+)$/m.exec(redisInfo)?.[1]?.trim();
assert.ok(redisVersion);

const logs = [];
let api = await startApi();

const viewer = await request(api, viewerToken, 'POST', '/v1/accounts', {
  body: {}, key: 'smoke-viewer-account-001', expected: 201,
});
const friend = await request(api, friendToken, 'POST', '/v1/accounts', {
  body: {}, key: 'smoke-friend-account-001', expected: 201,
});
const policy = await request(api, friendToken, 'PUT', '/v1/sharing-policy', {
  body: { enabled: true },
  key: 'smoke-friend-policy-001',
  ifMatch: friend.body.policy.etag,
});
const device = await request(api, friendToken, 'POST', '/v1/device-generations', {
  body: {}, key: 'smoke-friend-device-001', ifMatch: '*',
});
await request(
  api,
  viewerToken,
  'PUT',
  `/v1/relationships/${friend.body.accountId}`,
  { body: { state: 'accepted' }, key: 'smoke-viewer-edge-001', ifMatch: '*' },
);
await request(
  api,
  friendToken,
  'PUT',
  `/v1/relationships/${viewer.body.accountId}`,
  { body: { state: 'accepted' }, key: 'smoke-friend-edge-001', ifMatch: '*' },
);
await request(api, friendToken, 'PUT', '/v1/location', {
  body: { sequence: 1, latitude: 0, longitude: 179.99, ttlSeconds: 120 },
  key: 'smoke-friend-location-001',
  ifMatch: device.etag,
});
const snapshot = await request(api, viewerToken, 'POST', '/v1/nearby-sessions', {
  body: { latitude: 0, longitude: -179.99, radiusMeters: 3_000, maxResults: 10 },
  key: 'smoke-viewer-session-001',
  expected: 201,
});
assert.equal(snapshot.body.items.length, 1);
logs.push(api.stdout(), api.stderr());
await stopApi(api);

api = await startApi({ crash: true });
const lostResponse = fetch(`${api.origin}/v1/location`, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${friendToken}`,
    'content-type': 'application/json',
    'idempotency-key': 'smoke-friend-location-002',
    'if-match': device.etag,
  },
  body: JSON.stringify({ sequence: 2, latitude: 0, longitude: 179.98, ttlSeconds: 120 }),
});
await assert.rejects(lostResponse);
const [crashCode, crashSignal] = await waitForExit(api);
assert.equal(crashCode, null);
assert.equal(crashSignal, 'SIGKILL');
logs.push(api.stdout(), api.stderr());

api = await startApi();
const replay = await request(api, friendToken, 'PUT', '/v1/location', {
  body: { sequence: 2, latitude: 0, longitude: 179.98, ttlSeconds: 120 },
  key: 'smoke-friend-location-002',
  ifMatch: device.etag,
});
assert.equal(replay.body.replayed, true);
assert.equal(replay.body.sequence, 2);

const channelResult = await pool.query(
  'SELECT wake_channel FROM nearby_sessions WHERE session_id = $1',
  [snapshot.body.sessionId],
);
const wakeChannel = channelResult.rows[0].wake_channel;
const subscriber = redis.duplicate();
subscriber.on('error', () => {});
await subscriber.connect();
const messages = [];
await subscriber.subscribe(wakeChannel, (message) => messages.push(message));
const crashedWorker = await runWorker({ crash: true });
assert.equal(crashedWorker.code, null);
assert.equal(crashedWorker.signal, 'SIGKILL');
logs.push(crashedWorker.stdout(), crashedWorker.stderr());
await delay(300);
const recoveredWorker = await runWorker();
assert.equal(recoveredWorker.code, 0);
assert.equal(recoveredWorker.signal, null);
logs.push(recoveredWorker.stdout(), recoveredWorker.stderr());
await delay(20);
assert.deepEqual(messages.map(JSON.parse), [
  { version: 1, upperSequence: 1 },
  { version: 1, upperSequence: 1 },
]);
await subscriber.unsubscribe(wakeChannel);
await subscriber.quit();

await request(api, friendToken, 'PUT', '/v1/sharing-policy', {
  body: { enabled: false },
  key: 'smoke-friend-policy-002',
  ifMatch: policy.etag,
});
const missedWorker = await runWorker();
assert.equal(missedWorker.code, 0);
assert.match(missedWorker.stdout(), /"subscriberCount":0/);
logs.push(missedWorker.stdout(), missedWorker.stderr());

const path = `/v1/nearby-sessions/${snapshot.body.sessionId}/events?cursor=${encodeURIComponent(snapshot.body.eventCursor)}`;
const drained = await request(api, viewerToken, 'GET', path);
assert.deepEqual(drained.body.events.map((event) => event.sequence), [1, 2]);
assert.deepEqual(drained.body.items, []);
const replayedDrain = await request(api, viewerToken, 'GET', path);
assert.deepEqual(replayedDrain.body, drained.body);
logs.push(api.stdout(), api.stderr());
await stopApi(api);

const state = await pool.query(`SELECT
  (SELECT committed_revision::int FROM system_state WHERE singleton) AS revision,
  (SELECT count(*)::int FROM accounts) AS accounts,
  (SELECT count(*)::int FROM relationship_edges) AS edges,
  (SELECT count(*)::int FROM presences) AS presences,
  (SELECT count(*)::int FROM nearby_sessions) AS sessions,
  (SELECT count(*)::int FROM nearby_session_events) AS events,
  (SELECT count(*)::int FROM wake_outbox WHERE state = 'sent') AS sent_wakes,
  (SELECT max(publish_attempts)::int FROM wake_outbox) AS max_publish_attempts`);
assert.deepEqual(state.rows[0], {
  revision: 9,
  accounts: 2,
  edges: 2,
  presences: 0,
  sessions: 1,
  events: 2,
  sent_wakes: 2,
  max_publish_attempts: 2,
});

const combinedLogs = logs.join('\n');
const privateValues = [
  viewerToken,
  friendToken,
  viewer.body.accountId,
  friend.body.accountId,
  snapshot.body.sessionId,
  wakeChannel,
  ownerFingerprint(viewerToken, authSecret),
  ownerFingerprint(friendToken, authSecret),
  'smoke-friend-location-002',
  '179.98',
  '-179.99',
];
for (const value of privateValues) {
  assert.equal(combinedLogs.includes(value), false, 'ordinary process logs leaked a synthetic private value');
}
for (const forbiddenClaim of [
  'device_received',
  'device_applied',
  'map_rendered',
  'physical_copresence',
  'meeting_confirmed',
  'safety_confirmed',
  'consent_validated',
  'external_acceptance',
]) {
  assert.equal(combinedLogs.includes(forbiddenClaim), false);
}

await redis.quit();
await pool.end();
process.stdout.write(`${JSON.stringify({
  evidence: 'true_process_recovery_smoke',
  runtime: process.version,
  postgresVersion,
  postgisVersion,
  redisVersion,
  locationResponseLossRecovered: true,
  duplicateWakeObserved: true,
  missedWakeRecoveredByCursor: true,
  finalState: state.rows[0],
  externalOutcomeClaims: 0,
})}\n`);
