import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalLatitude,
  canonicalLongitude,
  formatEtag,
  parseIfMatch,
  parseLocation,
  parseNearbySession,
  parseRequestKey,
  parseUuid,
} from '../../src/contracts.js';

const id = '11111111-1111-4111-8111-111111111111';

test('coordinates use a finite named domain and one antimeridian representation', () => {
  assert.equal(canonicalLatitude(-0), 0);
  assert.equal(canonicalLongitude(180), -180);
  assert.equal(canonicalLongitude(-180), -180);
  for (const value of [NaN, Infinity, -Infinity, 90.0001]) {
    assert.throws(() => canonicalLatitude(value), /latitude/);
  }
  assert.throws(() => canonicalLongitude(180.0001), /longitude/);
});

test('location and nearby contracts reject unknown, fractional, and out-of-bound fields', () => {
  assert.deepEqual(parseLocation({
    sequence: 1, latitude: 10, longitude: 20, ttlSeconds: 60,
  }), { sequence: 1, latitude: 10, longitude: 20, ttlSeconds: 60 });
  assert.throws(() => parseLocation({
    sequence: 1.5, latitude: 10, longitude: 20, ttlSeconds: 60,
  }), /sequence/);
  assert.throws(() => parseLocation({
    sequence: 1, latitude: 10, longitude: 20, ttlSeconds: 601,
  }), /ttlSeconds/);
  assert.throws(() => parseNearbySession({
    latitude: 0, longitude: 0, radiusMeters: 50_001, maxResults: 1,
  }), /radiusMeters/);
  assert.throws(() => parseNearbySession({
    latitude: 0, longitude: 0, radiusMeters: 100, maxResults: 1, unit: 'km',
  }), /fields/);
});

test('identifiers and strong ETags are canonical and single-valued', () => {
  assert.equal(parseUuid(id), id);
  assert.equal(parseRequestKey('update:device-01'), 'update:device-01');
  assert.equal(formatEtag('dg', id), `"dg:${id}"`);
  assert.equal(parseIfMatch(`"dg:${id}"`, 'dg'), id);
  assert.equal(parseIfMatch('*', 'dg', { allowStar: true }), '*');
  assert.throws(() => parseIfMatch('*', 'dg'), /If-Match/);
  assert.throws(() => parseIfMatch(`W/"dg:${id}"`, 'dg'), /If-Match/);
  assert.throws(() => parseIfMatch(`"dg:${id}", "dg:${id}"`, 'dg'), /exactly one/);
  assert.throws(() => parseRequestKey('contains space'), /Idempotency-Key/);
});
