import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ownerFingerprint } from '../../src/crypto.js';
import { AppError } from '../../src/errors.js';
import { closeServer, createHttpServer, listen } from '../../src/http.js';

const authSecret = 'auth-secret-that-is-at-least-32-bytes';
const authToken = 'synthetic-auth-token-001';
const accountId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const logs = [];
let server;
let origin;
let captured;

const service = {
  async createAccount(input) {
    captured = input;
    return {
      created: true,
      etag: '"ac:33333333-3333-4333-8333-333333333333"',
      body: { accountId, replayed: false },
    };
  },
  async setRelationship() {
    throw new AppError('precondition_failed', 412, 'relationship version is stale', {
      currentVersionId: '44444444-4444-4444-8444-444444444444',
      etag: '"re:44444444-4444-4444-8444-444444444444"',
    });
  },
  async drainNearbySession(input) {
    captured = input;
    return { body: { sessionId, events: [], items: [], eventCursor: 'next' } };
  },
};

before(async () => {
  server = createHttpServer({ service, authSecret, logger: (line) => logs.push(line) });
  ({ origin } = await listen(server));
});

after(async () => {
  await closeServer(server);
});

test('health is bounded, private, and does not require authentication', async () => {
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('account route fingerprints bearer auth and never passes or logs the token', async () => {
  const response = await fetch(`${origin}/v1/accounts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
      'idempotency-key': 'account-001',
    },
    body: '{}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('etag'), '"ac:33333333-3333-4333-8333-333333333333"');
  assert.equal(captured.owner, ownerFingerprint(authToken, authSecret));
  assert.equal(captured.requestKey, 'account-001');
  assert.equal(logs.join('\n').includes(authToken), false);
  assert.equal(logs.join('\n').includes(captured.owner), false);
});

test('event drain accepts exactly one cursor and forwards no request identity to logs', async () => {
  const response = await fetch(`${origin}/v1/nearby-sessions/${sessionId}/events?cursor=opaque-token`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  assert.equal(response.status, 200);
  assert.equal(captured.sessionId, sessionId);
  assert.equal(captured.cursor, 'opaque-token');
  const invalid = await fetch(`${origin}/v1/nearby-sessions/${sessionId}/events?cursor=a&extra=b`, {
    headers: { authorization: `Bearer ${authToken}` },
  });
  assert.equal(invalid.status, 400);
  assert.equal(logs.join('\n').includes('opaque-token'), false);
});

test('stored precondition error returns current ETag and bounded details', async () => {
  const other = '55555555-5555-4555-8555-555555555555';
  const response = await fetch(`${origin}/v1/relationships/${other}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
      'idempotency-key': 'relationship-001',
      'if-match': '*',
    },
    body: JSON.stringify({ state: 'accepted' }),
  });
  assert.equal(response.status, 412);
  assert.equal(response.headers.get('etag'), '"re:44444444-4444-4444-8444-444444444444"');
  const body = await response.json();
  assert.equal(body.error.code, 'precondition_failed');
  assert.equal(Object.hasOwn(body.error.details, 'etag'), false);
});

test('missing bearer and oversized declared bodies fail before service work', async () => {
  const missing = await fetch(`${origin}/v1/accounts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(missing.status, 401);
  const oversized = await fetch(`${origin}/v1/accounts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ value: 'x'.repeat(17_000) }),
  });
  assert.equal(oversized.status, 400);
});
