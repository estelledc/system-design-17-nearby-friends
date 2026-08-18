import { invalid } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ETAG_PREFIXES = new Set(['ac', 're', 'sp', 'dg']);

function record(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be a JSON object`);
  }
  return value;
}

function exactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || unknown.length) {
    throw invalid('request fields do not match the documented contract');
  }
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${label} must be a finite JSON number`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function canonicalLatitude(value) {
  const latitude = finiteNumber(value, 'latitude');
  if (latitude < -90 || latitude > 90) throw invalid('latitude must be between -90 and 90');
  return latitude;
}

export function canonicalLongitude(value) {
  const longitude = finiteNumber(value, 'longitude');
  if (longitude < -180 || longitude > 180) throw invalid('longitude must be between -180 and 180');
  return longitude === 180 ? -180 : longitude;
}

export function parseUuid(value, label = 'resource ID') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalid(`${label} must be a canonical UUID`);
  }
  return value;
}

export function parseRequestKey(value) {
  if (typeof value !== 'string' || !REQUEST_KEY.test(value)) {
    throw invalid('Idempotency-Key must be 1-128 portable ASCII characters');
  }
  return value;
}

export function parseEmptyBody(value) {
  const body = record(value, 'request body');
  exactKeys(body, []);
  return body;
}

export function parseRelationship(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['state']);
  if (!['accepted', 'revoked', 'blocked'].includes(body.state)) {
    throw invalid('relationship state must be accepted, revoked, or blocked');
  }
  return { state: body.state };
}

export function parsePolicy(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['enabled']);
  if (typeof body.enabled !== 'boolean') throw invalid('enabled must be a JSON boolean');
  return { enabled: body.enabled };
}

export function parseLocation(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['sequence', 'latitude', 'longitude', 'ttlSeconds']);
  return {
    sequence: boundedInteger(body.sequence, 'sequence', 1, Number.MAX_SAFE_INTEGER),
    latitude: canonicalLatitude(body.latitude),
    longitude: canonicalLongitude(body.longitude),
    ttlSeconds: boundedInteger(body.ttlSeconds, 'ttlSeconds', 1, 600),
  };
}

export function parseNearbySession(value) {
  const body = record(value, 'request body');
  exactKeys(body, ['latitude', 'longitude', 'radiusMeters', 'maxResults']);
  return {
    latitude: canonicalLatitude(body.latitude),
    longitude: canonicalLongitude(body.longitude),
    radiusMeters: boundedInteger(body.radiusMeters, 'radiusMeters', 1, 50_000),
    maxResults: boundedInteger(body.maxResults, 'maxResults', 1, 100),
  };
}

export function formatEtag(prefix, versionId) {
  if (!ETAG_PREFIXES.has(prefix)) throw new Error('unsupported ETag prefix');
  return `\"${prefix}:${parseUuid(versionId, 'version ID')}\"`;
}

export function parseIfMatch(value, prefix, { allowStar = false } = {}) {
  if (!ETAG_PREFIXES.has(prefix)) throw new Error('unsupported ETag prefix');
  if (allowStar && value === '*') return '*';
  if (typeof value !== 'string' || value.includes(',')) {
    throw invalid(`If-Match must contain exactly one strong ${prefix} ETag`);
  }
  const match = new RegExp(`^\\"${prefix}:([0-9a-f-]{36})\\"$`).exec(value);
  if (!match) throw invalid(`If-Match must contain exactly one strong ${prefix} ETag`);
  return parseUuid(match[1], 'If-Match version');
}

export const limits = Object.freeze({
  bodyBytes: 16_384,
  cursorChars: 1_024,
  eventRetention: 32,
  fanoutSessions: 1_000,
  sessionTtlMs: 30 * 60 * 1_000,
  outboxLeaseMs: 5_000,
  workerBatch: 100,
});
