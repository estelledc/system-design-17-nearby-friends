import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeCursor } from '../../src/crypto.js';
import { NearbyService } from '../../src/service.js';

const owner = 'a'.repeat(64);
const other = '22222222-2222-4222-8222-222222222222';
const accountVersion = '33333333-3333-4333-8333-333333333333';
const policyVersion = '44444444-4444-4444-8444-444444444444';
const generation = '55555555-5555-4555-8555-555555555555';
const relationshipVersion = '66666666-6666-4666-8666-666666666666';
const session = '77777777-7777-4777-8777-777777777777';
const cursorSecret = 'cursor-secret-that-is-at-least-32-bytes';
const wakeChannelSecret = 'wake-secret-that-is-at-least-32-bytes';

function service(repository) {
  return new NearbyService(repository, {
    cursorSecret,
    wakeChannelSecret,
    uuid: () => session,
  });
}

test('account response exposes separate account and initial policy versions', async () => {
  let captured;
  const result = await service({
    async createAccount(input) {
      captured = input;
      return {
        operation: 'account_create', outcome: 'applied', status: 201, revision: 1,
        result: {
          accountId: other,
          accountVersionId: accountVersion,
          policyVersionId: policyVersion,
          policyVersionNumber: 1,
          policyEnabled: false,
          committedRevision: 1,
        },
        replayed: false,
      };
    },
  }).createAccount({ owner, requestKey: 'account-001', body: {} });
  assert.equal(captured.owner, owner);
  assert.match(captured.digest, /^[0-9a-f]{64}$/);
  assert.equal(result.created, true);
  assert.equal(result.etag, `"ac:${accountVersion}"`);
  assert.equal(result.body.policy.etag, `"sp:${policyVersion}"`);
});

test('relationship write binds target, base version, body, owner, and key', async () => {
  let captured;
  const result = await service({
    async setRelationship(input) {
      captured = input;
      return {
        operation: 'relationship_set', outcome: 'applied', status: 200, revision: 4,
        result: {
          otherAccountId: other,
          state: 'accepted',
          versionId: relationshipVersion,
          versionNumber: 1,
          committedRevision: 4,
          sessionEventsCommitted: 0,
        },
        replayed: false,
      };
    },
  }).setRelationship({
    owner,
    requestKey: 'relationship-001',
    ifMatch: '*',
    otherAccountId: other,
    body: { state: 'accepted' },
  });
  assert.deepEqual({
    owner: captured.owner,
    requestKey: captured.requestKey,
    otherAccountId: captured.otherAccountId,
    baseVersion: captured.baseVersion,
    state: captured.state,
  }, {
    owner,
    requestKey: 'relationship-001',
    otherAccountId: other,
    baseVersion: '*',
    state: 'accepted',
  });
  assert.equal(result.etag, `"re:${relationshipVersion}"`);
});

test('stored precondition failures preserve status and return the current strong ETag', async () => {
  await assert.rejects(
    service({
      async setSharingPolicy() {
        return {
          operation: 'policy_set', outcome: 'precondition_failed', status: 412, revision: null,
          result: {
            code: 'precondition_failed',
            message: 'the supplied sharing-policy version is stale',
            currentVersionId: policyVersion,
          },
          replayed: true,
        };
      },
    }).setSharingPolicy({
      owner,
      requestKey: 'policy-001',
      ifMatch: `"sp:${policyVersion}"`,
      body: { enabled: true },
    }),
    (error) => error.status === 412 && error.details.etag === `"sp:${policyVersion}"`,
  );
});

test('nearby snapshot and drain use an opaque owner-bound cursor and replace-whole view', async () => {
  let createInput;
  let drainInput;
  const now = new Date('2026-08-19T00:00:00.000Z');
  const repository = {
    async createNearbySession(input) {
      createInput = input;
      return {
        session: {
          sessionId: session,
          initialRevision: 9,
          lastEventSequence: 0,
          radiusMeters: 8_000,
          maxResults: 10,
          expiresAt: new Date(now.getTime() + 60_000),
          replayed: false,
        },
        viewRevision: 9,
        items: [{
          accountId: other,
          locationEpoch: accountVersion,
          latitude: 0,
          longitude: 179.99,
          distanceMillimeters: 1000,
          acceptedAt: now,
          expiresAt: new Date(now.getTime() + 30_000),
        }],
      };
    },
    async drainNearbySession(input) {
      drainInput = input;
      return {
        viewRevision: 10,
        cursorSequence: 1,
        events: [{
          sequence: 1,
          committedRevision: 10,
          type: 'refresh_required',
          createdAt: now,
        }],
        items: [],
        refreshBy: new Date(now.getTime() + 60_000),
      };
    },
  };
  const nearby = service(repository);
  const snapshot = await nearby.createNearbySession({
    owner,
    requestKey: 'session-001',
    body: { latitude: 0, longitude: 180, radiusMeters: 8_000, maxResults: 10 },
  });
  assert.equal(createInput.query.longitude, -180);
  assert.equal(createInput.channel.includes(session), false);
  assert.deepEqual(decodeCursor(snapshot.body.eventCursor, owner, cursorSecret), {
    session,
    after: 0,
  });
  const drained = await nearby.drainNearbySession({
    owner,
    sessionId: session,
    cursor: snapshot.body.eventCursor,
  });
  assert.deepEqual(drainInput, { owner, sessionId: session, after: 0 });
  assert.equal(drained.body.replaceWholeView, true);
  assert.deepEqual(decodeCursor(drained.body.eventCursor, owner, cursorSecret), {
    session,
    after: 1,
  });
});

test('location conflicts keep strict device sequence details without becoming an ETag mismatch', async () => {
  await assert.rejects(
    service({
      async updateLocation() {
        return {
          operation: 'location_update', outcome: 'precondition_failed', status: 409, revision: null,
          result: {
            code: 'sequence_conflict',
            message: 'location sequence must be exactly the next device sequence',
            expectedSequence: 2,
          },
          replayed: false,
        };
      },
    }).updateLocation({
      owner,
      requestKey: 'location-002',
      ifMatch: `"dg:${generation}"`,
      body: { sequence: 1, latitude: 1, longitude: 2, ttlSeconds: 60 },
    }),
    (error) => error.status === 409 && error.code === 'sequence_conflict' && error.details.expectedSequence === 2,
  );
});
