import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCursor,
  encodeCursor,
  intentDigest,
  ownerFingerprint,
  stableJson,
  wakeChannel,
} from '../../src/crypto.js';

const owner = 'a'.repeat(64);
const session = '11111111-1111-4111-8111-111111111111';
const secret = 'cursor-secret-that-is-at-least-32-bytes';

test('stable JSON makes key order irrelevant but binds intent changes', () => {
  assert.equal(stableJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(intentDigest({ b: 2, a: 1 }), intentDigest({ a: 1, b: 2 }));
  assert.notEqual(intentDigest({ a: 1 }), intentDigest({ a: 2 }));
});

test('owner fingerprints and wake channels are deterministic opaque HMAC values', () => {
  const token = 'synthetic-auth-token-001';
  const fingerprint = ownerFingerprint(token, 'auth-secret-that-is-at-least-32-bytes');
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint.includes(token), false);
  const channel = wakeChannel(session, 'wake-secret-that-is-at-least-32-bytes');
  assert.match(channel, /^nearby:wake:[A-Za-z0-9_-]{43}$/);
  assert.equal(channel.includes(session), false);
  assert.equal(channel, wakeChannel(session, 'wake-secret-that-is-at-least-32-bytes'));
});

test('cursor round-trips owner, session, and sequence and rejects tampering or cross-owner use', () => {
  const token = encodeCursor({ owner, session, after: 7 }, secret);
  assert.deepEqual(decodeCursor(token, owner, secret), { session, after: 7 });
  const replacement = token.endsWith('A') ? 'B' : 'A';
  assert.throws(() => decodeCursor(`${token.slice(0, -1)}${replacement}`, owner, secret), /cursor/);
  assert.throws(() => decodeCursor(token, 'b'.repeat(64), secret), /cursor/);
  assert.throws(() => decodeCursor(token, owner, `${secret}-different`), /cursor/);
});
