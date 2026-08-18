import assert from 'node:assert/strict';
import test from 'node:test';
import { WakeWorker } from '../../src/wake-worker.js';

const claim = {
  outboxId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  sequence: 7,
  channel: 'nearby:wake:opaque-channel-value-that-is-long-enough',
  claimToken: '33333333-3333-4333-8333-333333333333',
};

test('worker publishes only a generic upper-sequence hint and records broker-local evidence', async () => {
  let payload;
  let marked;
  const logs = [];
  const result = await new WakeWorker({
    repository: {
      async claimWake() { return claim; },
      async markWakeSent(input) { marked = input; return { publishAttempts: 1 }; },
      async releaseWake() { assert.fail('successful work must not release'); },
    },
    redis: {
      async publish(channel, body) {
        assert.equal(channel, claim.channel);
        payload = body;
        return 2;
      },
    },
    logger: (line) => logs.push(line),
  }).runOne();
  assert.deepEqual(JSON.parse(payload), { version: 1, upperSequence: 7 });
  assert.equal(payload.includes(claim.sessionId), false);
  assert.equal(payload.includes('latitude'), false);
  assert.equal(marked, claim);
  assert.deepEqual(result, {
    kind: 'published', sequence: 7, subscriberCount: 2, publishAttempts: 1,
  });
  assert.equal(logs.join('\n').includes(claim.channel), false);
  assert.match(logs[0], /redis_wake_published/);
});

test('controlled publish failures release the claim for retry', async () => {
  let released;
  const worker = new WakeWorker({
    repository: {
      async claimWake() { return claim; },
      async markWakeSent() { assert.fail('failed publish must not mark sent'); },
      async releaseWake(input) { released = input; },
    },
    redis: { async publish() { throw new Error('synthetic Redis failure'); } },
  });
  await assert.rejects(worker.runOne(), /synthetic Redis failure/);
  assert.equal(released, claim);
});

test('batch stops at idle without inventing delivery work', async () => {
  let claims = 0;
  const result = await new WakeWorker({
    repository: {
      async claimWake() { claims += 1; return null; },
    },
    redis: {},
  }).runBatch(10);
  assert.deepEqual(result, []);
  assert.equal(claims, 1);
});
